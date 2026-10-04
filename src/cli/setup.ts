// `somora setup` — the guided first-run assistant.
//
// Walks a person from "somora is installed" to "my agent answers, on my
// phone too": model providers and logins, the first agent, memory and
// the dream phases, the team file, HTTPS through Tailscale, and a real
// test message at the end. Every step looks at what is already there
// first, so it is safe to run again at any time — alone
// (`somora setup access`) or as a whole.
//
// It only ever edits config.yaml / agent.yaml through
// src/setup/config-edit.ts: comments survive, the old file is kept as a
// backup, and a result the server would refuse is never written.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces, userInfo } from 'node:os';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';

import { listAgents } from '../persona/loader.ts';
import { teamFilePath } from '../team/store.ts';
import { initialTeamFile, writeTeamFile } from '../team/write.ts';
import {
  BASE_CONFIG, commit, configuredAliases, deleteIn, getIn, openYaml, setIn, upsertProvider, type YamlFile,
} from '../setup/config-edit.ts';
import { aliasFor, CLAUDE_PRESET, CODEX_PRESET, pickPreferred, type ModelPreset } from '../setup/presets.ts';
import {
  bold, capture, cyan, dim, explain, fail, heading, ok, onPath, Prompter, say, warn, type Choice,
} from '../setup/prompt.ts';
import { isOperatorError, tailscaleState } from '../setup/tailscale.ts';
import { SOMORA_VERSION } from '../version.ts';
import { launchdPlistPath } from './launchd.ts';
import { isUtf8Locale, renderBanner } from './banner.ts';

const HOME = homedir();
const SOMORA_HOME = process.env.SOMORA_HOME ?? join(HOME, '.somora');
const CONFIG_PATH = join(SOMORA_HOME, 'config.yaml');
const AGENTS_DIR = join(SOMORA_HOME, 'agents');
const UNIT_PATH = join(HOME, '.config', 'systemd', 'user', 'somora.service');
const BIN_PATH = process.env.SOMORA_BIN_PATH ?? '';

const STEPS = ['models', 'search', 'agent', 'memory', 'team', 'access', 'start'] as const;
type Step = (typeof STEPS)[number];

const STEP_TITLES: Record<Step, string> = {
  models: 'Models — which AI your agents use',
  search: 'Web search',
  agent: 'Your first agent',
  memory: 'Memory and dreaming',
  team: 'Team',
  access: 'Access from your other devices',
  start: 'Start and test',
};

interface Ctx {
  p: Prompter;
  /** Something changed that a running server only sees after a restart. */
  needsRestart: boolean;
  /** Name the person gave for themselves, reused across steps. */
  principal?: string;
}

function usage(): string {
  return `somora setup — the guided assistant (safe to run again at any time)

Usage:
  somora setup            all steps, in order
  somora setup <step>     one step only

Steps:
${STEPS.map((s) => `  ${s.padEnd(8)} ${STEP_TITLES[s]}`).join('\n')}
`;
}

// ─── shared helpers ───────────────────────────────────────────────────

function openConfig(): YamlFile {
  return openYaml(CONFIG_PATH, BASE_CONFIG);
}

/** Files this run already wrote — their state before the run is in the
 *  first backup; a second one per step would only be clutter. */
const written = new Set<string>();

/** Commit and report in one line. Returns true when the file changed. */
function save(file: YamlFile, kind: 'config' | 'plain', what: string): boolean {
  const r = commit(file, kind, new Date(), !written.has(file.path));
  if (!r.changed) return false;
  written.add(file.path);
  ok(`${what} ${dim(`→ ${tildify(file.path)}${r.backup ? ` (previous version kept as ${r.backup.split('/').pop()})` : ''}`)}`);
  return true;
}

function tildify(p: string): string {
  return p.startsWith(`${HOME}/`) ? `~/${p.slice(HOME.length + 1)}` : p;
}

function expandHome(p: string): string {
  return p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p;
}

function somoraSelf(args: string[]): { cmd: string; args: string[] } {
  return BIN_PATH ? { cmd: process.execPath, args: [BIN_PATH, ...args] } : { cmd: 'somora', args };
}

function agentYaml(name: string): YamlFile {
  return openYaml(join(AGENTS_DIR, name, 'agent.yaml'));
}

function serverPort(config: YamlFile): number {
  const port = getIn(config, ['server', 'port']);
  return typeof port === 'number' ? port : 18737;
}

function baseUrl(config: YamlFile): string {
  const tls = getIn(config, ['server', 'tls']) as { publicHost?: string } | undefined;
  const port = serverPort(config);
  return tls?.publicHost ? `https://${tls.publicHost}:${port}` : `http://127.0.0.1:${port}`;
}

/** Talk to the server on this machine. With HTTPS the connection goes
 *  to loopback but is verified against the public name — that works
 *  even where the Tailscale name does not resolve locally. */
