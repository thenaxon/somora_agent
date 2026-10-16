// The vault — and the wiki inside it — is read-only for an agent that
// does not dream (agent.yaml `dreams: false`, private/dream-switch/
// KONZEPT.md). Checked for file_write and file_patch next to the path
// blacklist, on the path as given and on its resolved real path, so a
// symlink into the vault does not get around it. The shell can still
// write there; docs/security.md says so.

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import type { Config } from '../../config/types.ts';
import { loadPersona } from '../../persona/loader.ts';

function isUnder(path: string, root: string): boolean {
  const r = normalize(root).replace(/[\\/]+$/, '');
  const p = normalize(path);
  return p === r || p.startsWith(r + sep);
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export async function enforceVaultReadOnly(args: { paths: string[]; agent: string; config: Config }): Promise<void> {
  const vault = args.config.obsidian?.vault;
  if (!vault) return;
  const root = expandHome(vault);
  const roots = [root, await realpath(root).catch(() => root)];
  if (!args.paths.some((p) => roots.some((r) => isUnder(p, r)))) return;
  const persona = await loadPersona(args.agent);
  if (persona && !persona.dreams) {
    throw new Error(
      `the vault and the wiki are read-only for ${args.agent}: it does not dream (dreams: false in its agent.yaml). ` +
        'Reading and searching them works; to write, keep it in your own memory (memory_write) or a workspace file.',
    );
  }
}
