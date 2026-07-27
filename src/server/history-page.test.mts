// Tests for same-ts-safe history pagination (Juni-Audit 2026-06,
// fixed 2026-07-27).
//
// Run: npx tsx src/server/history-page.test.mts

import assert from 'node:assert/strict';

import { paginateHistory } from './history-page.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const ev = (ts: number, id: string) => ({ ts, id });

/** Walk the cursor protocol like a client would and collect every event. */
function collectAll(all: Array<{ ts: number; id: string }>, limit: number): string[] {
  const seen: string[] = [];
  let before = Number.POSITIVE_INFINITY;
  for (let guard = 0; guard < 100; guard++) {
    const page = paginateHistory(all, limit, before);
    seen.unshift(...page.events.map((e) => e.id));
    if (!page.hasMore || page.oldestTs === null) break;
    before = page.oldestTs;
  }
  return seen;
}

// ── distinct timestamps behave exactly like the old code ─────────────
{
  const all = [ev(1, 'a'), ev(2, 'b'), ev(3, 'c'), ev(4, 'd'), ev(5, 'e')];
  const page = paginateHistory(all, 2, Number.POSITIVE_INFINITY);
  check('last N', page.events.map((e) => e.id).join('') === 'de');
  check('hasMore', page.hasMore);
  check('oldestTs', page.oldestTs === 4);
  check('walk complete distinct', collectAll(all, 2).join('') === 'abcde');
}

// ── THE bug: boundary inside a same-ts group ─────────────────────────
{
  // Three events share ts=2. With limit=2 the old code returned [x2,y3],
  // set before=2, and next page's `ts<2` skipped v2/w2 forever.
  const all = [ev(1, 'a'), ev(2, 'v'), ev(2, 'w'), ev(2, 'x'), ev(3, 'y')];
  const walked = collectAll(all, 2);
  check('no hole at same-ts boundary', walked.join('') === 'avwxy', walked.join(''));
}

// ── page extends over the group instead of splitting it ──────────────
{
  const all = [ev(1, 'a'), ev(2, 'v'), ev(2, 'w'), ev(2, 'x'), ev(3, 'y')];
  const page = paginateHistory(all, 2, Number.POSITIVE_INFINITY);
  check('group pulled in whole', page.events.map((e) => e.id).join('') === 'vwxy');
  check('hasMore still true', page.hasMore);
}

// ── group bigger than limit terminates ───────────────────────────────
{
  const all = [ev(5, 'a'), ev(5, 'b'), ev(5, 'c')];
  const page = paginateHistory(all, 1, Number.POSITIVE_INFINITY);
  check('oversized group returned whole', page.events.length === 3);
  check('oversized group no more', !page.hasMore);
  check('walk oversized', collectAll(all, 1).join('') === 'abc');
}

// ── empty + all-filtered edges ───────────────────────────────────────
{
  check('empty input', paginateHistory([], 10, Infinity).events.length === 0);
  const page = paginateHistory([ev(5, 'a')], 10, 5);
  check('all filtered', page.events.length === 0 && !page.hasMore && page.oldestTs === null);
}

// ── heavy same-ts interleaving (tool bursts) round-trips complete ────
{
  const all: Array<{ ts: number; id: string }> = [];
  let n = 0;
  for (let t = 1; t <= 10; t++) {
    const burst = (t % 3) + 1;
    for (let b = 0; b < burst; b++) all.push(ev(t, `e${n++}`));
  }
  for (const limit of [1, 2, 3, 5, 100]) {
    const walked = collectAll(all, limit);
    check(
      `burst walk complete (limit=${limit})`,
      walked.join(',') === all.map((e) => e.id).join(','),
      `got ${walked.length}/${all.length}`,
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
