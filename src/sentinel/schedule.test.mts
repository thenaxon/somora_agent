// Tests for sentinel schedule math (2026-07-23).
//
// Run: npx tsx src/sentinel/schedule.test.mts
//
// Covers two Juni-Audit fixes:
//   #6 'every' triggers drifted by the agent-turn duration because the
//      next fire was anchored on `now` (turn-END) instead of prev-fire +
//      interval. computeNextFire now takes an anchor.
//   #5 daily-cap auto-pause was permanent; the resume boundary uses the
//      same UTC-day edge as the fire count (isDailyCapResumeDue).

import assert from 'node:assert/strict';

import {
  computeNextFire,
  utcDayStr,
  utcMidnightAfter,
  isDailyCapResumeDue,
} from './schedule.ts';
import type { TimeSpec } from './types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const every = (interval: string): TimeSpec => ({ type: 'every', interval } as TimeSpec);

// ── #6: 'every' anti-drift ────────────────────────────────────────────
{
  const interval = every('30m');
  const MS = 30 * 60_000;
  const anchor = new Date('2026-07-23T10:00:00.000Z');

  // The turn finished 2 minutes late; WITHOUT an anchor the next fire is
  // now+30m (drifted). WITH the anchor it is prev-fire+30m exactly.
  const now = new Date(anchor.getTime() + 2 * 60_000); // 10:02
  const drifted = computeNextFire(interval, now); // no anchor
  const fixed = computeNextFire(interval, now, anchor);
  check('no-anchor still drifts (now+interval)', drifted!.getTime() === now.getTime() + MS);
  check(
    'anchored fire is prev-fire + interval (10:30, not 10:32)',
    fixed!.getTime() === anchor.getTime() + MS,
    fixed!.toISOString(),
  );
  check('drift avoided is exactly the turn duration', drifted!.getTime() - fixed!.getTime() === 2 * 60_000);
}

// ── #6: repeated cycles do not accumulate drift ───────────────────────
{
  const interval = every('1h');
  const HR = 3_600_000;
  let anchor = new Date('2026-07-23T00:00:00.000Z');
  // Simulate 5 fires, each turn taking 90s. Anchor is always the prior
  // SCHEDULED fire, so the schedule stays on :00:00 forever.
  for (let i = 0; i < 5; i++) {
    const now = new Date(anchor.getTime() + 90_000); // 90s turn
    const next = computeNextFire(interval, now, anchor)!;
    check(`cycle ${i}: lands on the hour`, next.getTime() === anchor.getTime() + HR, next.toISOString());
    anchor = next;
  }
}

// ── #6: catch-up when the anchor is far in the past (no burst) ────────
{
  const interval = every('10m');
  const MS = 10 * 60_000;
  const anchor = new Date('2026-07-23T10:00:00.000Z');
  // 35 minutes elapsed (server was busy/down) → next slot must be in the
  // FUTURE, not a past instant, and aligned to the interval grid.
  const now = new Date(anchor.getTime() + 35 * 60_000); // 10:35
  const next = computeNextFire(interval, now, anchor)!;
  check('catch-up lands in the future', next.getTime() > now.getTime());
  check('catch-up aligned to grid (10:40)', next.getTime() === anchor.getTime() + 4 * MS, next.toISOString());
}

// ── #6: at/daily unaffected by an anchor ──────────────────────────────
{
  const at: TimeSpec = { type: 'at', iso: '2099-01-01T00:00:00.000Z' } as TimeSpec;
  const anchor = new Date('2026-01-01T00:00:00.000Z');
  const withAnchor = computeNextFire(at, new Date('2026-07-23T00:00:00Z'), anchor);
  check('at ignores anchor', withAnchor!.toISOString() === '2099-01-01T00:00:00.000Z');
}

// ── #5: UTC-day helpers + resume boundary ─────────────────────────────
{
  check('utcDayStr is UTC calendar day', utcDayStr(new Date('2026-07-23T23:59:59Z')) === '2026-07-23');
  check(
    'utcDayStr rolls at UTC midnight',
    utcDayStr(new Date('2026-07-24T00:00:00Z')) === '2026-07-24',
  );
  check(
    'utcMidnightAfter is next UTC 00:00',
    utcMidnightAfter(new Date('2026-07-23T15:00:00Z')) === new Date('2026-07-24T00:00:00Z').getTime(),
  );

  // Paused today → NOT yet due; paused yesterday → due.
  const now = new Date('2026-07-24T09:00:00Z');
  check('same UTC day → not due', isDailyCapResumeDue('2026-07-24', now) === false);
  check('previous UTC day → due', isDailyCapResumeDue('2026-07-23', now) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
