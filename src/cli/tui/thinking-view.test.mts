// Unit tests for the thinking-content text helpers used by the TUI
// (/verbose thinking): streaming tail + scrollback cap.
//
// Run: npx tsx src/cli/tui/thinking-view.test.mts

import assert from 'node:assert/strict';
import {
  THINKING_MAX_LINES,
  THINKING_TAIL_LINES,
  capLines,
  hiddenLinesMarker,
  tailLines,
} from './thinking-text.ts';

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

const numbered = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

// --- capLines -------------------------------------------------------

check('cap: short text unchanged', () => {
  const r = capLines('one\ntwo\nthree');
  assert.deepEqual(r.lines, ['one', 'two', 'three']);
  assert.equal(r.hidden, 0);
});

check('cap: exactly 40 lines is not capped', () => {
  const r = capLines(numbered(THINKING_MAX_LINES));
  assert.equal(r.lines.length, THINKING_MAX_LINES);
  assert.equal(r.hidden, 0);
});

check('cap: long text capped with correct remainder', () => {
  const r = capLines(numbered(137));
  assert.equal(r.lines.length, 40);
  assert.equal(r.lines[0], 'line 1');
  assert.equal(r.lines[39], 'line 40');
  assert.equal(r.hidden, 97);
  assert.equal(hiddenLinesMarker(r.hidden), '… (+97 lines)');
});

check('cap: custom max + singular marker', () => {
  const r = capLines(numbered(4), 3);
  assert.deepEqual(r.lines, ['line 1', 'line 2', 'line 3']);
  assert.equal(r.hidden, 1);
  assert.equal(hiddenLinesMarker(1), '… (+1 line)');
});

check('cap: empty text', () => {
  assert.deepEqual(capLines(''), { lines: [], hidden: 0 });
  assert.deepEqual(capLines('\n\n  \n'), { lines: [], hidden: 0 });
});

check('cap: trailing newline does not add an empty row', () => {
  const r = capLines('a\nb\n');
  assert.deepEqual(r.lines, ['a', 'b']);
});

// --- tailLines ------------------------------------------------------

check('tail: default is 6 lines', () => {
  assert.equal(THINKING_TAIL_LINES, 6);
  const t = tailLines(numbered(20));
  assert.deepEqual(t, ['line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20']);
});

check('tail: shorter than n returns everything', () => {
  assert.deepEqual(tailLines('a\nb', 6), ['a', 'b']);
});

check('tail: exactly n returns everything', () => {
  assert.deepEqual(tailLines(numbered(6)), numbered(6).split('\n'));
});

check('tail: empty text', () => {
  assert.deepEqual(tailLines(''), []);
  assert.deepEqual(tailLines('   \n'), []);
});

check('tail: trailing newline ignored (last real line kept)', () => {
  assert.deepEqual(tailLines('x\ny\nz\n', 2), ['y', 'z']);
});

check('tail: n <= 0 yields nothing', () => {
  assert.deepEqual(tailLines('a\nb', 0), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