function localRequest(config: YamlFile, path: string, opts: { body?: unknown; timeoutMs: number }): Promise<{ status: number; json: Record<string, unknown> }> {
  const tls = getIn(config, ['server', 'tls']) as { publicHost?: string } | undefined;
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  const options = {
    host: '127.0.0.1',
    port: serverPort(config),
    path,
    method: payload ? 'POST' : 'GET',
    headers: {
      ...(tls?.publicHost ? { Host: `${tls.publicHost}:${serverPort(config)}` } : {}),
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
    ...(tls?.publicHost ? { servername: tls.publicHost } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (tls?.publicHost ? httpsRequest : httpRequest)(options, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { text += d; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> });
        } catch {
          reject(new Error(`unexpected answer (HTTP ${res.statusCode})`));
        }
      });
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

async function health(config: YamlFile): Promise<Record<string, unknown> | null> {
  try {
    const r = await localRequest(config, '/health', { timeoutMs: 4000 });
    return r.status === 200 ? r.json : null;
  } catch {
    return null;
  }
}

function serviceAvailable(): boolean {
  if (process.platform === 'darwin') return existsSync(launchdPlistPath());
  return existsSync(UNIT_PATH) && capture('systemctl', ['--user', 'show-environment']).code === 0;
}

const LOG_HINT = process.platform === 'darwin'
  ? `tail -n 50 ${join(SOMORA_HOME, 'logs', 'launchd.log')}`
  : 'journalctl --user -u somora -n 50';

// ─── step: models ─────────────────────────────────────────────────────

/** Put `dir` on the PATH of future shells: one marked line in the
 *  profile files that exist (plus ~/.profile, which login shells read).
 *  Returns the files it changed — none when the directory is already on
 *  PATH or already mentioned in every file. */
export function addToShellPath(dir: string, home: string = HOME, envPath: string = process.env.PATH ?? '', shell: string = process.env.SHELL ?? ''): string[] {
  if (envPath.split(':').includes(dir)) return [];
  const shown = dir.startsWith(`${home}/`) ? `$HOME/${dir.slice(home.length + 1)}` : dir;
  const line = `export PATH="${shown}:$PATH"  # added by somora setup`;
  const files = [join(home, '.profile')];
  for (const f of ['.bashrc', '.bash_profile', '.zprofile']) if (existsSync(join(home, f))) files.push(join(home, f));
  if (existsSync(join(home, '.zshrc')) || shell.endsWith('zsh')) files.push(join(home, '.zshrc'));
  const changed: string[] = [];
  for (const f of files) {
    const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
    if (text.includes(shown) || text.includes(dir)) continue;
    appendFileSync(f, `${text === '' || text.endsWith('\n') ? '' : '\n'}\n${line}\n`);
    changed.push(f);
  }
  return changed;
}

function claudeBinary(): string | null {
  const local = join(HOME, '.local', 'bin', 'claude');
  if (existsSync(local)) return local;
  const r = capture('sh', ['-c', 'command -v claude']);
  return r.code === 0 ? r.stdout.trim() : null;
}

function claudeLoggedIn(): boolean {
  return existsSync(join(HOME, '.claude', '.credentials.json'))
    || existsSync(join(SOMORA_HOME, 'claude-home', '.credentials.json'));
}

function codexLoggedIn(): boolean {
  return existsSync(join(SOMORA_HOME, 'codex-home', 'auth.json'))
    || existsSync(join(process.env.CODEX_HOME ?? join(HOME, '.codex'), 'auth.json'));
}

async function pickModels(p: Prompter, title: string, models: ModelPreset[], have: string[]): Promise<ModelPreset[]> {
  const choices: Array<Choice<ModelPreset>> = models.map((m) => ({
    label: `${m.alias.padEnd(8)} ${dim(m.id)}`,
    value: m,
    hint: have.includes(m.id) ? 'already configured' : m.note,
  }));
  const all = models.map((_, i) => i);
  return await p.chooseMany(title, choices, all);
}

async function setupClaude(ctx: Ctx, config: YamlFile): Promise<void> {
  const { p } = ctx;
  let bin = claudeBinary();
  if (!bin) {
    explain('Claude runs through Anthropic\'s own program, Claude Code. It is not installed yet.');
    if (await p.confirm('Install Claude Code now? (official installer from claude.ai, into ~/.local/bin)')) {
      p.handOver('sh', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
      bin = claudeBinary();
    }
    if (!bin) {
      warn('Claude Code is not installed — skipping Claude. Later: curl -fsSL https://claude.ai/install.sh | bash, then `somora setup models`.');
      return;
    }
    ok(`Claude Code installed at ${tildify(bin)}`);
    // Its installer only prints a hint when ~/.local/bin is not on PATH.
    // somora calls the binary by its full path, but the person will want
    // to type `claude` too.
    const added = addToShellPath(join(HOME, '.local', 'bin'));
    if (added.length) ok(`added ~/.local/bin to your PATH ${dim(`(${added.map(tildify).join(', ')} — active in a new terminal)`)}`);
  }
  if (claudeLoggedIn()) {
    ok('Claude login found');
  } else {
    explain(`Next, Claude Code asks you to log in with your Claude subscription:
      it shows a link — open it in any browser (your laptop or phone is fine),
      approve, and paste the code it gives you back here.`);
    if (await p.confirm('Log in now?')) {
      p.handOver(bin, ['auth', 'login']);
    }
    if (!claudeLoggedIn()) {
      warn(`no login yet — the models are added anyway; log in later with:  ${bin} auth login`);
    } else {
      ok('logged in');
    }
  }
  // Hand the login to somora's own Claude folder right away, so the
  // first turn does not depend on the server's watcher having run.
  const self = somoraSelf(['auth', 'sync']);
  capture(self.cmd, self.args);

  const have = configuredAliases(config).filter((a) => a.engine === 'claude-cli').map((a) => a.id);
  const models = await pickModels(p, 'Which Claude models?', CLAUDE_PRESET.models, have);
  if (models.length) upsertProvider(config, { ...CLAUDE_PRESET, key: providerKeyFor(config, 'claude-cli', 'anthropic'), models: dedupeAliases(config, models) });
}

async function setupCodex(ctx: Ctx, config: YamlFile): Promise<void> {
  const { p } = ctx;
  if (codexLoggedIn()) {
    ok('ChatGPT login found');
  } else {
    explain(`ChatGPT models run through Codex, which comes bundled with somora.
      The login opens a browser on this machine. On a server without a screen,
      choose the device login: it shows a code you enter on another device.`);
    const how = await p.choose('Log in with your ChatGPT subscription:', [
      { label: 'Browser on this machine', value: 'browser' },
      { label: 'Device login (no browser here)', value: 'device' },
      { label: 'Not now', value: 'skip' },
    ], onPath('xdg-open') || process.platform === 'darwin' ? 0 : 1);
    if (how !== 'skip') {
      const self = somoraSelf(['codex', 'login', ...(how === 'device' ? ['--device-auth'] : [])]);
      p.handOver(self.cmd, self.args);
    }
    if (codexLoggedIn()) ok('logged in');
    else warn('no login yet — the models are added anyway; log in later with:  somora codex login');
  }
  const have = configuredAliases(config).filter((a) => a.engine === 'codex-cli').map((a) => a.id);
  const models = await pickModels(p, 'Which ChatGPT models?', CODEX_PRESET.models, have);
  if (models.length) upsertProvider(config, { ...CODEX_PRESET, key: providerKeyFor(config, 'codex-cli', 'openai'), models: dedupeAliases(config, models) });
}

/** Reuse the provider that already runs this engine, else `preferred`
 *  (or `preferred-2` when that key is taken by something else). */
function providerKeyFor(config: YamlFile, engine: string, preferred: string): string {
  const providers = (getIn(config, ['providers']) ?? {}) as Record<string, { engine?: string }>;
  const same = Object.entries(providers).find(([, v]) => v?.engine === engine);
  if (same) return same[0];
  if (!(preferred in providers)) return preferred;
  for (let i = 2; ; i++) if (!(`${preferred}-${i}` in providers)) return `${preferred}-${i}`;
}

/** A preset alias may already be used by one of the person's own
 *  models — aliases must be unique, so the newcomer gets a suffix. */
function dedupeAliases(config: YamlFile, models: ModelPreset[]): ModelPreset[] {
  const existing = configuredAliases(config);
  const taken = existing.map((a) => a.alias);
  return models.map((m) => {
    if (existing.some((a) => a.id === m.id) || !taken.includes(m.alias)) { taken.push(m.alias); return m; }
    const alias = aliasFor(m.alias, taken);
    taken.push(alias);
    return { ...m, alias };
  });
}

interface RemoteModel { id: string; context_length?: number }

async function listRemoteModels(url: string, apiKey: string): Promise<RemoteModel[] | string> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return `the server answered ${r.status} ${r.statusText}`;
    const j = (await r.json()) as { data?: RemoteModel[] };
    return (j.data ?? []).filter((m) => typeof m?.id === 'string');
  } catch (err) {
    return (err as Error).message;
  }
}

