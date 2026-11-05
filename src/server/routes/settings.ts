// The settings window's routes (docs/web.md "Settings window",
// docs/api.md "Settings"): read every setting with its explanation and
// where its value comes from, change single settings in config.yaml
// without rewriting the file, see the file read only, and go back to an
// earlier version. Keys and passwords never leave the server.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Hono } from 'hono';
import { isPair, isScalar, parseDocument, visit } from 'yaml';
import { configPath, envOverriddenSettings, validateConfigText } from '../../config/loader.ts';
import type { Config } from '../../config/types.ts';
import { samplingBody } from '../../engine/sampling.ts';
import { resolveOpenAiReasoning } from '../../engine/thinking-params.ts';
import { RESTART_REQUIRED_SECTIONS } from '../../config/reload.ts';
import { SETTINGS_CATALOG, SETTINGS_GROUPS, groupOfSection } from '../../config/settings/catalog/index.ts';
import { matchesFieldPath, settingFields, type SettingField } from '../../config/settings/fields.ts';
import { brokenRefs, refOptions, type AgentModels } from '../../config/settings/refs.ts';
import { YamlEditError, applyYamlEdits, type YamlEdit } from '../../config/settings/yaml-edit.ts';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { parseYaml } from '../../config/yaml.ts';
import { logger } from '../logger.ts';

export interface SettingsRoutesDeps {
  /** The same reload as POST /config/reload. */
  reload: () => Promise<{ ok: true; changed: string[]; restartRequired: string[] } | { ok: false; error: string }>;
  /** The configuration in force, for testing a model as it is saved. */
  currentConfig: () => Config;
}

/** Ask a model for one word: does it answer, how fast, with what? Only
 *  openai-compatible providers can be asked directly; a model on
 *  claude-cli, codex-cli or grok-cli is checked by a chat turn. */
export async function testModel(config: Config, providerName: string, modelId: string, timeoutMs = 30_000): Promise<{ ok: boolean; ms?: number; reply?: string; error?: string; note?: string }> {
  const provider = config.providers[providerName];
  if (!provider) return { ok: false, error: `no provider '${providerName}' in the saved configuration — apply first` };
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) return { ok: false, error: `no model '${modelId}' under '${providerName}' in the saved configuration — apply first` };
  if (provider.engine !== 'openai-compatible') {
    return { ok: false, note: `${provider.engine} models are not asked directly; start a chat with an agent on this model to check it` };
  }
  const started = Date.now();
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
      // The limit as a chat turn sends it: only when the model sets one
      // (some reasoning models refuse `max_tokens`).
      // With the model's own saved defaults: its reasoning level and
      // sampling, as a chat turn without an agent preference sends them.
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        ...(model.maxTokens ? { max_tokens: model.maxTokens } : {}),
        ...resolveOpenAiReasoning(model.reasoning?.default, model).body,
        ...samplingBody(model.sampling),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    let j: { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>; error?: unknown };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      return { ok: false, ms, error: `the answer was not JSON: ${text.slice(0, 200)}` };
    }
    // A completion: a choice with a message. A reasoning model may spend
    // the few tokens on thinking and leave the text empty — still an answer.
    const msg = j.choices?.[0]?.message;
    if (!msg || j.error) return { ok: false, ms, error: `no completion in the answer: ${text.slice(0, 200)}` };
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    const thought = typeof msg.reasoning_content === 'string' || typeof msg.reasoning === 'string';
    if (!content && !thought) return { ok: false, ms, error: 'the model answered with an empty message' };
    return { ok: true, ms, reply: content ? content.slice(0, 200) : '(thinking only, no text)' };
  } catch (err) {
    const e = err as Error;
    return { ok: false, ms: Date.now() - started, error: e.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : e.message };
  }
}

/** Backups kept; older ones are deleted. */
export const KEEP_BACKUPS = 20;
const SECRET_KEY = /(apikey|token|secret|password|authorization)$/i;

function backupDir(): string {
  return join(dirname(configPath()), 'config-backups');
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The setting a concrete path belongs to. A path one step below a
 *  map or list (`mcp.servers.<name>`, `imageGen.models.3`,
 *  `mcp.servers.<name>.headers.<header>`) is an entry of it. */
function fieldFor(path: string): SettingField | undefined {
  const fields = settingFields();
  const own = fields.find((f) => f.path === path) ?? fields.find((f) => matchesFieldPath(f.path, path));
  if (own) return own;
  const parent = path.split('.').slice(0, -1).join('.');
  const holder = parent ? fields.find((f) => f.path === parent) ?? fields.find((f) => matchesFieldPath(f.path, parent)) : undefined;
  return holder && (holder.kind === 'map' || holder.kind === 'list') ? holder : undefined;
}

/** A value the window got blanked (`{ secret: true, set }`) must never
 *  be written back as if it were the value. */
function carriesBlankedSecret(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(carriesBlankedSecret);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.secret === true && 'set' in o) return true;
    return Object.values(o).some(carriesBlankedSecret);
  }
  return false;
}

