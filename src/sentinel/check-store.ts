// Files of check triggers (Sentinel phase 2), next to triggers.json:
//
//   sentinel/
//     scripts/<id>/check.<ext>   ← somora's copy of the agent's script
//     state/<id>/                ← the script's own folder (SOMORA_SENTINEL_STATE_DIR)
//     check-state/<id>.json      ← counters, last result, next check
//
// The copy is what runs: an agent editing the file in its workspace
// later does not change a running trigger (Hermes ran scripts by path
// and hit exactly that). Every run first compares the copy with the
// fingerprint taken at creation.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { chmod, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { CheckScriptLang, CheckState } from './types.ts';

function sentinelDir(): string {
  return join(process.env.SOMORA_HOME ?? join(homedir(), '.somora'), 'sentinel');
}
export function checkScriptDir(id: string): string {
  return join(sentinelDir(), 'scripts', id);
}
export function checkStateDir(id: string): string {
  return join(sentinelDir(), 'state', id);
}
function checkStatePath(id: string): string {
  return join(sentinelDir(), 'check-state', `${id}.json`);
}

/** The language by file extension. The first line (shebang) is not
 *  read: which interpreter runs a check is somora's choice (Hermes). */
export function langOf(path: string): CheckScriptLang | null {
  switch (extname(path).toLowerCase()) {
    case '.sh':
    case '.bash':
      return 'sh';
    case '.py':
      return 'python';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'node';
    default:
      return null;
  }
}

const EXT: Record<CheckScriptLang, string> = { sh: 'sh', python: 'py', node: 'mjs' };

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The copy's name: `check.<ext>` by the source's language. A JS file
 *  keeps its module kind: `.cjs` stays CommonJS. */
function copyNameFor(sourcePath: string): { file: string; lang: CheckScriptLang } {
  const lang = langOf(sourcePath);
  if (!lang) throw new Error(`unsupported script type: ${extname(sourcePath) || 'no extension'} — use .sh, .py or .js/.mjs`);
  const ext = lang === 'node' && extname(sourcePath).toLowerCase() === '.cjs' ? 'cjs' : EXT[lang];
  return { file: `check.${ext}`, lang };
}

/** Copy the agent's script into somora's folder; returns what the
 *  trigger records. */
export async function installCheckScript(
  id: string,
  sourcePath: string,
): Promise<{ file: string; lang: CheckScriptLang; sha256: string }> {
  const { file, lang } = copyNameFor(sourcePath);
  const dir = checkScriptDir(id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, file);
  await copyFile(sourcePath, target);
  await chmod(target, 0o600);
  mkdirSync(checkStateDir(id), { recursive: true, mode: 0o700 });
  return { file, lang, sha256: sha256(await readFile(target)) };
}

/** A new version of a trigger's script: the old copy goes, the state
 *  folder stays (the script may keep what it has seen). The source is
 *  read before anything is touched, the new copy goes into a folder of
 *  its own and is swapped in by rename. An agent may hand in a file
 *  inside the trigger's own folder, even the copy itself; clearing the
 *  folder first lost both files (2026-10-20 report). Any failure leaves
 *  the old copy where it was. */
export async function replaceCheckScript(id: string, sourcePath: string): Promise<{ file: string; lang: CheckScriptLang; sha256: string }> {
  const { file, lang } = copyNameFor(sourcePath);
  const bytes = await readFile(sourcePath);
  const dir = checkScriptDir(id);
  const stamp = `${process.pid}.${Date.now().toString(36)}`;
  const fresh = `${dir}.new.${stamp}`;
  const old = `${dir}.old.${stamp}`;
  try {
    mkdirSync(fresh, { recursive: true, mode: 0o700 });
    await writeFile(join(fresh, file), bytes, { mode: 0o600 });
    if (sha256(await readFile(join(fresh, file))) !== sha256(bytes)) throw new Error('the new script copy does not match its source');
  } catch (err) {
    await rm(fresh, { recursive: true, force: true });
    throw err;
  }
  const hadOld = existsSync(dir);
  if (hadOld) await rename(dir, old);
  try {
    await rename(fresh, dir);
  } catch (err) {
    if (hadOld) await rename(old, dir).catch(() => {});
    await rm(fresh, { recursive: true, force: true });
    throw err;
  }
  if (hadOld) await rm(old, { recursive: true, force: true });
  mkdirSync(checkStateDir(id), { recursive: true, mode: 0o700 });
  return { file, lang, sha256: sha256(bytes) };
}

/** The script's text when it still matches its fingerprint, else why not. */
export async function readCheckScript(id: string, file: string, expected: string): Promise<{ ok: true; path: string; text: string } | { ok: false; error: string }> {
  const path = join(checkScriptDir(id), file);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    return { ok: false, error: `script copy missing (${path}) — update or recreate the trigger` };
  }
  if (sha256(bytes) !== expected) return { ok: false, error: 'script copy changed outside somora — update the trigger to run a new version' };
  return { ok: true, path, text: bytes.toString('utf8') };
}

const stateCache = new Map<string, CheckState>();

export async function loadCheckState(id: string): Promise<CheckState | null> {
  const cached = stateCache.get(id);
  if (cached) return cached;
  try {
    const s = JSON.parse(await readFile(checkStatePath(id), 'utf8')) as CheckState;
    stateCache.set(id, s);
    return s;
  } catch {
    return null;
  }
}

/** Synchronous read of what is already loaded (the scheduler's pick). */
export function cachedCheckState(id: string): CheckState | undefined {
  return stateCache.get(id);
}

/** Drop what is in memory, so the next look reads the files — after
 *  triggers.json changed from another process (a tool in an MCP child
 *  may have replaced a trigger's script and reset its state). */
export function forgetCheckStates(): void {
  stateCache.clear();
}

export async function saveCheckState(state: CheckState): Promise<void> {
  stateCache.set(state.triggerId, state);
  const path = checkStatePath(state.triggerId);
  mkdirSync(join(sentinelDir(), 'check-state'), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Everything of a deleted trigger: copy, the script's folder, the state. */
export async function removeCheckFiles(id: string): Promise<void> {
  stateCache.delete(id);
  await rm(checkScriptDir(id), { recursive: true, force: true });
  await rm(checkStateDir(id), { recursive: true, force: true });
  await rm(checkStatePath(id), { force: true });
}

export function checkStateExists(id: string): boolean {
  return stateCache.has(id) || existsSync(checkStatePath(id));
}
