// Persistent trigger registry + fire-history storage.
//
// Layout under SOMORA_HOME (default ~/.somora):
//
//   sentinel/
//     triggers.json                ← all active+paused+error+completed triggers
//     history/<trigger-id>.jsonl   ← ring-buffered fire log per trigger
//
// One JSON file for the registry — keeps mental model simple ("here are
// my triggers"), git-friendly when SOMORA_HOME is under version control,
// and trivial to back up. Migrations to a real DB are a future story
// if 200+ triggers becomes common — we'd notice via slow load times.
//
// Per-trigger history is JSONL (append-only on fire, rotate-on-read)
// so a runaway trigger can't OOM us via giant arrays in the registry
// JSON. History is bounded to HISTORY_RING_SIZE entries; older rows
// are pruned next-write.

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, appendFile, readdir, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';
import type { Trigger, FireHistoryEntry } from './types.ts';
import { SENTINEL_LIMITS } from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const SENTINEL_DIR = join(SOMORA_HOME, 'sentinel');
const TRIGGERS_PATH = join(SENTINEL_DIR, 'triggers.json');
const HISTORY_DIR = join(SENTINEL_DIR, 'history');

function ensureDirs(): void {
  if (!existsSync(SENTINEL_DIR)) mkdirSync(SENTINEL_DIR, { recursive: true });
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
}

interface Registry {
  triggers: Record<string, Trigger>;
}

// In-memory cache. The store is the source of truth on disk; we
// reload from disk whenever an external mutator might have touched
// it (currently no other writer exists, but the pattern keeps us
// honest if/when sentinel gains a CLI).
let cache: Registry | null = null;

async function readRegistryFromDisk(): Promise<Registry> {
  if (!existsSync(TRIGGERS_PATH)) return { triggers: {} };
  try {
    const raw = await readFile(TRIGGERS_PATH, 'utf8');
    if (!raw.trim()) return { triggers: {} };
    return JSON.parse(raw) as Registry;
  } catch (err) {
    logger.warn({
      msg: 'sentinel.store.read_failed',
      path: TRIGGERS_PATH,
      err: (err as Error).message,
      hint: 'starting with empty registry; corrupt file kept for inspection',
    });
    return { triggers: {} };
  }
}

async function writeRegistryToDisk(reg: Registry): Promise<void> {
  ensureDirs();
  const tmp = `${TRIGGERS_PATH}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
  await rename(tmp, TRIGGERS_PATH);
}

/** Load triggers into the in-memory cache. Idempotent — call at boot
 *  and after any external-edit window. */
export async function loadTriggers(): Promise<void> {
  cache = await readRegistryFromDisk();
}

/** Return all triggers as a plain array. Reads from cache; call
 *  loadTriggers() to refresh from disk first if needed. */
export function listTriggers(): Trigger[] {
  if (!cache) cache = { triggers: {} };
  return Object.values(cache.triggers);
}

/** Return a specific trigger by id, or null. */
export function getTrigger(id: string): Trigger | null {
  if (!cache) cache = { triggers: {} };
  return cache.triggers[id] ?? null;
}

/** Insert or replace a trigger. Persists to disk before returning. */
export async function saveTrigger(t: Trigger): Promise<void> {
  if (!cache) cache = { triggers: {} };
  cache.triggers[t.id] = t;
  await writeRegistryToDisk(cache);
}

/** Delete a trigger AND its history file. Idempotent. */
export async function deleteTrigger(id: string): Promise<boolean> {
  if (!cache) cache = { triggers: {} };
  if (!cache.triggers[id]) return false;
  delete cache.triggers[id];
  await writeRegistryToDisk(cache);
  try {
    await unlink(join(HISTORY_DIR, `${id}.jsonl`));
  } catch {
    // History never written or already gone — fine.
  }
  return true;
}

/** Count active triggers owned by an agent. Used to enforce the per-
 *  agent cap before allowing a new create. */
export function countTriggersByAgent(agent: string): number {
  return listTriggers().filter((t) => t.ownerAgent === agent).length;
}

// ─────────────────────────────────────────────────────────────────────
// History (per-trigger JSONL ring)
// ─────────────────────────────────────────────────────────────────────

function historyPath(triggerId: string): string {
  return join(HISTORY_DIR, `${triggerId}.jsonl`);
}

/** Append a fire entry to the trigger's history. Caps to ring-size
 *  by rewriting the file when it exceeds the limit by a margin (so
 *  we don't rewrite on every single append). */
export async function recordFire(triggerId: string, entry: FireHistoryEntry): Promise<void> {
  ensureDirs();
  await appendFile(historyPath(triggerId), `${JSON.stringify(entry)}\n`, 'utf8');
  // Cheap rotation check: if the file's line count is over 2× the
  // ring size, rewrite keeping the last RING_SIZE entries.
  try {
    const raw = await readFile(historyPath(triggerId), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > SENTINEL_LIMITS.HISTORY_RING_SIZE * 2) {
      const kept = lines.slice(-SENTINEL_LIMITS.HISTORY_RING_SIZE).join('\n') + '\n';
      const tmp = `${historyPath(triggerId)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
      await writeFile(tmp, kept, 'utf8');
      await rename(tmp, historyPath(triggerId));
    }
  } catch {
    // Read-for-rotation failed (raced rotation?) — next call retries.
  }
}

/** Read up to `limit` newest history entries for a trigger. */
export async function getHistory(triggerId: string, limit: number = 50): Promise<FireHistoryEntry[]> {
  try {
    const raw = await readFile(historyPath(triggerId), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const entries: FireHistoryEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line) as FireHistoryEntry); } catch { /* skip bad */ }
    }
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/** Count fires today (UTC). Used to enforce per-day cap. */
export async function countFiresToday(triggerId: string): Promise<number> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const history = await getHistory(triggerId, SENTINEL_LIMITS.MAX_FIRES_PER_DAY + 50);
  return history.filter((h) =>
    new Date(h.firedAt).getTime() >= todayStart.getTime() && h.outcome !== 'skipped'
  ).length;
}