function isSecretPath(path: string): boolean {
  const last = path.split('.').pop() ?? '';
  if (SECRET_KEY.test(last)) return true;
  const f = fieldFor(path);
  return !!(f && SETTINGS_CATALOG[f.path]?.sensitive);
}

/** A copy with every secret replaced by `{ secret: true, set }`. */
export function redactSecrets(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => redactSecrets(v, [...path, String(i)]));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = [...path, k.replace(/%/g, '%25').replace(/\./g, '%2E')];
      out[k] = typeof v === 'string' && isSecretPath(p.join('.')) ? { secret: true, set: v.length > 0 } : redactSecrets(v, p);
    }
    return out;
  }
  return value;
}

/** The file as text with the values of secret keys blanked. The
 *  values are found by parsing (a block scalar over several lines, a
 *  flow map `{apiKey: …}` are covered), and a key written into a comment
 *  ("# token: abc…") is blanked too. A file that does not parse is
 *  blanked line by line. */
export function redactYamlText(text: string): string {
  const spans: Array<[number, number]> = [];
  try {
    const doc = parseDocument(text);
    if (doc.errors.length === 0) {
      visit(doc, {
        Pair(_k, pair, path) {
          const key = pair.key && isScalar(pair.key) ? String(pair.key.value) : '';
          const v = pair.value as { range?: [number, number, number] } | null;
          // Every header of an MCP server: names like X-Api-Key carry keys too.
          const underHeaders = path.some((n) => isPair(n) && isScalar(n.key) && String(n.key.value) === 'headers');
          if ((SECRET_KEY.test(key) || (underHeaders && isScalar(pair.value))) && v?.range) spans.push([v.range[0], v.range[1]]);
        },
      });
    } else throw new Error('unparsed');
  } catch {
    return redactLines(text);
  }
  let out = text;
  for (const [a, b] of spans.sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)}•••• (set)${out.slice(b).replace(/^[ \t]*\n?/, (m) => (m.includes('\n') ? '\n' : m))}`;
  return redactComments(out);
}

function redactComments(text: string): string {
  return text.replace(/(#[^\n]*?\b(?:api[ _-]?key|token|secret|password)\b[ \t]*[:=][ \t]*)(\S{6,})/gi, '$1••••');
}

function redactLines(text: string): string {
  return redactComments(
    text
      .split('\n')
      .map((line) =>
        line.replace(/^([ \t]*-?[ \t]*["']?([A-Za-z0-9_]+)["']?[ \t]*:[ \t]*)(\S[^#]*?)([ \t]*(#.*)?)$/, (all, head: string, key: string, _v: string, tail: string) =>
          SECRET_KEY.test(key) ? `${head}•••• (set)${tail}` : all,
        ),
      )
      .join('\n'),
  );
}

/** Dotted paths the file itself sets (everything else is a default). */
function pathsInFile(raw: unknown, prefix: string[] = [], out: string[] = []): string[] {
  // Entries of a list by index, names with a dot as %2E — the paths the
  // window builds.
  const entries = Array.isArray(raw)
    ? raw.filter((v) => v && typeof v === 'object').length > 0 ? raw.map((v, i) => [String(i), v] as const) : []
    : raw && typeof raw === 'object' ? Object.entries(raw).map(([k, v]) => [k.replace(/%/g, '%25').replace(/\./g, '%2E'), v] as const) : [];
  for (const [k, v] of entries) {
    const p = [...prefix, k];
    out.push(p.join('.'));
    pathsInFile(v, p, out);
  }
  return out;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.settings-${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  const mode = (await stat(file).catch(() => null))?.mode;
  await writeFile(tmp, text, mode !== undefined ? { mode: mode & 0o777 } : {});
  await rename(tmp, file);
}

async function backup(text: string): Promise<string> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const name = `config.yaml.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await writeFile(join(dir, name), text, { mode: 0o600 });
  const all = (await readdir(dir)).filter((f) => f.startsWith('config.yaml.')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await unlink(join(dir, old)).catch(() => undefined);
  return name;
}

