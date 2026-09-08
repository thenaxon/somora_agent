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
import { SharedIndex, type SharedIndexStatus } from './shared-index.ts';

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
  /** Who this process is to the shared vault/wiki index. The server is
   *  the `owner` (builds, watches); the MCP tool child is a `reader`.
   *  Default owner. Fixed by the first call in a process. */
  sharedRole?: 'owner' | 'reader';
}

let shared: SharedIndex | null = null;

function wikiSourceFrom(opts: MemoryRegistryOptions, obsidian: ObsidianSource | undefined): WikiSource | undefined {
  // Wiki layer only makes sense when both the wiki feature is on AND
  // a vault is configured. The absolute path is just <vault>/<subfolder>.
  if (!opts.wiki?.enabled) return undefined;
  if (!obsidian?.vaultPath) return undefined;
  return { absPath: join(obsidian.vaultPath, opts.wiki.vaultSubfolder) };
}

function boostsFrom(opts: MemoryRegistryOptions): { wiki: number; memory: number; vault: number } | undefined {
  return opts.wiki?.enabled
    ? { wiki: opts.wiki.search.boostWiki, memory: opts.wiki.search.boostMemory, vault: opts.wiki.search.boostVault }
    : undefined;
}

/**
 * The process-wide shared index (vault + wiki). Created on first call;
 * `init()` resolves once the DB is open — the build, if any, continues
 * in the background and agent managers switch over when it is ready.
 * The server calls this at boot so the build starts before the first
 * turn; getMemoryManager() calls it too, so the MCP child and tests
 * need no extra wiring.
 */
export function getSharedIndex(opts: MemoryRegistryOptions): SharedIndex {
  if (!shared) {
    const obsidian = resolveObsidianSource(opts.obsidian);
    const wiki = wikiSourceFrom(opts, obsidian);
    const searchBoosts = boostsFrom(opts);
    shared = new SharedIndex({
      config: opts.config,
      ...(obsidian ? { obsidian } : {}),
      ...(wiki ? { wiki } : {}),
      ...(searchBoosts ? { searchBoosts } : {}),
      role: opts.sharedRole ?? 'owner',
    });
    void shared.init();
  }
  return shared;
}

export function sharedIndexStatus(): SharedIndexStatus | null {
  return shared ? shared.status() : null;
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
    const wiki = wikiSourceFrom(opts, obsidian);
    const searchBoosts = boostsFrom(opts);
    // The shared index must be OPEN (not necessarily ready) before the
    // first search, so its state is known rather than "not created yet".
    const idx = getSharedIndex(opts);
    await idx.init();
    const mgr = new MemoryManager({
      agent,
      config: opts.config,
      ...(obsidian ? { obsidian } : {}),
      ...(wiki ? { wiki } : {}),
      ...(searchBoosts ? { searchBoosts } : {}),
      indexVault: false,
      shared: () => shared,
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
  if (shared) {
    const idx = shared;
    shared = null;
    try {
      await idx.close();
    } catch (err) {
      logger.warn({ msg: 'memory.shared_index_close_failed', err: String(err) });
    }
  }
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
