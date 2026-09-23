// A persona file is never overwritten without a backup.
//
// Agents may edit their own persona files and, by design, each other's
// (docs/agents.md); the web editor keeps the last five versions when a
// person saves. The file tools did not — a chat agent wrote one byte
// over another agent's AGENTS.md in the hardening test (2026-09-23) and
// the persona was gone. Rene's rule since then: a persona changes only
// with a backup. So file_write and file_patch copy the current file to
// `<file>.bak-<timestamp>` first (last five kept, like the editor).

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { logger } from '../../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
export const PERSONA_FILE_NAMES = ['AGENTS.md', 'SOUL.md', 'USER.md', 'VOICE.md', 'agent.yaml'] as const;
const KEEP = 5;

/** `{agent, file}` when `absolute` is a persona file of some agent. */
export function personaFileOf(absolute: string): { agent: string; file: string } | null {
  const root = normalize(join(SOMORA_HOME, 'agents')) + '/';
  const p = normalize(absolute);
  if (!p.startsWith(root)) return null;
  const rel = p.slice(root.length).split('/');
  if (rel.length !== 2) return null;
  const [agent, file] = rel as [string, string];
  return (PERSONA_FILE_NAMES as readonly string[]).includes(file) ? { agent, file } : null;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Copy an existing persona file aside before it is written; returns the
 *  backup path, or null when the file is not a persona file or does not
 *  exist yet. Keeps the last five backups. */
export async function backupPersonaFile(absolute: string, by: string): Promise<string | null> {
  const hit = personaFileOf(absolute);
  if (!hit || !existsSync(absolute)) return null;
  const backup = `${absolute}.bak-${stamp()}`;
  await copyFile(absolute, backup);
  const dir = dirname(absolute);
  const name = basename(absolute);
  const baks = readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.bak-`))
    .sort();
  while (baks.length > KEEP) {
    const victim = baks.shift()!;
    try {
      unlinkSync(join(dir, victim));
    } catch {
      /* already gone */
    }
  }
  logger.info({ msg: 'tool.persona_backup', file: absolute, backup, by });
  return backup;
}
