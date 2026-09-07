// Persona files for the web Agent window: read AGENTS.md / SOUL.md /
// USER.md (+ agent.yaml read-only) with content hashes and sizes, and
// write one of the editable three under an optimistic lock — the
// agents edit these files themselves (self-edit), so a human save must
// never silently overwrite what an agent wrote in between. Same
// backup discipline as team.yaml (last five kept).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateAgentsMd } from './loader.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const VALID_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const KEEP_BACKUPS = 5;

export const PERSONA_EDITABLE_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md'] as const;
export type PersonaEditableFile = (typeof PERSONA_EDITABLE_FILES)[number];
export const PERSONA_FILES = [...PERSONA_EDITABLE_FILES, 'agent.yaml'] as const;
export type PersonaFileName = (typeof PERSONA_FILES)[number];

export interface PersonaFileInfo {
  name: PersonaFileName;
  exists: boolean;
  content: string;
  /** sha1 of the content on disk; the write side's optimistic lock. */
  hash: string;
  chars: number;
  bytes: number;
  mtime: string | null;
  readOnly: boolean;
}

const hashOf = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);

export function agentDir(agent: string): string {
  if (!VALID_NAME.test(agent)) throw new Error(`invalid agent name '${agent}'`);
  return join(SOMORA_HOME, 'agents', agent);
}

export async function readPersonaFiles(agent: string): Promise<PersonaFileInfo[]> {
  const dir = agentDir(agent);
  const out: PersonaFileInfo[] = [];
  for (const name of PERSONA_FILES) {
    const path = join(dir, name);
    let content = '';
    let exists = false;
    let mtime: string | null = null;
    try {
      content = await readFile(path, 'utf8');
      exists = true;
      mtime = (await stat(path)).mtime.toISOString();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    out.push({
      name,
      exists,
      content,
      hash: hashOf(content),
      chars: content.length,
      bytes: Buffer.byteLength(content, 'utf8'),
      mtime,
      readOnly: name === 'agent.yaml',
    });
  }
  return out;
}

export type PersonaWriteResult =
  | { ok: true; hash: string; backup: string | null }
  | { ok: false; status: 400 | 404 | 409; error: string; currentHash?: string; currentContent?: string };

function rotateBackups(dir: string, name: string): void {
  const baks = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.bak-`))
    .sort();
  while (baks.length > KEEP_BACKUPS) {
    const victim = baks.shift()!;
    try {
      unlinkSync(join(dir, victim));
    } catch {
      /* best effort */
    }
  }
}

const ts = (): string =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

/**
 * Write one editable persona file. `baseHash` must equal the hash of the
 * content currently on disk (as served by readPersonaFiles); otherwise
 * the agent (or another client) changed it meanwhile → 409 with the
 * current content so the editor can reload. AGENTS.md must keep a
 * parseable frontmatter whose `name` (if set) matches the directory —
 * a persona that fails to load would take the agent offline.
 */
export async function writePersonaFile(
  agent: string,
  name: string,
  content: string,
  baseHash: string,
): Promise<PersonaWriteResult> {
  if (!(PERSONA_EDITABLE_FILES as readonly string[]).includes(name)) {
    return { ok: false, status: 400, error: `'${name}' is not editable here (AGENTS.md, SOUL.md, USER.md)` };
  }
  const dir = agentDir(agent);
  if (!existsSync(join(dir, 'AGENTS.md'))) return { ok: false, status: 404, error: `agent '${agent}' not found` };
  const path = join(dir, name);
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const currentHash = hashOf(current);
  if (currentHash !== baseHash) {
    return {
      ok: false,
      status: 409,
      error: `${name} changed on disk since you loaded it (the agent may have edited it) — reload and re-apply your change`,
      currentHash,
      currentContent: current,
    };
  }
  if (name === 'AGENTS.md') {
    if (content.trim().length === 0) return { ok: false, status: 400, error: 'AGENTS.md cannot be empty' };
    const v = validateAgentsMd(content, agent);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
  }
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.bak-${ts()}`;
    await copyFile(path, backup);
    rotateBackups(dir, name);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
  return { ok: true, hash: hashOf(content), backup };
}
