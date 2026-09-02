// Tests for dedupeNestedHits — nested-chunk collapse in hybridSearch (2026-09-01).
//
// Run: npx tsx src/memory/retrieval-dedupe.test.mts

import assert from 'node:assert/strict';

import { dedupeNestedHits, type Hit } from './retrieval.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

function hit(id: number, file: string, start: number, end: number, score: number): Hit {
  return {
    chunkId: id,
    filePath: file,
    source: 'wiki',
    slug: file,
    text: `${file}:${start}-${end}`,
    startLine: start,
    endLine: end,
    score,
    vecScore: 0,
    bm25Score: 0,
  };
}

// ── the live case: 35-60 ⊂ 35-68 and 17-18 ⊂ 17-33, same file ─────────
{
  const out = dedupeNestedHits([
    hit(6139, 'a.md', 35, 68, 1.39),
    hit(6138, 'a.md', 35, 60, 1.37),
    hit(6142, 'a.md', 87, 96, 0.81),
    hit(6135, 'a.md', 17, 18, 0.75),
    hit(6136, 'a.md', 17, 33, 0.73),
  ]);
  const ids = out.map((h) => h.chunkId);
  check('nested narrow chunks dropped', ids.length === 3, JSON.stringify(ids));
  check('wider 35-68 kept', ids.includes(6139));
  check('wider 17-33 kept even though it scored below its narrow twin', ids.includes(6136));
  check('narrow twins gone', !ids.includes(6138) && !ids.includes(6135));
  const wide = out.find((h) => h.chunkId === 6136)!;
  check('wider chunk inherits the better score', wide.score === 0.75, String(wide.score));
  check('output sorted by score desc', out.every((h, i) => i === 0 || h.score <= out[i - 1]!.score));
}

// ── partial overlap (deliberate paragraph overlap) is NOT collapsed ────
{
  const out = dedupeNestedHits([hit(1, 'b.md', 1, 40, 0.9), hit(2, 'b.md', 30, 70, 0.8)]);
  check('overlapping-but-not-nested chunks both kept', out.length === 2);
}

// ── same ranges in different files are unrelated ───────────────────────
{
  const out = dedupeNestedHits([hit(1, 'c.md', 1, 10, 0.9), hit(2, 'd.md', 1, 10, 0.8)]);
  check('different files never collapse', out.length === 2);
}

// ── identical range twice (old duplicate rows) → one survives ──────────
{
  const out = dedupeNestedHits([hit(1, 'e.md', 5, 9, 0.9), hit(2, 'e.md', 5, 9, 0.85)]);
  check('identical ranges collapse to the first (higher score)', out.length === 1 && out[0]!.chunkId === 1);
}

// ── empty input ────────────────────────────────────────────────────────
check('empty stays empty', dedupeNestedHits([]).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
