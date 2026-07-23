// Tests for dream scheduler-state anchoring (2026-07-23).
//
// Run: npx tsx src/dream/scheduler-state.test.mts
//
// Regression (Juni-Audit): after a FAILED Deep/Lucid run the worker keeps
// the old lastCompletedAt while writing a fresh lastFailedAt. The old
// completed-first anchor resolved to that stale completion → nextDelayMs
// read it as "overdue" → the heavy-LLM run re-fired every STARTUP_GRACE_MS
// (~60s), forever. Anchoring on the latest event fixes it.

import assert from 'node:assert/strict';

import { lastRelevantRunAt, nextDelayMs, STARTUP_GRACE_MS } from './scheduler-state.ts';
import type { SchedulerState } from './scheduler-state.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const HOUR = 3_600_000;
const INTERVAL = 12 * HOUR;
const NOW = 1_000_000_000_000; // fixed reference so tests are deterministic

const st = (p: Partial<SchedulerState>): SchedulerState => ({
  lastStartedAt: null,
  lastCompletedAt: null,
  lastFailedAt: null,
  lastStatus: null,
  ...p,
});

// ── lastRelevantRunAt picks the most recent event ─────────────────────
{
  check('null when nothing ran', lastRelevantRunAt(st({})) === null);
  check(
    'completed-only → completed',
    lastRelevantRunAt(st({ lastCompletedAt: NOW })) === NOW,
  );
  check(
    'crashed mid-run (started only) → started',
    lastRelevantRunAt(st({ lastStartedAt: NOW })) === NOW,
  );
  check(
    'recent failure beats old completion',
    lastRelevantRunAt(
      st({ lastCompletedAt: NOW - 24 * HOUR, lastStartedAt: NOW - 60_000, lastFailedAt: NOW - 60_000 }),
    ) === NOW - 60_000,
  );
}

// ── THE BUG: a failed run must NOT re-fire every 60s ──────────────────
{
  // Ran successfully a day ago, then a run started 1 min ago and failed.
  const failed = st({
    lastCompletedAt: NOW - 24 * HOUR,
    lastStartedAt: NOW - 60_000,
    lastFailedAt: NOW - 60_000,
    lastStatus: 'failed',
  });
  const d = nextDelayMs(failed, INTERVAL, NOW);
  check('failure does NOT read as overdue', d.reason === 'wait', d.reason);
  check('failure is NOT rescheduled at the 60s grace', d.delayMs !== STARTUP_GRACE_MS, `${d.delayMs}`);
  check(
    'failure backs off ~a full interval',
    d.delayMs > INTERVAL - 2 * 60_000 && d.delayMs <= INTERVAL,
    `${d.delayMs}`,
  );
}

// ── normal cadence unchanged ──────────────────────────────────────────
{
  // Completed exactly one interval ago → due now → overdue grace.
  const due = st({ lastCompletedAt: NOW - INTERVAL, lastStartedAt: NOW - INTERVAL, lastStatus: 'completed' });
  const d = nextDelayMs(due, INTERVAL, NOW);
  check('exactly-due completed run is overdue', d.reason === 'overdue', d.reason);
  check('overdue uses the startup grace', d.delayMs === STARTUP_GRACE_MS, `${d.delayMs}`);
}
{
  // Completed recently → wait the remaining interval.
  const recent = st({ lastCompletedAt: NOW - HOUR, lastStatus: 'completed' });
  const d = nextDelayMs(recent, INTERVAL, NOW);
  check('recent completion waits', d.reason === 'wait', d.reason);
  check('waits interval minus elapsed', d.delayMs === INTERVAL - HOUR, `${d.delayMs}`);
}
{
  // Fresh install (no state) → one full interval, no boot-time run.
  const d = nextDelayMs(st({}), INTERVAL, NOW);
  check('fresh install waits a full interval', d.reason === 'fresh' && d.delayMs === INTERVAL);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