function valueAt(data: unknown, path: string): unknown {
  let cur = data;
  for (const k of path.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/** Every agent's model and fallback chain (agent.yaml). */
async function agentModels(): Promise<AgentModels[]> {
  const out: AgentModels[] = [];
  for (const a of await listAgents().catch(() => [])) {
    const p = await loadPersona(a.name).catch(() => null);
    if (!p) continue;
    // Its chat model and fallback chain, and its own REM worker models.
    const rem = p.rem as { model?: string; fallback?: string | string[] } | undefined;
    const remModels = [rem?.model, ...(Array.isArray(rem?.fallback) ? rem.fallback : [rem?.fallback])].filter((x): x is string => typeof x === 'string' && x !== '');
    const fallback = [...(p.fallback ?? []), ...remModels];
    out.push({ agent: a.name, ...(p.model ? { model: p.model } : {}), ...(fallback.length > 0 ? { fallback } : {}) });
  }
  return out;
}

type Change = { path: string; value?: unknown; reset?: boolean; secret?: string };

// One change of the file at a time: read, hash check, backup and write
// of an apply or a restore never interleave with another's.
let writing: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(f: () => Promise<T>): Promise<T> {
  const run = writing.then(f, f);
  writing = run.catch(() => undefined);
  return run;
}

export function registerSettingsRoutes(app: Hono, deps: SettingsRoutesDeps): void {
  app.get('/settings', async (c) => {
    const text = await readFile(configPath(), 'utf8');
    const checked = validateConfigText(text);
    let raw: unknown = {};
    try {
      raw = parseYaml(text) ?? {};
    } catch {
      /* shown as invalid below */
    }
    return c.json({
      path: configPath(),
      hash: hashOf(text),
      valid: checked.ok,
      ...(checked.ok ? {} : { issues: checked.issues }),
      groups: SETTINGS_GROUPS,
      restartSections: RESTART_REQUIRED_SECTIONS,
      fields: settingFields().map((f) => ({ ...f, ...(SETTINGS_CATALOG[f.path] ? { info: SETTINGS_CATALOG[f.path] } : {}) })),
      values: checked.ok ? redactSecrets(checked.config) : null,
      inFile: pathsInFile(raw),
      envSet: envOverriddenSettings(),
      ...(checked.ok ? { refOptions: refOptions(checked.config) } : {}),
    });
  });

  app.post('/settings/test-model', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { provider?: unknown; model?: unknown } | null;
    if (typeof body?.provider !== 'string' || typeof body?.model !== 'string') return c.json({ error: 'body must be { provider, model }' }, 400);
    const r = await testModel(deps.currentConfig(), body.provider, body.model);
    logger.info({ msg: 'settings.model_tested', provider: body.provider, model: body.model, ok: r.ok, ms: r.ms });
    return c.json(r);
  });

  app.get('/settings/yaml', async (c) => {
    const text = await readFile(configPath(), 'utf8');
    return c.json({ path: configPath(), hash: hashOf(text), text: redactYamlText(text) });
  });

  app.post('/settings/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hash?: unknown; changes?: unknown } | null;
    return oneAtATime(async () => {
      if (!body || typeof body.hash !== 'string' || !Array.isArray(body.changes) || body.changes.length === 0) {
        return c.json({ error: 'body must be { hash, changes: [{ path, value } | { path, reset: true } | { path, secret }] }' }, 400);
      }
      const file = configPath();
      const text = await readFile(file, 'utf8');
      if (hashOf(text) !== body.hash) {
        return c.json({ error: 'config.yaml changed since you opened it — reload the settings and apply again', hash: hashOf(text) }, 409);
      }
      const edits: YamlEdit[] = [];
      const problems: Array<{ path: string; message: string }> = [];
      for (const ch of body.changes as Change[]) {
        const path = typeof ch?.path === 'string' ? ch.path : '';
        const field = path ? fieldFor(path) : undefined;
        if (!field) {
          problems.push({ path, message: 'no such setting' });
          continue;
        }
        if (!groupOfSection(field.section)?.ready) {
          problems.push({ path, message: 'this setting is changed in config.yaml for now' });
          continue;
        }
        const env = envOverriddenSettings()[path];
        if (env) {
          problems.push({ path, message: `set by the environment variable ${env}, which wins over config.yaml` });
          continue;
        }
        const info = SETTINGS_CATALOG[field.path];
        if (info?.locked) {
          problems.push({ path, message: info.locked });
          continue;
        }
        if (info?.retired && ch.reset !== true) {
          problems.push({ path, message: 'this setting is no longer read; it can only be removed' });
          continue;
        }
        // A segment with a dot of its own comes as %2E (docs/api.md).
        let parts: string[];
        try {
          parts = path.split('.').map((x) => decodeURIComponent(x));
        } catch {
          problems.push({ path, message: 'a name in this path is not encoded right' });
          continue;
        }
        // Which segments index a list, from the schema: a map entry named
        // 123 is a name, an entry of a list at 0 an index.
        const segs = path.split('.');
        const lists = segs.map((_, i) => {
          const prefix = segs.slice(0, i).join('.');
          return i > 0 && settingFields().find((f) => matchesFieldPath(f.path, prefix))?.kind === 'list';
        });
        if (ch.reset === true) edits.push({ path: parts, remove: true, lists });
        else if (typeof ch.secret === 'string') edits.push({ path: parts, value: ch.secret, lists });
        else if ('value' in ch && carriesBlankedSecret(ch.value)) problems.push({ path, message: 'a key or password cannot be sent back blanked; replace it on its own' });
        else if ('value' in ch) edits.push({ path: parts, value: ch.value, lists });
        else problems.push({ path, message: 'give value, reset or secret' });
      }
      if (problems.length > 0) return c.json({ error: 'some changes were refused', issues: problems }, 400);
      let next: string;
      try {
        next = applyYamlEdits(text, edits);
      } catch (err) {
        if (err instanceof YamlEditError) return c.json({ error: err.message }, 400);
        throw err;
      }
      // The same values as the file already has: nothing to write.
      if (next === text) return c.json({ ok: true, hash: hashOf(text), unchanged: true });
      const checked = validateConfigText(next);
      if (!checked.ok) return c.json({ error: 'the changes would make config.yaml invalid; nothing was written', issues: checked.issues }, 400);
      // A model, provider or named model still in use must not vanish.
      const was = validateConfigText(text);
      if (was.ok) {
        // A locked setting stays as it was, also when its block is sent whole.
        const lockedChanged = Object.entries(SETTINGS_CATALOG)
          .filter(([p, e]) => e.locked && !p.includes('*'))
          .filter(([p]) => JSON.stringify(valueAt(was.config, p)) !== JSON.stringify(valueAt(checked.config, p)))
          .map(([p, e]) => ({ path: p, message: e.locked! }));
        if (lockedChanged.length > 0) return c.json({ error: 'some changes were refused', issues: lockedChanged }, 400);
        const broken = brokenRefs(was.config, checked.config, await agentModels());
        if (broken.length > 0) return c.json({ error: 'the changes would remove something still in use; nothing was written', issues: broken }, 400);
      }
      const saved = await backup(text);
      await writeAtomic(file, next);
      const paths = edits.map((e) => e.path.join('.'));
      logger.info({ msg: 'settings.applied', paths, backup: saved });
      const reloaded = await deps.reload();
      return c.json({ ok: true, hash: hashOf(next), backup: saved, reload: reloaded });
    });
  });

  app.get('/settings/backups', async (c) => {
    const dir = backupDir();
    const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('config.yaml.')).sort().reverse();
    const list = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(dir, name))).mtimeMs, bytes: (await stat(join(dir, name))).size })));
    return c.json({ backups: list, keep: KEEP_BACKUPS });
  });

  app.post('/settings/restore', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; hash?: unknown } | null;
    return oneAtATime(async () => {
      const name = typeof body?.name === 'string' ? basename(body.name) : '';
      if (!name.startsWith('config.yaml.')) return c.json({ error: 'body must be { name, hash }' }, 400);
      const file = configPath();
      const text = await readFile(file, 'utf8');
      if (typeof body?.hash === 'string' && hashOf(text) !== body.hash) {
        return c.json({ error: 'config.yaml changed since you opened it — reload the settings first', hash: hashOf(text) }, 409);
      }
      const old = await readFile(join(backupDir(), name), 'utf8').catch(() => null);
      if (old === null) return c.json({ error: `no backup '${name}'` }, 404);
      const checked = validateConfigText(old);
      if (!checked.ok) return c.json({ error: 'that version does not validate against this somora; nothing was written', issues: checked.issues }, 400);
      const saved = await backup(text);
      await writeAtomic(file, old);
      logger.info({ msg: 'settings.restored', from: name, backup: saved });
      const reloaded = await deps.reload();
      return c.json({ ok: true, hash: hashOf(old), backup: saved, reload: reloaded });
    });
  });
}
