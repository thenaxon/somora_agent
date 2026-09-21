// Hash-Cache for Deep skip-decisions.
//
// Memory files that Deep skipped (Opus said: transient, duplicate,
// too thin) get a cache entry keyed by their body-hash. On the next
// Deep run, files whose hash matches the cached entry are skipped
// without an LLM call — saves opus tokens and runtime when the user
// adds memory between runs but most existing files haven't changed.
//
// Cache invalidates automatically:
// - Memory body changed → hash mismatch → re-evaluate
// - The skip is older than `wiki.deep.skipCacheDays` (default 30) →
//   re-evaluate. A skip is a verdict against the wiki of THAT day: a
//   note that was "too thin for a page of its own" belongs on the page
//   that has been created since. Until 2026-09-21 a skip stood forever,
//   and such notes sat in the inbox for good.
// - Memory file deleted (promote/merge or manual rm) → entry pruned
//   on next loadCache (lazy cleanup, no harm if it sticks around)
//
// Storage: ~/.somora/agents/<agent>/memory/.deep-skip-cache.json.
// Dotfile prefix keeps it out of the markdown-walker's path.
//
// Single-writer assumption: Deep is reentrancy-guarded, so concurrent
// writes to the cache file shouldn't happen. If they do, last-writer-
// wins is fine — worst case is one extra LLM call next run.
//
// See `private/dream-system-v2.md` § "Stufe v2.4".

import { createHash } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { logger } from '../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const CACHE_FILE = '.deep-skip-cache.json';

export interface CacheEntry {
  /** sha256 of the memory body, first 16 hex chars. Stable, content-only. */
  hash: string;
  /** ISO timestamp when the skip was recorded. */
  skipped_at: string;
  /** Opus's reason for the skip — surfaced in logs when the cache hits. */
  reason: string;
}

export type Cache = Record<string, CacheEntry>;

export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function cachePath(agent: string): string {
  return join(SOMORA_HOME, 'agents', agent, 'memory', CACHE_FILE);
}

/** Load cache for an agent. Returns empty cache if missing or corrupt.
 *  Opportunistic cleanup: drops entries whose memory file no longer
 *  exists. The cleanup-write is best-effort — failure logs but
 *  doesn't propagate. */
export async function loadCache(agent: string): Promise<Cache> {
  const path = cachePath(agent);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    logger.warn({
      msg: 'dream.deep.skip_cache.read_failed',
      agent,
      err: (err as Error).message,
    });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({
      msg: 'dream.deep.skip_cache.parse_failed',
      agent,
      err: (err as Error).message,
      hint: 'starting with empty cache; old file will be overwritten',
    });
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const cache = parsed as Cache;

  // Opportunistic cleanup: drop entries for files that don't exist anymore.
  const memoryDir = join(SOMORA_HOME, 'agents', agent, 'memory');
  const slugs = Object.keys(cache);
  let pruned = 0;
  for (const slug of slugs) {
    try {
      await stat(join(memoryDir, `${slug}.md`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        delete cache[slug];
        pruned++;
      }
    }
  }
  if (pruned > 0) {
    logger.debug({ msg: 'dream.deep.skip_cache.pruned_stale', agent, pruned });
    // Best-effort write; if it fails, next loadCache will re-prune.
    void saveCache(agent, cache).catch(() => {});
  }
  return cache;
}

export async function saveCache(agent: string, cache: Cache): Promise<void> {
  const path = cachePath(agent);
  try {
    await writeFile(path, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    logger.warn({
      msg: 'dream.deep.skip_cache.write_failed',
      agent,
      err: (err as Error).message,
    });
  }
}

/**
 * The cached skip for this note, if it still stands: same body, and not
 * older than `maxAgeDays` (0 = no expiry).
 *
 * Expiry is spread out per note — up to a quarter of the period later,
 * derived from the slug — because skips are recorded in batches: forty
 * notes skipped in one run would otherwise all come due in the same run
 * a month later, forty LLM calls at once.
 */
export function isCachedSkip(
  cache: Cache,
  slug: string,
  body: string,
  maxAgeDays = 0,
  now: number = Date.now(),
): CacheEntry | null {
  const entry = cache[slug];
  if (!entry) return null;
  if (entry.hash !== bodyHash(body)) return null;
  if (maxAgeDays > 0) {
    const skippedAt = Date.parse(entry.skipped_at);
    if (!Number.isFinite(skippedAt)) return null; // unreadable date → look again
    const spread = (parseInt(createHash('sha256').update(slug).digest('hex').slice(0, 4), 16) / 0xffff) * 0.25;
    const limitMs = maxAgeDays * (1 + spread) * 86_400_000;
    if (now - skippedAt > limitMs) return null;
  }
  return entry;
}

/** Same body, but the skip has outlived `maxAgeDays` — due for another
 *  look. The runner rations these per run (see deep-runner.ts). */
export function isExpiredSkip(cache: Cache, slug: string, body: string, maxAgeDays: number, now: number = Date.now()): CacheEntry | null {
  if (maxAgeDays <= 0) return null;
  const standsForever = isCachedSkip(cache, slug, body, 0, now);
  if (!standsForever) return null;
  return isCachedSkip(cache, slug, body, maxAgeDays, now) ? null : standsForever;
}

/** Update cache entry after a skip. Mutates the cache; caller is
 *  responsible for calling saveCache once per run. */
export function recordSkip(
  cache: Cache,
  slug: string,
  body: string,
  reason: string,
): void {
  cache[slug] = {
    hash: bodyHash(body),
    skipped_at: new Date().toISOString(),
    reason,
  };
}

/** Drop a slug from the cache (called when promote/merge consumed
 *  the memory file — entry is now stale). Mutates; caller saves. */
export function clearSlug(cache: Cache, slug: string): void {
  delete cache[slug];
}

/** Wipe the cache for an agent. Used by `force=true` runs. */
export async function clearCache(agent: string): Promise<void> {
  const path = cachePath(agent);
  try {
    await unlink(path);
    logger.info({ msg: 'dream.deep.skip_cache.cleared', agent });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({
        msg: 'dream.deep.skip_cache.clear_failed',
        agent,
        err: (err as Error).message,
      });
    }
  }
}