async function setupOwnServer(ctx: Ctx, config: YamlFile): Promise<void> {
  const { p } = ctx;
  explain(`Any server that speaks the OpenAI chat protocol works: Ollama, LM Studio, vLLM,
    oMLX — or a hosted one such as OpenRouter (https://openrouter.ai/api/v1).`);
  const url = await p.askValid('Address of the server (ends in /v1)', 'http://localhost:11434/v1', (v) => (/^https?:\/\/\S+$/.test(v) ? null : 'an address starting with http:// or https://'));
  const apiKey = await p.ask('API key (leave empty if the server needs none)', '');
  let remote = await listRemoteModels(url, apiKey);
  while (typeof remote === 'string') {
    warn(`could not list the models there: ${remote}`);
    if (!(await p.confirm('Try again? (No = type the model name yourself)', p.interactive))) { remote = []; break; }
    remote = await listRemoteModels(url, apiKey);
  }
  let picked: RemoteModel[];
  if (remote.length > 0 && remote.length <= 40) {
    ok(`the server offers ${remote.length} model(s)`);
    picked = await p.chooseMany('Which ones should somora use?', remote.map((m) => ({ label: m.id, value: m })), remote.length === 1 ? [0] : []);
  } else {
    if (remote.length > 40) explain(`The server offers ${remote.length} models — type the names of the ones you want.`);
    const ids = (await p.ask('Model name(s), separated by commas', '')).split(',').map((s) => s.trim()).filter(Boolean);
    const known = remote as RemoteModel[];
    picked = ids.map((id) => known.find((m) => m.id === id) ?? { id });
  }
  if (picked.length === 0) { warn('no model chosen — nothing added'); return; }

  const taken = configuredAliases(config).map((a) => a.alias);
  const models: ModelPreset[] = [];
  for (const m of picked) {
    say(`  ${bold(m.id)}`);
    const alias = await p.askValid('  Short name to call it by', aliasFor(m.id, taken), (v) => (!/^[a-z0-9][a-z0-9._-]*$/i.test(v) ? 'letters, digits, dot, dash' : taken.includes(v) ? 'that name is taken' : null));
    taken.push(alias);
    if (!m.context_length) {
      explain(`How much text the model can hold at once, in tokens — as the SERVER is
        configured (Ollama: num_ctx, vLLM: --max-model-len), not what the model card
        says. Too high and long chats fail; when unsure, keep the careful default.`);
    }
    const ctxWindow = Number(await p.askValid('  Context window (tokens)', String(m.context_length ?? 32768), (v) => (Number.isInteger(Number(v)) && Number(v) >= 2048 ? null : 'a whole number, at least 2048')));
    const caps = ['text'];
    if (await p.confirm('  Can it read images?', false)) caps.push('image');
    if (await p.confirm('  Does it have a thinking / reasoning mode?', false)) caps.push('reasoning');
    models.push({ id: m.id, alias, contextWindow: ctxWindow, capabilities: caps, note: '' });
  }
  const providers = (getIn(config, ['providers']) ?? {}) as Record<string, { baseUrl?: string }>;
  const sameServer = Object.entries(providers).find(([, v]) => v?.baseUrl === url)?.[0];
  let key = sameServer;
  if (!key) {
    const guess = /openrouter/.test(url) ? 'openrouter' : /11434/.test(url) ? 'ollama' : 'local';
    key = await p.askValid('Name for this server in the config', guess in providers ? `${guess}-2` : guess, (v) => (!/^[a-z0-9][a-z0-9_-]*$/i.test(v) ? 'letters, digits, dash' : v in providers ? 'that name is taken' : null));
  }
  // Local servers usually ignore the key, but the client library wants one.
  upsertProvider(config, { key, engine: 'openai-compatible', baseUrl: url, apiKey: apiKey || 'none', models });
}

