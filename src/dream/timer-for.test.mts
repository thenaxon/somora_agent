// Dream schedulers never hand setTimeout more than a day: above 2^31-1 ms
// Node fires after 1 ms, and Lucid with intervalDays: 30 ran in a loop
// (Fable review 2026-11-10 Nr. 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMER_MS, timerFor } from './scheduler-state.ts';

test('a long delay becomes a one-day recheck, a short one stays', () => {
  const day = 24 * 3600_000;
  assert.deepEqual(timerFor(30 * day), { ms: MAX_TIMER_MS, recheck: true });
  assert.deepEqual(timerFor(7 * day), { ms: MAX_TIMER_MS, recheck: true });
  assert.deepEqual(timerFor(5 * 3600_000), { ms: 5 * 3600_000, recheck: false });
  assert.ok(MAX_TIMER_MS < 2 ** 31 - 1);
});
