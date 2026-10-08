// Persistent scheduler state for dream workers.
//
// Before this module existed, `LucidWorker` and `DeepWorker` used
// `setInterval(intervalMs)` from worker-start, so the first auto-fire
// happened only after one full interval from server boot. Restart-
// starvation: any deployment that restarts more often than
// `wiki.lucid.intervalDays` (7d) or `wiki.deep.intervalHours` (12h)
// could go indefinitely without an automatic run.
//
// Fix: every fire writes `lastCompletedAt` / `lastFailedAt` to disk;
// every start reads it and schedules `setTimeout(nextDueAt - now)`
// with `nextDueAt = lastRelevantRunAt + intervalMs`. If due (or
// overdue) at startup, fire after a short grace window so MCP children
// and indexes can warm before the worker does heavy LLM I/O.
//
// File layout:
//   ~/.somora/dream-state/lucid.json
//   ~/.somora/dream-state/deep.json
//
// Shape:
//   { lastStartedAt, lastCompletedAt, lastFailedAt, lastStatus, interruptedRetries }
//
// All fields are unix-ms timestamps or null. Missing file is treated
// as "never run" — the worker bootstraps with lastCompletedAt = now
// so a fresh install does not immediately fire a heavy LLM consolidation
// during boot.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { SOMORA_HOME_DIR } from '../server/logger.ts';

export interface SchedulerState {
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastFailedAt: number | null;
  lastStatus: 'completed' | 'failed' | null;
  /** How many runs in a row were retries of a run a restart cut off.
   *  Reset by any run that ends (completed or failed). */
  interruptedRetries?: number;
}

const STATE_DIR = join(SOMORA_HOME_DIR, 'dream-state');

function statePath(worker: 'lucid' | 'deep'): string {
  return join(STATE_DIR, `${worker}.json`);
}

const EMPTY: SchedulerState = {
  lastStartedAt: null,
  lastCompletedAt: null,
  lastFailedAt: null,
  lastStatus: null,
};

export async function readSchedulerState(
  worker: 'lucid' | 'deep',
): Promise<SchedulerState> {
  try {
    const raw = await fs.readFile(statePath(worker), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SchedulerState>;
    return {
      lastStartedAt: typeof parsed.lastStartedAt === 'number' ? parsed.lastStartedAt : null,
      lastCompletedAt: typeof parsed.lastCompletedAt === 'number' ? parsed.lastCompletedAt : null,
      lastFailedAt: typeof parsed.lastFailedAt === 'number' ? parsed.lastFailedAt : null,
      lastStatus:
        parsed.lastStatus === 'completed' || parsed.lastStatus === 'failed'
          ? parsed.lastStatus
          : null,
      ...(typeof parsed.interruptedRetries === 'number' ? { interruptedRetries: parsed.interruptedRetries } : {}),
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeSchedulerState(
  worker: 'lucid' | 'deep',
  state: SchedulerState,
): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = `${statePath(worker)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, statePath(worker));
}

/** The reference timestamp used for `nextDueAt` computation: the most
 *  recent run event (attempt or completion), whichever is latest.
 *
 *  This must be the MAX, not a completed-first priority chain. On a
 *  failed run the worker records `lastFailedAt` (and `lastStartedAt`)
 *  but keeps the older `lastCompletedAt`; a completed-first anchor would
 *  resolve to that stale completion, `nextDelayMs` would read it as
 *  "overdue", and the heavy-LLM run would re-fire after only
 *  STARTUP_GRACE_MS — every ~60s, forever. Anchoring on the latest event
 *  instead spaces the retry after a failure by a full interval, and a
 *  worker that crashed mid-run (only `lastStartedAt`) still doesn't
 *  loop-fire on restart (Juni-Audit 2026-06). */
export function lastRelevantRunAt(state: SchedulerState): number | null {
  const candidates = [
    state.lastCompletedAt,
    state.lastStartedAt,
    state.lastFailedAt,
  ].filter((t): t is number => typeof t === 'number');
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/** Pick the actual delay for the next scheduler firing.
 *
 *  - First-ever start (no state): return `intervalMs` so a fresh
 *    install behaves like the pre-fix world — no surprise consolidation
 *    during the first server-boot.
 *  - State present, due now or overdue: return `STARTUP_GRACE_MS`
 *    instead of 0 so MCP children + indexes have time to warm.
 *  - State present, not yet due: return the remaining wait until
 *    `nextDueAt`.
 */
export const STARTUP_GRACE_MS = 60_000;

export function nextDelayMs(
  state: SchedulerState,
  intervalMs: number,
  now: number = Date.now(),
): { delayMs: number; nextDueAt: number; reason: 'fresh' | 'overdue' | 'wait' } {
  const last = lastRelevantRunAt(state);
  if (last === null) {
    return { delayMs: intervalMs, nextDueAt: now + intervalMs, reason: 'fresh' };
  }
  const nextDueAt = last + intervalMs;
  if (nextDueAt <= now) {
    return { delayMs: STARTUP_GRACE_MS, nextDueAt, reason: 'overdue' };
  }
  return { delayMs: nextDueAt - now, nextDueAt, reason: 'wait' };
}

/** A run that a restart cut off is retried this long after it started… */
export const INTERRUPTED_RETRY_MS = 60 * 60_000;
/** …at most this many times in a row; then the regular cadence applies. */
export const MAX_INTERRUPTED_RETRIES = 2;

/** True when the last run started and never ended: no completion or
 *  failure was recorded after its start, so the server stopped (restart,
 *  update, crash) while it ran. Only meaningful at startup, when no run
 *  of this worker is in flight. */
export function wasInterrupted(state: SchedulerState): boolean {
  if (state.lastStartedAt === null) return false;
  return state.lastStartedAt > (state.lastCompletedAt ?? 0) && state.lastStartedAt > (state.lastFailedAt ?? 0);
}

/** At startup: when the last run was cut off and retries are left, the
 *  delay until the retry — an hour after the cut-off run started (not
 *  after this restart, so a string of restarts cannot push it out
 *  forever), at least the startup grace. Null otherwise: the regular
 *  `nextDelayMs` applies, as it always did — a run that keeps getting
 *  cut off must not re-fire on every restart. */
export function interruptedRetryDelay(
  state: SchedulerState,
  now: number = Date.now(),
): { delayMs: number; nextDueAt: number; attempt: number } | null {
  if (!wasInterrupted(state)) return null;
  const done = state.interruptedRetries ?? 0;
  if (done >= MAX_INTERRUPTED_RETRIES) return null;
  const nextDueAt = Math.max(state.lastStartedAt! + INTERRUPTED_RETRY_MS, now + STARTUP_GRACE_MS);
  return { delayMs: nextDueAt - now, nextDueAt, attempt: done + 1 };
}