async function stepModels(ctx: Ctx): Promise<void> {
  const { p } = ctx;
  const config = openConfig();
  const before = configuredAliases(config);
  if (before.length) {
    ok(`configured: ${before.map((a) => a.alias).join(', ')}`);
    if (!(await p.confirm('Connect another provider or add models?', false))) return;
  } else {
    explain(`somora brings no AI of its own — it uses the subscriptions or servers you have.
      Connect at least one; more than one gives your agents a backup when one is down.`);
  }
  const engines = new Set(before.map((a) => a.engine));
  const choices: Array<Choice<'claude' | 'codex' | 'own'>> = [
    { label: 'Claude subscription (Pro / Max)', value: 'claude', hint: claudeLoggedIn() ? 'login found on this machine' : claudeBinary() ? 'Claude Code installed, not logged in' : 'installs Claude Code' },
    { label: 'ChatGPT subscription (Plus / Pro / Business)', value: 'codex', hint: codexLoggedIn() ? 'login found on this machine' : 'Codex is bundled' },
    { label: 'My own model server or an API key', value: 'own', hint: 'Ollama, LM Studio, vLLM, OpenRouter, …' },
  ];
  const def: number[] = [];
  if (!engines.has('claude-cli') && claudeLoggedIn()) def.push(0);
  if (!engines.has('codex-cli') && codexLoggedIn()) def.push(1);
  if (def.length === 0 && before.length === 0) def.push(0);
  const wanted = await p.chooseMany('What do you want to connect?', choices, def);
  for (const w of wanted) {
    say();
    say(`  ${bold(choices.find((c) => c.value === w)!.label)}`);
    if (w === 'claude') await setupClaude(ctx, config);
    else if (w === 'codex') await setupCodex(ctx, config);
    else {
      do { await setupOwnServer(ctx, config); } while (await p.confirm('Add another server?', false));
    }
  }
  if (configuredAliases(config).length === 0) {
    warn('no model configured — somora cannot answer without one. Run `somora setup models` when you have a login or a server.');
    return;
  }
  if (save(config, 'config', 'models saved')) ctx.needsRestart = true;
}

// ─── step: search ─────────────────────────────────────────────────────

/** One request to Brave with the key: is it accepted? */
async function braveKeyWorks(key: string): Promise<true | string> {
  try {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=somora&count=1', {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return true;
    if (r.status === 401 || r.status === 403 || r.status === 422) return `Brave rejected the key (HTTP ${r.status}) — copy it again from the dashboard`;
    if (r.status === 429) return 'Brave answered "rate limited" (429) — the key works, but the monthly quota is used up';
    return `Brave answered HTTP ${r.status}`;
  } catch (err) {
    return `could not reach Brave: ${(err as Error).message}`;
  }
}

async function stepSearch(ctx: Ctx): Promise<void> {
  const { p } = ctx;
  const config = openConfig();
  const current = getIn(config, ['web', 'brave', 'apiKey']);
  if (typeof current === 'string' && current) {
    ok('web search is on (Brave Search API key present)');
    if (!(await p.confirm('Replace the key?', false))) return;
  } else {
    explain(`Agents can search the web through the Brave Search API: they get the
      \`web_search\` tool, and \`web_fetch\` reads the pages it finds. The free plan
      allows 2,000 searches a month. Without a key the agents can still read a page
      you give them, but not search.
        1. create an account at  https://api-dashboard.search.brave.com
        2. choose the free "Data for Search" plan and create an API key
        3. paste the key here (it is stored in config.yaml, which only you can read)`);
    if (!(await p.confirm('Do you have a Brave Search API key?', false))) {
      warn('skipped — add it later with `somora setup search`');
      return;
    }
  }
  const key = await p.askValid('API key', undefined, (v) => (v.length < 10 ? 'that is too short for a key' : /\s/.test(v) ? 'a key has no spaces' : null));
  say(`  ${dim('checking the key with one search…')}`);
  const result = await braveKeyWorks(key);
  if (result !== true) {
    warn(result);
    if (!(await p.confirm('Store it anyway?', false))) return;
  } else {
    ok('Brave accepted the key');
  }
  setIn(config, ['web', 'brave', 'apiKey'], key);
  if (save(config, 'config', 'web search saved')) ctx.needsRestart = true;
}

// ─── step: agent ──────────────────────────────────────────────────────

function personaFiles(name: string, userName: string, language: string): Record<string, string> {
  return {
    'AGENTS.md': `---
name: ${name}
description: Personal assistant
icon: 🤖
---

- Answer in ${language} unless asked otherwise. Be concise and clear.
- Say honestly when you don't know something — never invent facts.
- Use your tools when they help; say what you did, not what you would do.
- If the user asks about your tools, list only what you actually have.
`,
    'SOUL.md': `# Who I am

I am ${name}, a personal assistant. This file describes my character —
edit it (or ask me to) once you know how you want me to be.

For now: I speak plainly, stick to facts and keep things short.
`,
    'USER.md': `# About the user

- Name: ${userName}
- Preferred language: ${language}

(Add what the agent should know about you: role, projects, preferences, timezone, …)
`,
  };
}

