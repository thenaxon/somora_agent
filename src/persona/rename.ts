// Renaming an agent (docs/agents.md#renaming-an-agent): one step that
// carries every place the name lives — a somora agent's folder (sessions,
// memory, notes, tools' files) and the name in its AGENTS.md, the paths in
// its memory index, its dream files, its browser profile, Sentinel
// triggers, tmux records, team.yaml, and the config.yaml fields that name
// it (an external agent's own entry, A2A, browser profiles, voices).
//
// It runs only while nothing is running for the agent. Texts are left
// alone — personas, notes, team rules — and reported where they still
// say the old name: they are the person's or the agents' own words.

import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';
import { validateConfigText } from '../setup/config-edit.ts';
import { configPath } from '../config/loader.ts';
import { parseYaml } from '../config/yaml.ts';
import { getBrowserService } from '../browser/service.ts';
import type { Config } from '../config/types.ts';
import { getExternalAgent, listExternalAgents, nativeAgentExists } from '../external/registry.ts';
import { closeAgentConnections } from '../external/connection.ts';
import { flushUnprompted } from '../external/unprompted.ts';
import { evictMemoryManager } from '../memory/registry.ts';
import { listAgents, loadPersona, validateAgentsMd } from '../persona/loader.ts';
import { holdForRename } from './rename-lock.ts';
import { listAllSessionLockStates } from '../server/session-queue.ts';
import { listWork } from '../server/work-ledger.ts';
import { getTrigger, listTriggers, loadTriggers, saveTrigger } from '../sentinel/store.ts';
import { resetTeamCache, teamFilePath } from '../team/store.ts';
import { parseTeamFile } from '../team/resolve.ts';
import { logger } from '../server/logger.ts';

/** The strictest of the places a name goes (team.yaml, browser
 *  profiles): lower-case letters, digits, `-` and `_`. */
export const AGENT_NAME_RULE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Whether a name, written plainly into a YAML file, reads back as text:
 *  `123`, `1e3` or `true` pass the rule but read as a number or a
 *  boolean, and team.yaml or a frontmatter would no longer load. */
export function readsAsText(name: string): boolean {
  try {
    return typeof (parseYaml(`k: ${name}`) as { k?: unknown } | undefined)?.k === 'string';
  } catch {
    return false;
  }
}

export interface RenameDeps {
  config: Config;
  /** Take the old name out of the REM worker. */
  remUnregister?: (agent: string) => void;
  /** Register dreamers again (the new name). */
  syncDreamers?: () => Promise<void>;
  /** Reload config.yaml in the running server. */
  reloadConfig?: () => Promise<void>;
}

export interface RenameReport {
  ok: boolean;
  from: string;
  to: string;
  kind: 'somora' | 'external';
  dryRun: boolean;
  /** What was (or would be) changed, one line each. */
  changes: string[];
  /** Places that still say the old name, and things to tell others. */
  warnings: string[];
  error?: string;
}

const home = () => process.env.SOMORA_HOME ?? join(homedir(), '.somora');

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Why the agent cannot be renamed right now, or null. */
function busyReason(name: string): string | null {
  const locks = listAllSessionLockStates().filter((l) => l.agent === name && (l.busy || l.queueLength > 0));
  if (locks.length > 0) return `a turn is running or waiting in ${locks.map((l) => l.session).join(', ')}`;
  const work = listWork().filter((w) => (w.state === 'running' || w.state === 'queued') && (w.target.agent === name || (w.requester !== undefined && 'agent' in w.requester && w.requester.agent === name)));
  if (work.length > 0) return `${work.length} piece${work.length === 1 ? '' : 's'} of work for or from it are still open (agent_ask, sub-agents, wakes)`;
  const jobs = join(home(), 'agents', name, 'exec-jobs');
  if (existsSync(jobs)) {
    for (const d of readdirSync(jobs)) {
      const m = readJson<{ state?: string }>(join(jobs, d, 'meta.json'));
      if (m?.state === 'running') return `a background command (exec job ${d}) is still running`;
    }
  }
  if (browserActive(name) || profileLocked(join(home(), 'browser', 'profiles', name))) return 'its browser is running — close it first';
  const loop = readJson<{ agent?: string; active?: boolean }>(join(home(), 'wiki-lucid', 'loop-state.json'));
  if (loop?.agent === name && loop.active !== false) return 'it holds the Lucid review loop';
  return null;
}

