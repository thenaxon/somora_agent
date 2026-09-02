// Unit tests for file_search hit windowing + text budget.
//
// Run: npx tsx src/tools/file/search-window.test.mts

import assert from 'node:assert/strict';
import {
  applyTextBudget,
  byteOffsetToCharOffset,
  windowMatchLine,
  SEARCH_TEXT_BUDGET_CHARS,
  SEARCH_WINDOW_CHARS,
} from './search-window.ts';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${(err as Error).message}`);
  }
}

// ── short line unchanged ────────────────────────────────────────────
check('short line unchanged', () => {
  const r = windowMatchLine('hello world\n', [{ start: 6, end: 11, match: { text: 'world' } }]);
  assert.equal(r.text, 'hello world');
  assert.equal(r.col, 7);
  assert.equal(r.truncated, false);
});

check('line exactly at window size unchanged', () => {
  const line = 'x'.repeat(SEARCH_WINDOW_CHARS);
  const r = windowMatchLine(line, [{ start: 10, end: 11 }]);
  assert.equal(r.text, line);
  assert.equal(r.truncated, false);
});

// ── long line windowed with markers on both sides ───────────────────
check('long line windowed both sides', () => {
  const left = 'a'.repeat(5000);
  const right = 'b'.repeat(5000);
  const line = left + 'NEEDLE' + right;
  const r = windowMatchLine(line, [{ start: 5000, end: 5006, match: { text: 'NEEDLE' } }]);
  assert.equal(r.truncated, true);
  assert.equal(r.col, 5001);
  assert.ok(r.text.startsWith('…'), 'left marker');
  assert.ok(r.text.endsWith('…'), 'right marker');
  assert.equal(r.text, '…' + 'a'.repeat(200) + 'NEEDLE' + 'b'.repeat(200) + '…');
  assert.ok(r.text.length <= 3 * SEARCH_WINDOW_CHARS + 2 + 6);
});

check('custom windowChars respected', () => {
  const line = 'a'.repeat(100) + 'X' + 'b'.repeat(100);
  const r = windowMatchLine(line, [{ start: 100, end: 101 }], 10);
  assert.equal(r.text, '…' + 'a'.repeat(10) + 'X' + 'b'.repeat(10) + '…');
  assert.equal(r.col, 101);
});

// ── match at start → marker only on the right ───────────────────────
check('match at start, marker only right', () => {
  const line = 'NEEDLE' + 'z'.repeat(10_000);
  const r = windowMatchLine(line, [{ start: 0, end: 6 }]);
  assert.equal(r.truncated, true);
  assert.equal(r.col, 1);
  assert.ok(!r.text.startsWith('…'), 'no left marker');
  assert.ok(r.text.endsWith('…'), 'right marker');
  assert.equal(r.text, 'NEEDLE' + 'z'.repeat(200) + '…');
});

check('match at end, marker only left', () => {
  const line = 'z'.repeat(10_000) + 'NEEDLE';
  const r = windowMatchLine(line, [{ start: 10_000, end: 10_006 }]);
  assert.equal(r.truncated, true);
  assert.equal(r.col, 10_001);
  assert.ok(r.text.startsWith('…'));
  assert.ok(!r.text.endsWith('…'));
  assert.equal(r.text, '…' + 'z'.repeat(200) + 'NEEDLE');
});

// ── no submatches → window from start ───────────────────────────────
check('no submatches windows from start', () => {
  const line = 'q'.repeat(10_000);
  for (const sub of [undefined, null, []]) {
    const r = windowMatchLine(line, sub as never);
    assert.equal(r.col, 1);
    assert.equal(r.truncated, true);
    assert.equal(r.text, 'q'.repeat(200) + '…');
  }
});

// ── greedy match is bounded ─────────────────────────────────────────
check('huge match text itself is bounded', () => {
  const line = 'm'.repeat(30_000);
  const r = windowMatchLine(line, [{ start: 0, end: 30_000 }]);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 3 * SEARCH_WINDOW_CHARS + 2, `len ${r.text.length}`);
});

// ── multibyte near the cut does not throw ───────────────────────────
check('byte→char offset on multibyte text', () => {
  const t = 'äöü€😀x'; // ä=2 ö=2 ü=2 €=3 😀=4 x=1 bytes
  assert.equal(byteOffsetToCharOffset(t, 0), 0);
  assert.equal(byteOffsetToCharOffset(t, 2), 1);
  assert.equal(byteOffsetToCharOffset(t, 6), 3);
  assert.equal(byteOffsetToCharOffset(t, 9), 4); // start of 😀
  assert.equal(byteOffsetToCharOffset(t, 13), 6); // x (😀 is 2 UTF-16 units)
  assert.equal(byteOffsetToCharOffset(t, 11), 4); // inside 😀 → its start
  assert.equal(byteOffsetToCharOffset(t, 999), t.length);
});

check('multibyte chars around the cut do not throw', () => {
  const emoji = '😀🎉ü€';
  const line = emoji.repeat(2000) + 'NEEDLE' + emoji.repeat(2000);
  const bytesLeft = Buffer.byteLength(emoji.repeat(2000), 'utf8');
  const r = windowMatchLine(line, [{ start: bytesLeft, end: bytesLeft + 6 }]);
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes('NEEDLE'));
  assert.equal(r.col, emoji.repeat(2000).length + 1);
  // Nothing outrageous slipped through.
  assert.ok(r.text.length <= 3 * SEARCH_WINDOW_CHARS + 2 + 6);
});

check('byte offset past end clamps', () => {
  const r = windowMatchLine('short', [{ start: 500, end: 600 }]);
  assert.equal(r.text, 'short');
  assert.equal(r.col, 6);
  assert.equal(r.truncated, false);
});

check('trailing CRLF stripped', () => {
  const r = windowMatchLine('abc\r\n', [{ start: 1, end: 2 }]);
  assert.equal(r.text, 'abc');
});

// ── budget over a list of hits ──────────────────────────────────────
check('budget: everything fits', () => {
  const hits = Array.from({ length: 10 }, (_, i) => ({ text: 'x'.repeat(100), i }));
  const r = applyTextBudget(hits, 5000);
  assert.equal(r.hits.length, 10);
  assert.equal(r.truncated, false);
});

check('budget: cutoff drops the tail', () => {
  const hits = Array.from({ length: 10 }, (_, i) => ({ text: 'x'.repeat(100), i }));
  const r = applyTextBudget(hits, 350);
  assert.equal(r.hits.length, 3);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.hits.map((h) => h.i), [0, 1, 2]);
});

check('budget: first hit always admitted', () => {
  const r = applyTextBudget([{ text: 'x'.repeat(1000) }, { text: 'y' }], 10);
  assert.equal(r.hits.length, 1);
  assert.equal(r.truncated, true);
});

check('budget: default constant', () => {
  const hits = Array.from({ length: 600 }, () => ({ text: 'x'.repeat(200) }));
  const r = applyTextBudget(hits);
  assert.equal(r.hits.length, SEARCH_TEXT_BUDGET_CHARS / 200);
  assert.equal(r.truncated, true);
});

check('budget: empty list', () => {
  const r = applyTextBudget([]);
  assert.equal(r.hits.length, 0);
  assert.equal(r.truncated, false);
});

console.log(`search-window: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