async function chooseModel(p: Prompter, question: string, aliases: string[], def: string | undefined, allowNone = false): Promise<string | null> {
  const choices: Array<Choice<string | null>> = aliases.map((a) => ({ label: a, value: a }));
  if (allowNone) choices.push({ label: 'none', value: null });
  const i = def ? aliases.indexOf(def) : -1;
  return await p.choose(question, choices, i >= 0 ? i : allowNone ? choices.length - 1 : 0);
}

/** A backup on a different provider than the primary, when there is one. */
function suggestFallback(config: YamlFile, primary: string): string | undefined {
  const all = configuredAliases(config);
  const mine = all.find((a) => a.alias === primary);
  const other = all.filter((a) => a.provider !== mine?.provider).map((a) => a.alias);
  return pickPreferred('chat', other);
}

async function createAgent(ctx: Ctx, config: YamlFile, existing: string[]): Promise<string | null> {
  const { p } = ctx;
  const aliases = configuredAliases(config).map((a) => a.alias);
  if (aliases.length === 0) { warn('no model configured yet — run `somora setup models` first'); return null; }
  const name = await p.askValid('Name of the agent (lowercase, e.g. your assistant\'s first name)', existing.length ? undefined : 'assistant', (v) =>
    !/^[a-z][a-z0-9-]{0,30}$/.test(v) ? 'lowercase letters, digits and dashes, starting with a letter' : existing.includes(v) ? 'an agent with that name exists' : null);
  ctx.principal ??= await p.ask('What should it call you?', userInfo().username);
  const language = await p.ask('Which language should it answer in?', (process.env.LANG ?? '').startsWith('de') ? 'German' : 'English');
  const model = (await chooseModel(p, 'Which model should it think with?', aliases, pickPreferred('chat', aliases)))!;
  let fallback: string | null = null;
  if (aliases.length > 1) {
    explain('A backup model takes over when the first one is unreachable — best on a different provider.');
    fallback = await chooseModel(p, 'Backup model:', aliases.filter((a) => a !== model), suggestFallback(config, model), true);
  }
  const dir = join(AGENTS_DIR, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(personaFiles(name, ctx.principal, language))) {
    writeFileSync(join(dir, file), text, 'utf8');
  }
  writeFileSync(join(dir, 'agent.yaml'), `# Operator config for this agent. Every option (thinking, sampling, tools,
# voice, rem, …) is described in docs/agents.md.
model: ${model}
${fallback ? `fallback: [${fallback}]\n` : ''}`, 'utf8');
  written.add(join(dir, 'agent.yaml'));
  ok(`agent ${bold(name)} created ${dim(`→ ${tildify(dir)}`)}`);
  ctx.needsRestart = true;
  return name;
}

async function stepAgent(ctx: Ctx): Promise<void> {
  const { p } = ctx;
  const config = openConfig();
  const agents = await listAgents();
  const aliases = configuredAliases(config).map((a) => a.alias);
  if (agents.length === 0) {
    explain(`An agent is one assistant with its own name, character and memory.
      You start with one; more can follow (here, or in the web client).`);
    if (!(await createAgent(ctx, config, []))) return;
  } else {
    await checkAgentModels(ctx, agents, aliases);
  }
  while (await p.confirm('Add another agent?', false)) {
    const names = (await listAgents()).map((a) => a.name);
    if (!(await createAgent(ctx, config, names))) break;
  }
}

async function checkAgentModels(ctx: Ctx, agents: Array<{ name: string }>, aliases: string[]): Promise<void> {
  const { p } = ctx;
  // Agents whose model is gone would fail on the first message.
  for (const a of agents) {
    const file = agentYaml(a.name);
    const model = getIn(file, ['model']) as string | undefined;
    const known = model === undefined || aliases.includes(model) || model.includes('/');
    if (known) { ok(`${a.name}${model ? dim(` — ${model}`) : ''}`); continue; }
    warn(`${a.name} is set to model '${model}', which is not configured`);
    if (aliases.length && await p.confirm(`Pick a model for ${a.name}?`)) {
      setIn(file, ['model'], (await chooseModel(p, 'Model:', aliases, pickPreferred('chat', aliases)))!);
      if (save(file, 'plain', `${a.name} updated`)) ctx.needsRestart = true;
    }
  }
}

// ─── step: memory ─────────────────────────────────────────────────────

