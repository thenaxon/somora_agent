// Process-wide MemoryManager cache. One manager per agent. Init is lazy
// (first reference triggers it) but the init promise is cached so concurrent
// turns for the same agent share one warmup.
//
// We don't pre-init at server startup because:
//   - the embedding model download (~30MB) happens on first init, blocking
//     server startup is bad UX
//   - some agents may never use memory (e.g. ad-hoc test agents)
// Trade-off: the first turn for a given agent eats the warmup cost.
// We DO pre-create the directory layout (ensureMemoryDirs) at startup so
// users can drop markdown files into memory/notes/ before chatting.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MemoryConfig, ObsidianConfig, WikiConfig } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { MemoryManager, type ObsidianSource, type WikiSource } from './manager.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

const cache = new Map<string, MemoryManager>();
const initPromises = new Map<string, Promise<MemoryManager>>();

export interface MemoryRegistryOptions {
  config: MemoryConfig;
  /** Server-global obsidian config. When undefined or no vault set, no
   *  vault is wired up — agents work with own memory only. */
  obsidian?: ObsidianConfig;
  /** Server-global wiki config. When undefined or .enabled false, no
   *  wiki source is wired up — even if a vault is configured. */
  wiki?: WikiConfig;
}

/** Resolve the server-global Obsidian source. Returns undefined when
 *  no vault is configured. Path expansion handles `~`. */
export function resolveObsidianSource(
  obsidianConfig: ObsidianConfig | undefined,
): ObsidianSource | undefined {
  const vault = obsidianConfig?.vault;
  if (!vault) return undefined;
  return { vaultPath: expandHome(vault) };
}

export function getMemoryManager(
  agent: string,
  opts: MemoryRegistryOptions,
): Promise<MemoryManager> {
  const existing = cache.get(agent);
  if (existing) return Promise.resolve(existing);
  const pending = initPromises.get(agent);
  if (pending) return pending;

  const p = (async () => {
    const obsidian = resolveObsidianSource(opts.obsidian);
    // Wiki layer only makes sense when both the wiki feature is on AND
    // a vault is configured. The absolute path is just <vault>/<subfolder>.
    const wiki: WikiSource | undefined = (() => {
      if (!opts.wiki?.enabled) return undefined;
      if (!obsidian?.vaultPath) return undefined;
      return { absPath: join(obsidian.vaultPath, opts.wiki.vaultSubfolder) };
    })();
    const searchBoosts = opts.wiki?.enabled
      ? {
          wiki: opts.wiki.search.boostWiki,
          memory: opts.wiki.search.boostMemory,
          vault: opts.wiki.search.boostVault,
        }
      : undefined;
    const mgr = new MemoryManager({
      agent,
      config: opts.config,
      ...(obsidian ? { obsidian } : {}),
      ...(wiki ? { wiki } : {}),
      ...(searchBoosts ? { searchBoosts } : {}),
    });
    try {
      await mgr.init();
    } catch (err) {
      logger.error({
        msg: 'memory.manager_init_failed',
        agent,
        err: (err as Error).message,
      });
      // Still cache it; init failures shouldn't be retried in tight loops
    }
    cache.set(agent, mgr);
    initPromises.delete(agent);
    return mgr;
  })();
  initPromises.set(agent, p);
  return p;
}

/**
 * Pre-create the memory directory layout for an agent. Cheap (idempotent
 * mkdir), no DB or embedder side effects. Call at server startup so the
 * user sees the structure and can drop files in before the first chat.
 */
export async function ensureMemoryDirs(agent: string): Promise<string> {
  const memoryRoot = join(SOMORA_HOME, 'agents', agent, 'memory');
  await mkdir(memoryRoot, { recursive: true });
  return memoryRoot;
}

export async function shutdownMemoryRegistry(): Promise<void> {
  const all = [...cache.values()];
  cache.clear();
  initPromises.clear();
  for (const m of all) {
    try {
      await m.close();
    } catch (err) {
      logger.warn({ msg: 'memory.close_failed', err: String(err) });
    }
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
