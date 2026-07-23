// Tests for markdown chunking — oversized-paragraph handling (2026-07-23).
//
// Run: npx tsx src/memory/chunking.test.mts
//
// Regression (Juni-Audit): a paragraph larger than targetTokens was emitted
// as its own chunk, then carried forward as "overlap" — but buildOverlap
// returns the whole oversized paragraph, so the next paragraph immediately
// re-emitted it as a BYTE-IDENTICAL duplicate chunk AND glued the giant
// block onto the following chunk. Those duplicates pollute recall and crowd
// out real hits. Normal (sub-target) overlap must stay intact.

import assert from 'node:assert/strict';

import { chunkMarkdown } from './chunking.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ~4 chars/token. 2000 chars ≈ 500 tokens (> target 400).
const big = 'A'.repeat(2000);
const small = 'this is a short trailing paragraph';

// ── the bug: oversized paragraph must not duplicate or glue ────────────
{
  const chunks = chunkMarkdown(`${big}\n\n${small}`, { targetTokens: 400, overlapTokens: 80 });
  check('no spurious extra chunk (2, not 3)', chunks.length === 2, `${chunks.length}`);
  const texts = chunks.map((c) => c.text);
  check('no byte-identical duplicate chunk', new Set(texts).size === texts.length);
  check('oversized paragraph appears exactly once', texts.filter((t) => t === big).length === 1);
  check(
    'oversized block not glued onto the next chunk',
    !texts.some((t) => t.includes(big) && t.includes(small)),
    JSON.stringify(texts.map((t) => t.slice(0, 12))),
  );
  check('trailing paragraph is its own clean chunk', texts.some((t) => t === small));
}

// ── two oversized paragraphs in a row: each once, no dupes ─────────────
{
  const big2 = 'B'.repeat(2400);
  const chunks = chunkMarkdown(`${big}\n\n${big2}`, { targetTokens: 400, overlapTokens: 80 });
  const texts = chunks.map((c) => c.text);
  check('two oversized paras → two chunks', chunks.length === 2, `${chunks.length}`);
  check('each oversized para exactly once', texts.filter((t) => t === big).length === 1 && texts.filter((t) => t === big2).length === 1);
  check('no duplicates across the two', new Set(texts).size === 2);
}

// ── normal overlap is PRESERVED (the fix must not disable it) ──────────
{
  // Three ~200-token paragraphs (800 chars each). Packs 2-per-chunk at
  // target 400, so chunk boundaries produce a paragraph of overlap.
  const p1 = 'p1 ' + 'x'.repeat(797);
  const p2 = 'p2 ' + 'y'.repeat(797);
  const p3 = 'p3 ' + 'z'.repeat(797);
  const chunks = chunkMarkdown(`${p1}\n\n${p2}\n\n${p3}`, { targetTokens: 400, overlapTokens: 80 });
  check('normal packing produces >1 chunk', chunks.length >= 2, `${chunks.length}`);
  // The last paragraph of chunk 0 should reappear at the start of chunk 1.
  const c0 = chunks[0]!.text;
  const c1 = chunks[1]!.text;
  const overlapPresent = c1.startsWith('p2') && c0.includes('p2');
  check('overlap paragraph carried into next chunk', overlapPresent, `c0=${c0.slice(0,6)} c1=${c1.slice(0,6)}`);
  check('overlap did NOT duplicate a whole chunk', chunks[0]!.text !== chunks[1]!.text);
}

// ── all-small content: single chunk, unchanged behavior ───────────────
{
  const chunks = chunkMarkdown('just one short note', { targetTokens: 400, overlapTokens: 80 });
  check('short content → single chunk', chunks.length === 1, `${chunks.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