function browserActive(name: string): boolean {
  try {
    return getBrowserService().agentBrowserActive(name);
  } catch {
    return false; // no browser service in this process
  }
}

/** Chromium's profile lock is a symlink to `<host>-<pid>` (Linux, macOS)
 *  — existsSync follows it to a target that is no file and never saw it.
 *  A lock whose process is gone on this host is a leftover of a crash. */
function profileLocked(profile: string): boolean {
  const lock = join(profile, 'SingletonLock');
  let target: string;
  try {
    if (!lstatSync(lock).isSymbolicLink()) return true;
    target = readlinkSync(lock);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  if (!m || m[1] !== hostname()) return true;
  try {
    process.kill(Number(m[2]), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── surgical YAML edits ─────────────────────────────────────────────
// A rename changes a name and nothing else: the edits replace exactly the
// characters of each occurrence in the file's text, found through the
// parsed document's source ranges. Re-rendering the document would
// rewrap long texts and re-indent a hand-kept file.

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** The replacement for a scalar node, in the same quoting style. */
function scalarEdit(node: unknown, to: string): Edit | null {
  if (!isScalar(node) || !node.range) return null;
  // Plain stays plain unless the name would then read as a number or a
  // boolean (the name rule refuses those; this is the second guard).
  const quote = node.type === 'QUOTE_SINGLE' ? "'" : node.type === 'QUOTE_DOUBLE' ? '"' : readsAsText(to) ? '' : "'";
  return { start: node.range[0], end: node.range[1], text: `${quote}${to}${quote}` };
}

/** Edit for a map key `from` at `path`. */
function keyEdit(doc: Document, path: string[], from: string, to: string): Edit | null {
  const map = path.length === 0 ? doc.contents : doc.getIn(path, true);
  if (!isMap(map)) return null;
  for (const pair of map.items) if (isScalar(pair.key) && pair.key.value === from) return scalarEdit(pair.key, to);
  return null;
}

/** Edits for every `from` in a string list at `path`. */
function seqEdits(doc: Document, path: string[], from: string, to: string): Edit[] {
  const seq = doc.getIn(path, true);
  if (!isSeq(seq)) return [];
  return seq.items.filter((it) => isScalar(it) && it.value === from).map((it) => scalarEdit(it, to)).filter((e): e is Edit => e !== null);
}

/** Edit for a scalar value `from` at `path`. */
function valueEdit(doc: Document, path: string[], from: string, to: string): Edit | null {
  const node = doc.getIn(path, true);
  return isScalar(node) && node.value === from ? scalarEdit(node, to) : null;
}

function mapKeys(doc: Document, path: string[]): string[] {
  const map = doc.getIn(path, true);
  if (!isMap(map)) return [];
  return map.items.map((p) => (isScalar(p.key) ? String(p.key.value) : '')).filter(Boolean);
}

function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].sort((x, y) => y.start - x.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

interface YamlEdit {
  path: string;
  original: string;
  next: string;
  changes: string[];
}

function readYamlFile(path: string): { text: string; doc: Document } | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${path} is not valid YAML: ${doc.errors[0]!.message}`);
  return { text, doc };
}

/** Write with a backup beside it, atomically. */
function writeWithBackup(file: YamlEdit): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  // Never over an earlier rename's backup from the same second.
  let backup = `${file.path}.bak-rename-${stamp}`;
  for (let n = 2; existsSync(backup); n += 1) backup = `${file.path}.bak-rename-${stamp}-${n}`;
  writeFileSync(backup, file.original, { mode: 0o600, flag: 'wx' });
  try {
    const tmp = `${file.path}.tmp-rename`;
    writeFileSync(tmp, file.next, { mode: 0o600 });
    renameSync(tmp, file.path);
  } catch (err) {
    rmQuiet(backup);
    throw err;
  }
  return backup;
}

/** Where texts still say the old name: personas of every agent, team rules. */
async function textMentions(from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  const word = new RegExp(`(^|[^A-Za-z0-9_-])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`, 'i');
  for (const a of await listAgents()) {
    for (const f of ['AGENTS.md', 'SOUL.md', 'USER.md']) {
      const p = join(home(), 'agents', a.name, f);
      if (!existsSync(p)) continue;
      const lines = readFileSync(p, 'utf8').split('\n');
      const hits = lines.map((l, i) => (word.test(l) && !(a.name === to && f === 'AGENTS.md' && /^name:/.test(l)) ? i + 1 : 0)).filter(Boolean);
      if (hits.length > 0) out.push(`${a.name}/${f} still says '${from}' (line ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ', …' : ''})`);
    }
  }
  const team = teamFilePath();
  if (existsSync(team)) {
    // The entry and reports_to lines are the rename's own business.
    const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const structural = new RegExp(`^\\s*(${esc}:|reports_to:\\s*['"]?${esc}['"]?)\\s*(#.*)?$`);
    const lines = readFileSync(team, 'utf8').split('\n');
    const hits = lines.map((l, i) => (word.test(l) && !structural.test(l) ? i + 1 : 0)).filter(Boolean);
    if (hits.length > 0) out.push(`team.yaml still says '${from}' in its text (line ${hits.slice(0, 5).join(', ')}) — a rule or note, left as written`);
  }
  return out;
}

/** Fields of config.yaml that still name `name` as the server reads the
 *  file — merge keys and aliases resolved. */
function configNames(text: string, name: string, system?: string): string[] {
  const c = (parseYaml(text) ?? {}) as Record<string, any>;
  const out: string[] = [];
  if (system && c.external?.systems?.[system]?.agents && name in c.external.systems[system].agents) out.push(`external.systems.${system}.agents.${name}`);
  if (c.a2a?.defaultAgent === name) out.push('a2a.defaultAgent');
  for (const [peer, p] of Object.entries((c.a2a?.peers ?? {}) as Record<string, { agents?: unknown }>)) if (Array.isArray(p?.agents) && p.agents.includes(name)) out.push(`a2a.peers.${peer}.agents`);
  for (const [prof, p] of Object.entries((c.browser?.profiles ?? {}) as Record<string, { agents?: unknown }>)) if (Array.isArray(p?.agents) && p.agents.includes(name)) out.push(`browser.profiles.${prof}.agents`);
  if (c.tts?.agentVoices && typeof c.tts.agentVoices === 'object' && name in c.tts.agentVoices) out.push(`tts.agentVoices.${name}`);
  return out;
}

/** Entries of team.yaml that still name `name`, as the server reads it. */
function teamNames(text: string, name: string): string[] {
  const t = (parseYaml(text) ?? {}) as { agents?: Record<string, { reports_to?: unknown } | null> };
  const out: string[] = [];
  if (t.agents && typeof t.agents === 'object') {
    if (name in t.agents) out.push(`agents.${name}`);
    for (const [a, e] of Object.entries(t.agents)) if (e?.reports_to === name) out.push(`agents.${a}.reports_to`);
  }
  return out;
}

const viaAnchor = (file: string, from: string, left: string[]) =>
  `${file} would still name '${from}' at ${left.join(', ')}: that entry comes through a YAML anchor, alias or merge key (<<), which the rename does not edit. Write it out under its own name, then rename again.`;

/** AGENTS.md with its frontmatter `name:` set to `to` — only that value,
 *  only inside the leading `---` block, so a `name:` line further down
 *  (a YAML example in the persona) stays as written. Null: nothing to change. */
export function renameInFrontmatter(text: string, to: string): string | null {
  const m = /^(---\r?\n)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const offset = m[1]!.length;
  const doc = parseDocument(m[2]!);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'name');
  const e = pair ? scalarEdit(pair.value, to) : null;
  if (!e) return null;
  return text.slice(0, offset + e.start) + e.text + text.slice(offset + e.end);
}

interface FileEdit {
  path: string;
  original: string;
  next: string;
}

/** Dream files that name the agent, as paths below its folder. */
function dreamEdits(dir: string, from: string, to: string): Array<{ rel: string; original: string; next: string }> {
  const root = join(dir, 'memory', '.dreams');
  if (!existsSync(root)) return [];
  const out: Array<{ rel: string; original: string; next: string }> = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p, join(rel, e));
      else if (e.endsWith('.json')) {
        const original = readFileSync(p, 'utf8');
        let j: { agent?: string } | null = null;
        try {
          j = JSON.parse(original) as { agent?: string };
        } catch {
          continue;
        }
        if (j && j.agent === from) out.push({ rel: join(rel, e), original, next: JSON.stringify({ ...j, agent: to }, null, 2) + '\n' });
      }
    }
  };
  walk(root, join('memory', '.dreams'));
  return out;
}

