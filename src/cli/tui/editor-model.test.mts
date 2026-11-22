// The TUI input's edits (2026-11-22): grapheme-safe, multi-line, pastes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './editor-model.ts';

const at = (text: string, cursor = text.length): E.EditorState => ({ text, cursor });

test('Backspace removes a whole emoji, flag or ZWJ family', () => {
  for (const g of ['😀', '🇦🇹', '👩‍👩‍👧', 'é']) {
    assert.deepEqual(E.backspace(at(`ab${g}`)), at('ab'));
  }
});

test('left and right step over a grapheme, delete removes one', () => {
  const s = at('a😀b', 0);
  const r1 = E.right(s);
  const r2 = E.right(r1);
  assert.equal(r1.cursor, 1);
  assert.equal(r2.cursor, 3);
  assert.deepEqual(E.deleteForward(r1), at('ab', 1));
  assert.equal(E.left(r2).cursor, 1);
});

test('insert puts text at the cursor', () => {
  assert.deepEqual(E.insert(at('ac', 1), 'b'), at('abc', 2));
});

test('home and end act on the cursor line', () => {
  const s = at('one\ntwo three', 6);
  assert.equal(E.home(s).cursor, 4);
  assert.equal(E.end(s).cursor, 13);
});

test('words: move and delete', () => {
  const s = at('hello big world');
  assert.equal(E.wordLeft(s).cursor, 10);
  assert.deepEqual(E.deleteWordBack(s), at('hello big ', 10));
  assert.equal(E.wordRight(at('hello big world', 0)).cursor, 5);
});

test('Ctrl+U and Ctrl+K cut to the line edges', () => {
  assert.deepEqual(E.killToLineStart(at('a\nhello', 5)), at('a\nlo', 2));
  assert.deepEqual(E.killToLineEnd(at('a\nhello', 4)), at('a\nhe', 4));
});

test('up and down move between lines and keep the column', () => {
  const s = at('abcdef\nxy\nlonger line', 4);
  const down = E.vertical(s, 1);
  assert.equal(down.cursor, 9); // end of "xy"
  const down2 = E.vertical(down, 1);
  assert.equal(E.position(down2).line, 2);
  assert.equal(E.vertical(s, -1), s); // already on the first line
  assert.deepEqual(E.position(at('a\nbc', 3)), { line: 1, column: 1, lines: 2 });
});

test('a typed chunk ending in CR sends; CRs inside are new lines', () => {
  assert.deepEqual(E.splitTypedChunk('hello\r'), { text: 'hello', submit: true });
  assert.deepEqual(E.splitTypedChunk('l1\rl2\r'), { text: 'l1\nl2', submit: true });
  assert.deepEqual(E.splitTypedChunk('abc'), { text: 'abc', submit: false });
  assert.deepEqual(E.splitTypedChunk('\n'), { text: '\n', submit: false });
});

test('a long paste stands in as a marker and comes back on send', () => {
  const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const marker = E.pasteMarker(1, big);
  assert.equal(marker, '[paste #1 · 20 lines]');
  const typed = `look at this: ${marker} ok?`;
  assert.equal(E.expandPastes(typed, new Map([[marker, big]])), `look at this: ${big} ok?`);
  assert.equal(E.normalizePaste('a\r\nb\rc'), 'a\nb\nc');
});

test('control characters are dropped from typed text', () => {
  assert.equal(E.stripControls('a\u0007b\u001bc'), 'abc');
  assert.equal(E.stripControls('a\nb\tc'), 'a\nb\tc');
});

test('Ctrl+R finds the newest match, then older ones', () => {
  const h = ['git status', 'deploy now', 'git push', 'hello'];
  assert.equal(E.searchHistory(h, 'git'), 2);
  assert.equal(E.searchHistory(h, 'git', 1), 0);
  assert.equal(E.searchHistory(h, 'GIT'), 2);
  assert.equal(E.searchHistory(h, 'nothing'), -1);
  assert.equal(E.searchHistory(h, ''), 3);
  assert.equal(E.searchHistory([], 'x'), -1);
});

test('word moves keep a letter and its combining accent together', () => {
  const text = 'café au lait';
  const r = E.wordRight(at(text, 0));
  assert.equal(r.cursor, 5); // after "café" including the accent
  assert.equal(E.wordLeft(at(text, 5)).cursor, 0);
});

test('Home at the very start of a draft that begins with a new line stays', () => {
  assert.equal(E.home(at('\nabc', 0)).cursor, 0);
  assert.deepEqual(E.killToLineStart(at('\nabc', 0)), at('\nabc', 0));
});
