// Completed triggers are cleaned up on a timer of their own, not only
// when the scheduler happens to wake with nothing due (report
// 2026-11-05: with checks due every few minutes that never happened,
// and fired one-shots stayed until the next restart).
//
// Run: npm test src/sentinel/completed-sweep.test.mts
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETED_SWEEP_EVERY_MS, armCompletedSweep } from './scheduler.ts';

test('the sweep runs on its own interval and does not keep the process alive', async () => {
  let runs = 0;
  const timer = armCompletedSweep(30, async () => {
    runs++;
    return 0;
  });
  assert.equal(timer.hasRef(), false, 'unref: the server can exit while it waits');
  await new Promise((r) => setTimeout(r, 140));
  clearInterval(timer);
  assert.ok(runs >= 3, `ran ${runs} times`);
});

test('a failing sweep is logged and the next one still runs', async () => {
  let runs = 0;
  const timer = armCompletedSweep(30, async () => {
    runs++;
    throw new Error('disk gone');
  });
  await new Promise((r) => setTimeout(r, 110));
  clearInterval(timer);
  assert.ok(runs >= 2, `ran ${runs} times`);
});

test('every six hours, well inside the documented "at least once a day"', () => {
  assert.equal(COMPLETED_SWEEP_EVERY_MS, 6 * 3600_000);
});
