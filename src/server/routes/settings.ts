// The settings window's routes (docs/web.md "Settings window",
// docs/api.md "Settings"): read every setting with its explanation and
// where its value comes from, change single settings in config.yaml
// without rewriting the file, see the file read only, and go back to an
// earlier version. Keys and passwords never leave the server.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Hono } from 'hono';
import { isScalar, parseDocument, visit } from 'yaml';
import { configPath, validateConfigText } from '../../config/loader.ts';
import { RESTART_REQUIRED_SECTIONS } from '../../config/reload.ts';
import { SETTINGS_CATALOG, SETTINGS_GROUPS, groupOfSection } from '../../config/settings/catalog/index.ts';
import { matchesFieldPath, settingFields, type SettingField } from '../../config/settings/fields.ts';
import { YamlEditError, applyYamlEdits, type YamlEdit } from '../../config/settings/yaml-edit.ts';
import { parseYaml } from '../../config/yaml.ts';
import { logger } from '../logger.ts';

export interface SettingsRoutesDeps {
  /** The same reload as POST /config/reload. */
  reload: () => Promise<{ ok: true; changed: string[]; restartRequired: string[] } | { ok: false; error: string }>;
}

/** Backups kept; older ones are deleted. */
export const KEEP_BACKUPS = 20;
const SECRET_KEY = /(apikey|token|secret|password|authorization)$/i;

function backupDir(): string {
  return join(dirname(configPath()), 'config-backups');
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

function fieldFor(path: string): SettingField | undefined {
  const fields = settingFields();
  return fields.find((f) => f.path === path) ?? fields.find((f) => matchesFieldPath(f.path, path));
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
      const p = [...path, k];
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
        Pair(_k, pair) {
          const key = pair.key && isScalar(pair.key) ? String(pair.key.value) : '';
          const v = pair.value as { range?: [number, number, number] } | null;
          if (SECRET_KEY.test(key) && v?.range) spans.push([v.range[0], v.range[1]]);
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
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const p = [...prefix, k];
      out.push(p.join('.'));
      pathsInFile(v, p, out);
    }
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
    });
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
        const parts = path.split('.');
        if (ch.reset === true) edits.push({ path: parts, remove: true });
        else if (typeof ch.secret === 'string') edits.push({ path: parts, value: ch.secret });
        else if ('value' in ch) edits.push({ path: parts, value: ch.value });
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
