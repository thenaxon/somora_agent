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

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';
import type { MemoryConfig } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { MemoryManager, type ObsidianSource } from './manager.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

const ObsidianYamlSchema = z
  .object({
    vault: z.string().min(1),
    readOnlyPaths: z.array(z.string()).optional(),
  })
  .passthrough();

const cache = new Map<string, MemoryManager>();
const initPromises = new Map<string, Promise<MemoryManager>>();

export interface MemoryRegistryOptions {
  config: MemoryConfig;
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
    const obsidian = await readObsidianConfigForAgent(agent);
    const mgr = new MemoryManager({ agent, config: opts.config, obsidian });
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

/**
 * Read agent.yaml's `obsidian:` section. Missing file or section → no
 * vault wired up. Path expansion handles ~.
 */
async function readObsidianConfigForAgent(agent: string): Promise<ObsidianSource | undefined> {
  const path = join(SOMORA_HOME, 'agents', agent, 'agent.yaml');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw) ?? {};
  } catch (err) {
    logger.warn({ msg: 'memory.agent_yaml_parse_failed', agent, err: (err as Error).message });
    return undefined;
  }
  if (typeof doc !== 'object' || doc === null) return undefined;
  const obsidianRaw = (doc as Record<string, unknown>).obsidian;
  if (!obsidianRaw) return undefined;
  const parsed = ObsidianYamlSchema.safeParse(obsidianRaw);
  if (!parsed.success) {
    logger.warn({ msg: 'memory.obsidian_config_invalid', agent, issues: parsed.error.issues });
    return undefined;
  }
  return {
    vaultPath: expandHome(parsed.data.vault),
    readOnlyPaths: parsed.data.readOnlyPaths,
  };
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
