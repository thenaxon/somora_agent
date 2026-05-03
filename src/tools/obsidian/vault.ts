// Shared helpers for obsidian_* tools — vault discovery, path-sandbox,
// readOnlyPaths enforcement. Kept in its own file so the per-tool
// modules stay focused on their schema + handler.

import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { readObsidianConfigForAgent } from '../../memory/registry.ts';

export interface VaultBinding {
  vaultPath: string;
  readOnlyPaths: string[];
}

/**
 * Resolve agent → vault binding. Returns null if the agent has no
 * Obsidian vault configured. Tools use this for both `available()` and
 * the handler's first step.
 */
export async function resolveVault(agent: string): Promise<VaultBinding | null> {
  const cfg = await readObsidianConfigForAgent(agent);
  if (!cfg?.vaultPath) return null;
  return {
    vaultPath: cfg.vaultPath,
    readOnlyPaths: cfg.readOnlyPaths ?? [],
  };
}

/**
 * Translate a tool-input `path` (vault-relative, no leading slash, no
 * .. traversal) into an absolute filesystem path inside the vault.
 * Throws if the path escapes. Resolution is symbolic — we do NOT
 * call realpath here because the file may not exist yet (write mode
 * 'create'). Callers that need symlink-escape protection should
 * realpath the parent dir.
 */
export function resolveVaultRelative(vaultPath: string, relPath: string): string {
  if (!relPath || relPath.trim().length === 0) {
    throw new Error(`obsidian: path is empty`);
  }
  // Normalise once and reject anything that climbs out of the vault
  // BEFORE we touch the filesystem. join+normalize collapses `..`.
  const normalized = normalize(relPath);
  if (isAbsolute(normalized)) {
    throw new Error(`obsidian: absolute paths not allowed — use vault-relative '${relPath}'`);
  }
  if (normalized.split(sep).includes('..')) {
    throw new Error(`obsidian: path traversal not allowed — '${relPath}'`);
  }
  return resolve(vaultPath, normalized);
}

/**
 * Check that an absolute path is actually under the vault (post-realpath).
 * Use after a write/move target's parent dir has been realpath'd —
 * catches symlink shenanigans where `<vault>/foo` symlinks to `/etc/`.
 */
export async function assertInsideVault(vaultPath: string, absPath: string): Promise<void> {
  let realVault: string;
  try {
    realVault = await realpath(vaultPath);
  } catch (err) {
    throw new Error(`obsidian: vault path '${vaultPath}' is not accessible: ${(err as Error).message}`);
  }
  // For the target we realpath the closest existing ancestor, since the
  // file itself may not exist yet.
  let probe = absPath;
  let realProbe: string | null = null;
  while (probe.length > 0) {
    try {
      realProbe = await realpath(probe);
      break;
    } catch {
      const parent = resolve(probe, '..');
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (realProbe === null) {
    // Couldn't resolve any ancestor — treat as outside.
    throw new Error(`obsidian: cannot resolve any ancestor of '${absPath}'`);
  }
  // After realpath, the resolved ancestor must equal or descend from realVault.
  const real = realProbe + sep;
  const root = realVault + sep;
  if (!real.startsWith(root) && realProbe !== realVault) {
    throw new Error(
      `obsidian: path '${absPath}' resolves outside the vault (real: '${realProbe}', vault: '${realVault}')`,
    );
  }
}

/**
 * True if `relPath` falls inside any of the readOnlyPaths.
 * Match is by path-prefix on normalised paths — `Infrastruktur` matches
 * `Infrastruktur/foo.md` and `Infrastruktur` itself, but NOT
 * `InfrastrukturOther/`.
 */
export function isReadOnly(relPath: string, readOnlyPaths: string[]): string | null {
  if (readOnlyPaths.length === 0) return null;
  const normalized = normalize(relPath);
  for (const ro of readOnlyPaths) {
    const roNorm = normalize(ro).replace(/[/\\]+$/, '');
    if (normalized === roNorm) return ro;
    if (normalized.startsWith(roNorm + sep)) return ro;
  }
  return null;
}

/**
 * Convenience: turn an absolute path back into a vault-relative one for
 * logging / error messages.
 */
export function vaultRelative(vaultPath: string, absPath: string): string {
  if (!absPath.startsWith(vaultPath)) return absPath;
  return absPath.slice(vaultPath.length + 1).replace(/\\/g, '/');
}

/**
 * Walk the vault, returning every .md file's vault-relative path.
 * Used by obsidian_move's wikilink-rewrite step. Skips dot-dirs
 * (e.g. .trash, .obsidian) so we don't rewrite Obsidian's own state.
 */
export async function listMarkdownFiles(vaultPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = String(e.name);
      if (name.startsWith('.')) continue; // skip .trash, .obsidian, .git, etc.
      const childAbs = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (e.isFile() && name.toLowerCase().endsWith('.md')) {
        out.push(childRel);
      }
    }
  }
  await walk(vaultPath, '');
  return out;
}