async function stepMemory(ctx: Ctx): Promise<void> {
  const { p } = ctx;
  const config = openConfig();
  const aliases = configuredAliases(config).map((a) => a.alias);
  const agents = (await listAgents()).filter((a) => a.kind !== 'builder');
  if (aliases.length === 0 || agents.length === 0) { warn('needs a model and an agent first — run `somora setup` from the start'); return; }

  explain(`Your agents remember across conversations. Three background jobs do that —
    somora calls them dreaming:
      REM    after a chat goes quiet, an agent notes what was worth keeping
      Deep   twice a day, those notes are filed into a shared wiki
      Lucid  once a week, the wiki is checked for contradictions and duplicates;
             what it finds is shown to you, nothing is changed without a yes`);

  // REM — per agent
  const remState = agents.map((a) => ({ name: a.name, file: agentYaml(a.name) })).map((a) => ({ ...a, on: getIn(a.file, ['rem', 'enabled']) === true }));
  const off = remState.filter((a) => !a.on);
  if (off.length === 0) {
    ok(`REM is on for ${remState.map((a) => a.name).join(', ')}`);
  } else if (await p.confirm(`Turn on REM for ${off.map((a) => a.name).join(', ')}?`)) {
    explain('REM runs often and reads whole conversations — a fast, inexpensive model is the right one.');
    const model = (await chooseModel(p, 'Model for REM:', aliases, pickPreferred('rem', aliases)))!;
    const rest = aliases.filter((a) => a !== model);
    const fallback = rest.length ? await chooseModel(p, 'Backup model for REM:', rest, pickPreferred('rem', rest), true) : null;
    for (const a of off) {
      setIn(a.file, ['rem'], { enabled: true, model, ...(fallback ? { fallback } : {}), idleMinutes: 30 });
      if (save(a.file, 'plain', `REM on for ${a.name}`)) ctx.needsRestart = true;
    }
  }
  const anyRem = remState.some((a) => a.on) || remState.some((a) => getIn(a.file, ['rem', 'enabled']) === true);
  if (anyRem && getIn(config, ['rem', 'dedup', 'judge', 'enabled']) !== true) {
    explain(`Before a new note is kept, a model can check whether your agent already knows
      it. That keeps the memory free of repeats, for a few extra model calls per run.`);
    if (await p.confirm('Turn on this duplicate check?')) setIn(config, ['rem', 'dedup', 'judge', 'enabled'], true);
  }

  // Wiki + Deep + Lucid — platform-wide
  say();
  const vault = getIn(config, ['obsidian', 'vault']) as string | undefined;
  const wikiOn = getIn(config, ['wiki', 'enabled']) === true;
  if (wikiOn && vault) {
    ok(`shared wiki: ${vault}/${(getIn(config, ['wiki', 'vaultSubfolder']) as string | undefined) ?? 'somora'}`);
  } else {
    explain(`The shared wiki is a folder of plain text files that all agents read and Deep
      writes to. If you use Obsidian, point it at your vault and the wiki becomes a
      subfolder of it; otherwise a new folder is fine — you can open it with any editor.`);
    const where = await p.choose('Where should the wiki live?', [
      { label: 'A new folder', value: 'new', hint: vault ? undefined : '~/somora-vault' },
      { label: 'My Obsidian vault (I type the path)', value: 'vault' },
      { label: 'No wiki for now', value: 'skip', hint: 'REM still works; Deep and Lucid stay off' },
    ], vault ? 1 : 0);
    if (where !== 'skip') {
      const path = await p.askValid('Folder', vault ?? (where === 'new' ? '~/somora-vault' : undefined), (v) => {
        if (!v) return 'a folder path, please';
        if (where === 'vault' && !existsSync(expandHome(v))) return `${v} does not exist`;
        return null;
      });
      mkdirSync(expandHome(path), { recursive: true });
      const language = await p.choose('Language of the wiki (folder names, headings, the text Deep writes):', [
        { label: 'English', value: 'en' }, { label: 'Deutsch', value: 'de' },
      ], (process.env.LANG ?? '').startsWith('de') ? 1 : 0);
      explain('Deep and Lucid run rarely and decide what goes into the wiki — take a careful model.');
      const model = (await chooseModel(p, 'Model for Deep and Lucid:', aliases, pickPreferred('deep', aliases)))!;
      setIn(config, ['obsidian', 'vault'], path);
      setIn(config, ['wiki', 'enabled'], true);
      setIn(config, ['wiki', 'language'], language);
      // A backup on another provider, when there is one: without it a
      // run fails for as long as the worker is unreachable.
      const others = aliases.filter((a) => a !== model);
      const backup = others.length ? await chooseModel(p, 'Backup model for Deep and Lucid (used when the first is unreachable):', others, suggestFallback(config, model), true) : null;
      setIn(config, ['wiki', 'deep', 'enabled'], true);
      setIn(config, ['wiki', 'deep', 'model'], model);
      setIn(config, ['wiki', 'lucid', 'enabled'], true);
      setIn(config, ['wiki', 'lucid', 'model'], model);
      if (backup) {
        setIn(config, ['wiki', 'deep', 'fallback'], [backup]);
        setIn(config, ['wiki', 'lucid', 'fallback'], [backup]);
      }
    }
  }
  if (save(config, 'config', 'memory settings saved')) ctx.needsRestart = true;
}

// ─── step: team ───────────────────────────────────────────────────────

async function stepTeam(ctx: Ctx): Promise<void> {
  const { p } = ctx;
  const agents = await listAgents();
  if (existsSync(teamFilePath())) {
    ok(`team file present — arrange it in the web client's team window`);
    return;
  }
  if (agents.length < 2) {
    explain(`With one agent there is no team yet. When a second one joins, run
      \`somora setup team\` (or open the team window in the web client): every agent
      then knows who the others are, who reports to whom and whom to ask for what.`);
    return;
  }
  explain(`${agents.length} agents: ${agents.map((a) => a.name).join(', ')}. A team file tells each of them who the others
    are and whom to involve for what. It starts flat — everyone reports to you.`);
  if (!(await p.confirm('Write the team file?'))) return;
  ctx.principal ??= await p.ask('Your name, as the agents should know you', userInfo().username);
  const r = await writeTeamFile(initialTeamFile(agents.map((a) => ({ name: a.name, role: a.role, description: a.description })), ctx.principal));
  ok(`team file written ${dim(`→ ${tildify(r.path)}`)} — refine roles in the web client's team window`);
}

// ─── step: access ─────────────────────────────────────────────────────

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.')) return a.address;
    }
  }
  return null;
}

