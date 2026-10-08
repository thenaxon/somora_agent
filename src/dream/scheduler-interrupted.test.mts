// A dream run that a restart cut off is retried an hour after it
// started, at most twice in a row — not a whole interval later
// (2026-10-07: Lucid cut off at batch 15/41 waited a week).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERRUPTED_RETRY_MS,
  interruptedRetryDelay,
  nextDelayMs,
  STARTUP_GRACE_MS,
  wasInterrupted,
  type SchedulerState,
} from './scheduler-state.ts';

const H = 60 * 60_000;
const WEEK = 7 * 24 * H;
const T0 = 1_791_318_505_197; // the cut-off Lucid run of 2026-10-06
const state = (s: Partial<SchedulerState>): SchedulerState => ({
  lastStartedAt: null,
  lastCompletedAt: null,
  lastFailedAt: null,
  lastStatus: null,
  ...s,
});

test('a run with a start and no end after it was interrupted', () => {
  assert.equal(wasInterrupted(state({ lastStartedAt: T0, lastCompletedAt: T0 - WEEK })), true);
  assert.equal(wasInterrupted(state({ lastStartedAt: T0, lastCompletedAt: T0 + 1000 })), false, 'completed');
  assert.equal(wasInterrupted(state({ lastStartedAt: T0, lastFailedAt: T0 + 1000 })), false, 'failed');
  assert.equal(wasInterrupted(state({ lastCompletedAt: T0 })), false, 'never started');
});

test('the report case: restart 5 minutes in → retry an hour after the start', () => {
  const s = state({ lastStartedAt: T0, lastCompletedAt: T0 - WEEK });
  const r = interruptedRetryDelay(s, T0 + 5 * 60_000)!;
  assert.equal(r.nextDueAt, T0 + INTERRUPTED_RETRY_MS);
  assert.equal(r.attempt, 1);
  assert.equal(r.delayMs, 55 * 60_000);
  // before the fix the next run was a week out
  assert.equal(nextDelayMs(s, WEEK, T0 + 5 * 60_000).nextDueAt, T0 + WEEK);
});

test('a later restart does not push the retry further out', () => {
  const s = state({ lastStartedAt: T0, lastCompletedAt: T0 - WEEK });
  assert.equal(interruptedRetryDelay(s, T0 + 40 * 60_000)!.nextDueAt, T0 + H);
});

test('a restart long after the cut-off retries after the startup grace', () => {
  const s = state({ lastStartedAt: T0, lastCompletedAt: T0 - WEEK });
  const r = interruptedRetryDelay(s, T0 + 3 * H)!;
  assert.equal(r.delayMs, STARTUP_GRACE_MS);
});

test('two cut-off retries in a row → back to the regular cadence', () => {
  const now = T0 + 5 * 60_000;
  assert.equal(interruptedRetryDelay(state({ lastStartedAt: T0, interruptedRetries: 1 }), now)!.attempt, 2);
  assert.equal(interruptedRetryDelay(state({ lastStartedAt: T0, interruptedRetries: 2 }), now), null);
});

test('a run that ended is never retried', () => {
  assert.equal(interruptedRetryDelay(state({ lastStartedAt: T0, lastCompletedAt: T0 + 1, interruptedRetries: 1 }), T0 + 2), null);
});