function browserStateEdit(from: string, to: string): FileEdit | null {
  const path = join(home(), 'browser', 'state.json');
  if (!existsSync(path)) return null;
  const original = readFileSync(path, 'utf8');
  let state: unknown;
  try {
    state = JSON.parse(original);
  } catch {
    return null;
  }
  const ids = new Map([
    [`agent:${from}`, `agent:${to}`],
    [`agent:${from}@${from}`, `agent:${to}@${to}`],
  ]);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const key = ids.get(k) ?? k;
        out[key] = (k === 'agent' || k === 'profile') && x === from ? to : typeof x === 'string' && ids.has(x) ? ids.get(x) : walk(x);
      }
      return out;
    }
    return v;
  };
  const next = JSON.stringify(walk(state), null, 2) + '\n';
  return next === original ? null : { path, original, next };
}

function tmuxEdits(from: string, to: string): Array<FileEdit & { n: number }> {
  const out: Array<FileEdit & { n: number }> = [];
  for (const f of ['tmux-origins.json', 'tmux-observations.json']) {
    const path = join(home(), f);
    if (!existsSync(path)) continue;
    const original = readFileSync(path, 'utf8');
    let m: Record<string, { agent?: string }>;
    try {
      m = JSON.parse(original) as Record<string, { agent?: string }>;
    } catch {
      continue;
    }
    let n = 0;
    for (const rec of Object.values(m)) {
      if (rec && rec.agent === from) {
        rec.agent = to;
        n += 1;
      }
    }
    if (n > 0) out.push({ path, original, next: JSON.stringify(m, null, 2) + '\n', n });
  }
  return out;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-rename`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function rmQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* gone already */
  }
}

/** Copies of the memory index (and its WAL files) to put back on failure. */
function snapshotFiles(paths: string[]): { restore: () => void; drop: () => void } {
  const kept = paths.filter((p) => existsSync(p));
  for (const p of kept) copyFileSync(p, `${p}.bak-rename`);
  return {
    restore: () => {
      for (const p of paths) {
        if (kept.includes(p)) {
          copyFileSync(`${p}.bak-rename`, p);
          rmQuiet(`${p}.bak-rename`);
        } else rmQuiet(p);
      }
    },
    drop: () => {
      for (const p of kept) rmQuiet(`${p}.bak-rename`);
    },
  };
}

// One rename at a time: two would prepare config.yaml and team.yaml edits
// from the same text and the second write would undo the first.
let renames: Promise<unknown> = Promise.resolve();

export function renameAgent(from: string, to: string, deps: RenameDeps, opts: { dryRun?: boolean } = {}): Promise<RenameReport> {
  const run = renames.then(() => renameAgentNow(from, to, deps, opts));
  renames = run.catch(() => undefined);
  return run;
}

async function renameAgentNow(from: string, to: string, deps: RenameDeps, opts: { dryRun?: boolean }): Promise<RenameReport> {
  const dryRun = opts.dryRun === true;
  const external = getExternalAgent(from, deps.config);
  const persona = external ? null : await loadPersona(from);
  const kind: RenameReport['kind'] = external ? 'external' : 'somora';
  const report: RenameReport = { ok: false, from, to, kind, dryRun, changes: [], warnings: [] };
  const fail = (error: string): RenameReport => ({ ...report, error });

  // ── checks ─────────────────────────────────────────────────────────
  if (!external && !persona) return fail(`no agent '${from}'`);
  if (from === to) return fail('the new name is the old one');
  if (!AGENT_NAME_RULE.test(to)) return fail(`'${to}' is not a valid agent name: lower-case letters, digits, - and _, starting with a letter or digit, at most 64 characters`);
  if (!readsAsText(to)) return fail(`'${to}' is not a valid agent name: YAML files would read it as a number or true/false — add a letter`);
  if (nativeAgentExists(to) || getExternalAgent(to, deps.config) || existsSync(join(home(), 'agents', to))) return fail(`an agent or folder named '${to}' already exists`);
  const browserProfile = join(home(), 'browser', 'profiles', from);
  const newBrowserProfile = join(home(), 'browser', 'profiles', to);
  const hasBrowser = existsSync(browserProfile);
  if (hasBrowser && existsSync(newBrowserProfile)) return fail(`a browser profile named '${to}' already exists (browser/profiles/${to}) — remove it or choose another name`);
  let busy = busyReason(from);
  if (busy) return fail(`'${from}' is busy: ${busy}. Try again when it is idle.`);
  if (external && !dryRun) {
    // What it sent on its own and not yet written goes into its sessions
    // now, while they may still be written (the hold below refuses
    // session writes; a write after the move would make agents/<from>
    // again). Then the busy check once more: nothing may have started.
    closeAgentConnections(from, to);
    await flushUnprompted(from);
    busy = busyReason(from);
    if (busy) return fail(`'${from}' is busy: ${busy}. Try again when it is idle.`);
  }
  // From here on no turn starts and no session is written for either
  // name — taken in the same step as the busy check (rename-lock.ts).
  const release = dryRun ? () => {} : holdForRename([from, to]);
  try {
    return await renameHeld();
  } finally {
    release();
  }

  async function renameHeld(): Promise<RenameReport> {
    const dir = join(home(), 'agents', from);
    const newDir = join(home(), 'agents', to);
    const hasDir = existsSync(dir);

    // ── prepare every edit (validated before anything moves) ──────────
    let cfg: YamlEdit | null = null;
    let team: YamlEdit | null = null;
    let agentsMd: { original: string; next: string } | null = null;
    try {
      const cfgFile = readYamlFile(configPath());
      if (cfgFile) {
        const d = cfgFile.doc;
        const cfgEdits: Edit[] = [];
        const cfgChanges: string[] = [];
        const push = (e: Edit | Edit[] | null, change: string) => {
          const list = Array.isArray(e) ? e : e ? [e] : [];
          if (list.length > 0) {
            cfgEdits.push(...list);
            cfgChanges.push(change);
          }
        };
        if (external) push(keyEdit(d, ['external', 'systems', external.system, 'agents'], from, to), `config.yaml: external.systems.${external.system}.agents.${from} → ${to}`);
        push(valueEdit(d, ['a2a', 'defaultAgent'], from, to), `config.yaml: a2a.defaultAgent → ${to}`);
        for (const peer of mapKeys(d, ['a2a', 'peers'])) push(seqEdits(d, ['a2a', 'peers', peer, 'agents'], from, to), `config.yaml: a2a.peers.${peer}.agents`);
        for (const p of mapKeys(d, ['browser', 'profiles'])) push(seqEdits(d, ['browser', 'profiles', p, 'agents'], from, to), `config.yaml: browser.profiles.${p}.agents`);
        push(keyEdit(d, ['tts', 'agentVoices'], from, to), `config.yaml: tts.agentVoices.${from} → ${to}`);
        const next = applyEdits(cfgFile.text, cfgEdits);
        // What the server will read afterwards: nothing may still name
        // the old agent (an entry reached through `<<: *anchor` has no
        // text of its own to edit), and an external agent must be there
        // under its new name.
        const left = configNames(next, from, external?.system);
        if (left.length > 0) throw new Error(viaAnchor('config.yaml', from, left));
        if (external && !configNames(next, to, external.system).includes(`external.systems.${external.system}.agents.${to}`)) {
          throw new Error(viaAnchor('config.yaml', from, [`external.systems.${external.system}.agents`]));
        }
        if (cfgEdits.length > 0) {
          const problem = validateConfigText(next);
          if (problem) throw new Error(`config.yaml would not load after the rename: ${problem}`);
          cfg = { path: configPath(), original: cfgFile.text, next, changes: cfgChanges };
        }
      }

      const teamPath = teamFilePath();
      const teamFile = readYamlFile(teamPath);
      if (teamFile) {
        const teamEdits: Edit[] = [];
        const teamChanges: string[] = [];
        const k = keyEdit(teamFile.doc, ['agents'], from, to);
        if (k) {
          teamEdits.push(k);
          teamChanges.push(`team.yaml: agents.${from} → ${to}`);
        }
        for (const a of mapKeys(teamFile.doc, ['agents'])) {
          const e = valueEdit(teamFile.doc, ['agents', a, 'reports_to'], from, to);
          if (e) {
            teamEdits.push(e);
            teamChanges.push(`team.yaml: ${a === from ? to : a} reports to ${to}`);
          }
        }
        const next = applyEdits(teamFile.text, teamEdits);
        const left = teamNames(next, from);
        if (left.length > 0) throw new Error(viaAnchor('team.yaml', from, left));
        if (teamEdits.length > 0) {
          const d = parseDocument(next);
          if (d.errors.length > 0) throw new Error(`team.yaml would not be valid YAML after the rename: ${d.errors[0]!.message}`);
          // A chart that loads now must load afterwards.
          const before = parseTeamFile(parseYaml(teamFile.text) ?? {});
          const after = parseTeamFile(parseYaml(next) ?? {});
          if (before.file && !after.file) throw new Error(`team.yaml would not load after the rename: ${after.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
          team = { path: teamPath, original: teamFile.text, next, changes: teamChanges };
        }
      }

      if (persona && hasDir && existsSync(join(dir, 'AGENTS.md'))) {
        const original = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
        const next = renameInFrontmatter(original, to);
        if (next !== null && next !== original) {
          const check = validateAgentsMd(next, to);
          if (validateAgentsMd(original, from).ok && !check.ok) throw new Error(`AGENTS.md would not load after the rename: ${check.error}`);
          agentsMd = { original, next };
        }
      }
    } catch (err) {
      return fail((err as Error).message);
    }

    // Another process (an agent's tool child) may have written triggers.
    await loadTriggers().catch(() => {});
    const triggers = listTriggers().filter((t) => t.dispatch?.agent === from || (t as { ownerAgent?: string }).ownerAgent === from);

    // ── the plan ──────────────────────────────────────────────────────
    const plan: string[] = [];
    if (hasDir) plan.push(`folder agents/${from} → agents/${to} (sessions${persona ? ', memory, notes, agent.yaml' : ''})`);
    if (persona) plan.push(`AGENTS.md: name → ${to}`, 'memory index: paths under the new folder', 'dream files: agent → ' + to);
    if (hasBrowser) plan.push(`browser profile browser/profiles/${from} → ${to} (its logins come along)`);
    if (triggers.length > 0) plan.push(`Sentinel: ${triggers.length} trigger${triggers.length === 1 ? '' : 's'} now for ${to}`);
    plan.push(...(team?.changes ?? []), ...(cfg?.changes ?? []));
    report.changes = plan;
    if (persona?.a2a) report.warnings.push(`other systems reach it at a new address: …/a2a/agents/${to} (tell the peers that call /a2a/agents/${from})`);
    if (persona) report.warnings.push(`editors or scripts that run 'somora acp --agent ${from}' need the new name`);
    if (persona) {
      // Its standing conversations with external agents (a2a-<name>).
      const withExternal = listExternalAgents(deps.config)
        .filter((e) => existsSync(join(home(), 'agents', e.name, 'sessions')) && readdirSync(join(home(), 'agents', e.name, 'sessions')).some((f) => f.endsWith(`_a2a-${from}.jsonl`)))
        .map((e) => e.name);
      if (withExternal.length > 0) report.warnings.push(`its conversations with ${withExternal.join(', ')} start afresh as a2a-${to}; the old ones stay as a2a-${from}`);
    }

    if (dryRun) {
      report.ok = true;
      report.warnings.push(...(await textMentions(from, to)));
      return report;
    }

    // The files rewritten after the move, read now.
    const dreams = persona && hasDir ? dreamEdits(dir, from, to) : [];
    const browserState = hasBrowser ? browserStateEdit(from, to) : null;
    const tmux = tmuxEdits(from, to);

    // ── let go of what the running server holds ───────────────────────
    if (external) closeAgentConnections(from, to);
    if (persona) {
      await evictMemoryManager(from);
      deps.remUnregister?.(from);
    }

    // ── move and rewrite; every step leaves its undo ──────────────────
    const done: string[] = [];
    const undo: Array<{ what: string; run: () => void | Promise<void> }> = [];
    let snapshot: ReturnType<typeof snapshotFiles> | null = null;
    try {
      if (hasDir) {
        renameSync(dir, newDir);
        undo.push({ what: `folder agents/${to} → agents/${from}`, run: () => renameSync(newDir, dir) });
        done.push(`folder agents/${from} → agents/${to}`);
      }
      if (persona && hasDir) {
        if (agentsMd) {
          const md = join(newDir, 'AGENTS.md');
          const original = agentsMd.original;
          writeFileSync(md, agentsMd.next);
          undo.push({ what: 'AGENTS.md', run: () => writeFileSync(md, original) });
          done.push(`AGENTS.md: name → ${to}`);
        }
        const db = join(newDir, 'memory.db');
        if (existsSync(db)) {
          const snap = snapshotFiles([db, `${db}-wal`, `${db}-shm`]);
          snapshot = snap;
          undo.push({ what: 'memory index', run: () => snap.restore() });
          const n = movedIndexPaths(db, dir, newDir);
          if (n !== null) done.push(`memory index: ${n} path${n === 1 ? '' : 's'} moved`);
        }
        for (const d of dreams) {
          const p = join(newDir, d.rel);
          writeAtomic(p, d.next);
          undo.push({ what: `dream file ${d.rel}`, run: () => writeFileSync(p, d.original) });
        }
        if (dreams.length > 0) done.push(`dream files: ${dreams.length} now name ${to}`);
      }
      if (hasBrowser) {
        renameSync(browserProfile, newBrowserProfile);
        undo.push({ what: `browser profile ${to} → ${from}`, run: () => renameSync(newBrowserProfile, browserProfile) });
        if (browserState) {
          writeAtomic(browserState.path, browserState.next);
          undo.push({ what: 'browser/state.json', run: () => writeFileSync(browserState.path, browserState.original) });
        }
        done.push(`browser profile → ${to}`);
      }
      for (const t of triggers) {
        const owned = (t as { ownerAgent?: string }).ownerAgent === from;
        const wakes = t.dispatch?.agent === from;
        const next = { ...t, dispatch: { ...t.dispatch, ...(wakes ? { agent: to } : {}) } } as typeof t & { ownerAgent?: string };
        if (owned) next.ownerAgent = to;
        await saveTrigger(next);
        undo.push({
          what: `Sentinel trigger ${t.id}`,
          run: async () => {
            // Back to the old name on the trigger as it is now (the
            // scheduler may have moved its next run meanwhile).
            const cur = (getTrigger(t.id) ?? next) as typeof t & { ownerAgent?: string };
            const back = { ...cur, dispatch: { ...cur.dispatch, ...(wakes ? { agent: from } : {}) } } as typeof cur;
            if (owned) back.ownerAgent = from;
            await saveTrigger(back);
          },
        });
      }
      if (triggers.length > 0) done.push(`Sentinel: ${triggers.length} trigger${triggers.length === 1 ? '' : 's'}`);
      let tm = 0;
      for (const f of tmux) {
        writeAtomic(f.path, f.next);
        undo.push({ what: f.path.slice(home().length + 1), run: () => writeFileSync(f.path, f.original) });
        tm += f.n;
      }
      if (tm > 0) done.push(`tmux records: ${tm}`);
      for (const y of [team, cfg]) {
        if (!y) continue;
        const backup = writeWithBackup(y);
        undo.push({
          what: y.path.slice(home().length + 1),
          run: () => {
            writeFileSync(y.path, y.original, { mode: 0o600 });
            rmQuiet(backup);
          },
        });
        done.push(...y.changes);
      }
    } catch (err) {
      // Everything back, last step first: the old name works as before.
      const stuck: string[] = [];
      for (const u of undo.reverse()) {
        try {
          await u.run();
        } catch (e) {
          stuck.push(`${u.what} (${(e as Error).message})`);
        }
      }
      resetTeamCache();
      await deps.syncDreamers?.().catch(() => {});
      logger.error({ msg: 'agent.rename_failed', from, to, err: (err as Error).message, done, stuck });
      const error =
        stuck.length === 0
          ? `rename stopped: ${(err as Error).message} — nothing changed, everything is back under '${from}'`
          : `rename stopped: ${(err as Error).message} — could not put back: ${stuck.join('; ')}`;
      return { ...report, changes: stuck.length === 0 ? [] : done, error };
    }
    snapshot?.drop();

    resetTeamCache();
    if (cfg) await deps.reloadConfig?.().catch(() => {});
    await deps.syncDreamers?.().catch(() => {});
    report.ok = true;
    report.changes = done;
    report.warnings.push(...(await textMentions(from, to)));
    logger.info({ msg: 'agent.renamed', from, to, kind, changes: done.length });
    return report;
  }
}

/** Point the memory index's paths at the new folder. Null when there is
 *  no index. */
function movedIndexPaths(dbPath: string, oldDir: string, newDir: string): number | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    const like = `${oldDir}/%`;
    const tx = db.transaction(() => {
      const files = db.prepare('UPDATE files SET path = ? || substr(path, ?) WHERE path LIKE ?').run(newDir, oldDir.length + 1, like).changes;
      db.prepare('UPDATE chunks SET file_path = ? || substr(file_path, ?) WHERE file_path LIKE ?').run(newDir, oldDir.length + 1, like);
      return files;
    });
    return tx() as number;
  } finally {
    db.close();
  }
}