async function tailscaleHttps(ctx: Ctx, config: YamlFile): Promise<boolean> {
  const { p } = ctx;
  let ts = tailscaleState();
  if (!ts.installed) {
    explain(`Tailscale is a free private network between your own devices. somora uses it
      to be reachable from your phone and laptop — and only from them — with a real
      HTTPS certificate. It needs an account (tailscale.com) and its app on each device.`);
    if (!(await p.confirm('Install Tailscale on this machine now? (official installer, asks for your password)'))) return false;
    p.handOver('sh', ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh']);
    ts = tailscaleState();
    if (!ts.installed) { fail('Tailscale is still not installed — see https://tailscale.com/download'); return false; }
  }
  if (!ts.running) {
    explain('Tailscale is installed but this machine is not connected. The next command shows a link — open it and sign in.');
    if (!(await p.confirm('Connect now? (sudo tailscale up)'))) return false;
    p.handOver('sudo', ['tailscale', 'up']);
    ts = tailscaleState();
    if (!ts.running) { fail(`not connected (state: ${ts.backendState ?? 'unknown'}) — run \`sudo tailscale up\`, then \`somora setup access\``); return false; }
  }
  ok(`Tailscale connected${ts.dnsName ? ` as ${ts.dnsName}` : ''}`);
  while (!ts.certsEnabled) {
    explain('One switch is missing in your Tailscale account (once per account):');
    say(`    1. open  ${cyan('https://login.tailscale.com/admin/dns')}`);
    say('    2. turn on "MagicDNS" (if it is off)');
    say('    3. under "HTTPS Certificates" press "Enable HTTPS"');
    if (!(await p.confirm('Done — check again?', p.interactive))) return false;
    ts = tailscaleState();
  }
  const host = ts.dnsName!;
  const certDir = join(SOMORA_HOME, 'certs');
  mkdirSync(certDir, { recursive: true });
  try { chmodSync(certDir, 0o700); } catch { /* best effort */ }
  const cert = join(certDir, `${host}.crt`);
  const key = join(certDir, `${host}.key`);
  const issue = (): { code: number; stderr: string } => capture('tailscale', ['cert', '--cert-file', cert, '--key-file', key, host], 120_000);
  say(`  ${dim('requesting the certificate (can take half a minute)…')}`);
  let r = issue();
  if (r.code !== 0 && isOperatorError(r.stderr)) {
    const user = userInfo().username;
    explain(`Tailscale only lets administrators fetch certificates. One command allows your
      user to do it too — needed so somora can renew the certificate by itself later.`);
    if (await p.confirm(`Allow it? (sudo tailscale set --operator=${user})`)) {
      p.handOver('sudo', ['tailscale', 'set', `--operator=${user}`]);
      r = issue();
    }
  }
  if (r.code !== 0 || !existsSync(cert) || !existsSync(key)) {
    fail(`no certificate: ${r.stderr.trim().split('\n').pop() || 'unknown error'}`);
    say(`  ${dim(`Try by hand:  tailscale cert --cert-file ${tildify(cert)} --key-file ${tildify(key)} ${host}`)}`);
    return false;
  }
  ok(`certificate for ${host}`);
  const rel = (f: string): string => (SOMORA_HOME === join(HOME, '.somora') ? tildify(f) : f);
  setIn(config, ['server', 'host'], '0.0.0.0');
  setIn(config, ['server', 'tls'], { cert: rel(cert), key: rel(key), publicHost: host, renew: 'tailscale' });
  ok('somora renews the certificate by itself from now on (no restart needed)');
  return true;
}

async function stepAccess(ctx: Ctx): Promise<void> {
  const { p } = ctx;
  const config = openConfig();
  const port = serverPort(config);
  const tls = getIn(config, ['server', 'tls']) as { publicHost?: string; renew?: string } | undefined;
  const host = (getIn(config, ['server', 'host']) as string | undefined) ?? '127.0.0.1';
  if (tls?.publicHost) {
    ok(`HTTPS is set up: https://${tls.publicHost}:${port}/web/`);
    if (!tls.renew && tls.publicHost.endsWith('.ts.net')) {
      explain('The certificate is from Tailscale and runs out every 90 days. somora can renew it by itself — without a restart.');
      if (await p.confirm('Turn on automatic renewal?')) {
        setIn(config, ['server', 'tls', 'renew'], 'tailscale');
        if (save(config, 'config', 'automatic renewal on')) ctx.needsRestart = true;
      }
    }
    return;
  }
  explain(`somora's web client runs in any browser. Out of the box it answers only on this
    machine. To use it from your phone or laptop — including microphone and voice —
    it needs HTTPS; the simple way to get that is Tailscale.`);
  const lan = lanAddress();
  const mode = await p.choose('How do you want to reach somora?', [
    { label: 'Tailscale HTTPS', value: 'tailscale', hint: 'your devices only, from anywhere; microphone and voice work (recommended)' },
    { label: 'This machine only', value: 'local', hint: `http://127.0.0.1:${port}/web/` },
    { label: 'Local network, no HTTPS', value: 'lan', hint: `http://${lan ?? '<this machine>'}:${port}/web/ — no microphone, one window at a time` },
  ], host === '0.0.0.0' ? 2 : p.interactive ? 0 : 1);
  if (mode === 'tailscale') {
    if (!(await tailscaleHttps(ctx, config))) {
      warn('HTTPS is not set up — somora stays reachable on this machine only. Run `somora setup access` to try again.');
      return;
    }
  } else if (mode === 'lan') {
    explain(`somora has no login of its own: everyone who can reach this machine on port ${port}
      can talk to your agents. Only do this in a network you trust.`);
    if (!(await p.confirm('Open it to the local network?', false))) return;
    setIn(config, ['server', 'host'], '0.0.0.0');
  } else {
    if (host !== '127.0.0.1') setIn(config, ['server', 'host'], '127.0.0.1');
    deleteIn(config, ['server', 'tls']);
  }
  if (save(config, 'config', 'access settings saved')) ctx.needsRestart = true;
}

// ─── step: start ──────────────────────────────────────────────────────

async function waitHealthy(config: YamlFile, seconds: number): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < seconds; i++) {
    const h = await health(config);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function stepStart(ctx: Ctx): Promise<void> {
  const { p } = ctx;
  const config = openConfig();
  const agents = await listAgents();
  if (configuredAliases(config).length === 0 || agents.length === 0) {
    warn('not starting: no model or no agent yet — run `somora setup` again when you have one');
    return;
  }
  let up = await health(config);
  if (!serviceAvailable()) {
    if (!up) {
      warn('no background service on this system. Start somora in a terminal (or tmux):');
      say(`      ${cyan('somora server start --foreground')}`);
      return;
    }
    if (ctx.needsRestart) warn('somora is running but was changed — restart it to apply the new settings');
  } else if (!up) {
    const self = somoraSelf(['server', 'start']);
    capture(self.cmd, self.args);
    say(`  ${dim('starting somora…')}`);
    up = await waitHealthy(config, 90);
  } else if (ctx.needsRestart) {
    if (await p.confirm('somora is running. Restart it now to apply the changes? (running conversations are interrupted)')) {
      const self = somoraSelf(['server', 'restart']);
      capture(self.cmd, self.args);
      await new Promise((r) => setTimeout(r, 2000));
      up = await waitHealthy(config, 90);
      ctx.needsRestart = false;
    } else {
      warn('not restarted — the changes apply after:  somora server restart');
    }
  }
  if (!up) {
    fail(`somora does not answer. Look at the log:  ${LOG_HINT}`);
    return;
  }
  ok(`somora ${SOMORA_VERSION} is running`);

  const agent = agents.length === 1 ? agents[0]!.name
    : await p.choose('Send a test message to which agent?', [...agents.map((a) => ({ label: a.name, value: a.name as string | null })), { label: 'skip the test', value: null }], 0);
  if (agent && (agents.length > 1 || await p.confirm(`Send a test message to ${agent}?`))) {
    say(`  ${dim('asking… (the first answer can take a minute)')}`);
    try {
      const r = await localRequest(config, '/chat/send-sync', {
        body: { agent, session: 'setup-check', create_session: true, text: 'This is the setup check. Reply with one short sentence to confirm you are working.' },
        timeoutMs: 180_000,
      });
      const j = r.json as { finalText?: string; outcome?: string; outcome_reason?: string; error?: string; model?: string };
      const text = (j.finalText ?? '').trim();
      if (r.status === 200 && text && j.outcome !== 'failed') {
        ok(`${agent} answered${j.model ? ` on ${j.model}` : ''}: ${text.split('\n')[0]!.slice(0, 200)}`);
        // A backup that answers hides a broken first choice — say so.
        const primary = getIn(agentYaml(agent), ['model']) as string | undefined;
        const primaryId = configuredAliases(config).find((a) => a.alias === primary)?.id ?? primary?.split('/').pop();
        if (j.model && primaryId && j.model !== primaryId) {
          warn(`that was the backup model — the first choice (${primary}) did not respond. Check its login: somora setup models`);
        }
      } else {
        fail(`${agent} did not answer: ${j.error ?? j.outcome_reason ?? j.outcome ?? `HTTP ${r.status}`}`);
        explain(`Usually the login of the model provider: run \`somora setup models\`, or see the log with  ${LOG_HINT}`);
      }
    } catch (err) {
      fail(`test message failed: ${(err as Error).message}`);
    }
  }

  const base = baseUrl(config);
  heading('Ready');
  say(`  Web client     ${cyan(`${base}/web/`)}`);
  say(`  Phone          ${cyan(`${base}/mobile`)}${base.startsWith('https') ? dim('  (add to home screen)') : ''}`);
  say(`  Terminal       ${cyan('somora tui')}`);
  say(`  Update         ${cyan('somora update')}`);
  say(`  This assistant ${cyan('somora setup')}${dim('  — or one step: somora setup access')}`);
  say();
}

// ─── entry ────────────────────────────────────────────────────────────

const RUN: Record<Step, (ctx: Ctx) => Promise<void>> = {
  models: stepModels,
  search: stepSearch,
  agent: stepAgent,
  memory: stepMemory,
  team: stepTeam,
  access: stepAccess,
  start: stepStart,
};

export async function runSetupCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(usage()); return 0; }
  const only = args[0] as Step | undefined;
  if (only && !STEPS.includes(only)) {
    process.stderr.write(`unknown step: ${only}\n\n${usage()}`);
    return 2;
  }
  mkdirSync(SOMORA_HOME, { recursive: true });
  const ctx: Ctx = { p: new Prompter(), needsRestart: false };
  // The lettering on a full run, unless the installer has just shown it.
  const banner = !only && process.env.SOMORA_BANNER_SHOWN !== '1'
    ? renderBanner(`setup ${SOMORA_VERSION}`, { isTTY: process.stdout.isTTY === true, columns: process.stdout.columns, utf8: isUtf8Locale() })
    : '';
  if (banner) process.stdout.write(`${banner}\n`);
  else say(bold(`somora setup`) + dim(`  ${SOMORA_VERSION}`));
  if (!only) say(dim('  Enter takes the suggestion in [brackets]. Ctrl-C stops; run it again to pick up where you left off.'));
  const steps: Step[] = only ? (only === 'start' ? ['start'] : [only, 'start']) : [...STEPS];
  try {
    for (const [i, s] of steps.entries()) {
      heading(only ? STEP_TITLES[s] : `${i + 1}/${steps.length}  ${STEP_TITLES[s]}`);
      // After a single step, only offer the restart/test when something changed.
      if (only && s === 'start' && only !== 'start' && !ctx.needsRestart) { ok('nothing to apply'); break; }
      await RUN[s](ctx);
    }
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
  return 0;
}
