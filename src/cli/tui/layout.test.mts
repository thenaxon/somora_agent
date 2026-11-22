// The TUI's frame layout (2026-11-22): replies split into blocks that
// scroll away one by one, the status line fitted to one row, and which
// chat items have left the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellWidth, fitSegments, itemsAboveView, sessionLabel, splitReply } from './layout.ts';

test('a reply splits into its lines and joins back unchanged', () => {
  const text = 'first para\nstill first\n\n```ts\nconst a = 1;\n```\nlast';
  const lines = splitReply(text);
  assert.equal(lines.length, 7);
  assert.equal(lines.join('\n'), text);
  assert.deepEqual(splitReply(''), ['']);
});

test('a session id shows its slug, a plain name stays', () => {
  assert.equal(sessionLabel('20261122-133050_test-tui-focus'), 'test-tui-focus');
  assert.equal(sessionLabel('main'), 'main');
  assert.equal(sessionLabel('my-notes'), 'my-notes');
});

test('the status line drops the lowest priority first and keeps the order', () => {
  const seg = (key: string, plain: string, priority: number) => ({ key, plain, priority });
  const parts = [seg('brand', '🐨 somora', 1), seg('where', 'ada:main', 9), seg('model', 'qwen38next', 5), seg('dot', '●', 10)];
  assert.deepEqual(fitSegments(parts, 200).map((s) => s.key), ['brand', 'where', 'model', 'dot']);
  const narrow = fitSegments(parts, 30).map((s) => s.key);
  assert.deepEqual(narrow, ['where', 'model', 'dot']);
  assert.deepEqual(fitSegments(parts, 5).map((s) => s.key), ['dot']);
});

test('emoji count two cells', () => {
  assert.equal(cellWidth('🐨'), 2);
  assert.equal(cellWidth('ab'), 2);
});

test('an item moves to the scrollback as soon as its first row is above the frame', () => {
  // 3 items of 4 rows in a view of 6: 6 rows hidden → the first item
  // (fully) and the second (half) move; the third stays.
  assert.equal(itemsAboveView([4, 4, 4], 6), 2);
  assert.equal(itemsAboveView([4, 4, 4], 8), 1);
  assert.equal(itemsAboveView([4, 4, 4], 12), 0);
  assert.equal(itemsAboveView([4, 4, 4], 20), 0);
  // One row hidden of a tall item: it moves, nothing stays half above.
  assert.equal(itemsAboveView([5, 4], 8), 1);
});

test('multi-line entries explode into lines; one-liners and wakes stay whole', async () => {
  const { explodeTurn } = await import('./layout.ts');
  let n = 0;
  const id = () => `x${n++}`;
  const agent = explodeTurn({ kind: 'agent', id: 'a', text: 'one\ntwo\n\nfour' }, id);
  assert.deepEqual(agent.map((t) => t.kind === 'agent' && [t.text, t.cont === true]), [['one', false], ['two', true], ['', true], ['four', true]]);
  const sys = explodeTurn({ kind: 'system', id: 's', text: 'head\nrow 1\nrow 2', tone: 'warn' }, id);
  assert.equal(sys.length, 3);
  assert.equal(sys[0]!.kind === 'system' && sys[0]!.text, 'head');
  assert.deepEqual(sys[1], { kind: 'line', id: sys[1]!.id, text: 'row 1', indent: 2, color: 'yellow' });
  const user = explodeTurn({ kind: 'user', id: 'u', text: 'hi\nthere' }, id);
  assert.equal(user[1]!.kind === 'line' && user[1]!.indent, 6);
  const wake = explodeTurn({ kind: 'user', id: 'w', text: 'name: nightly\nmore', fromSystem: 'sentinel' }, id);
  assert.equal(wake.length, 1);
  assert.equal(explodeTurn({ kind: 'system', id: 'o', text: 'one line', tone: 'info' }, id).length, 1);
  const think = explodeTurn({ kind: 'thinking', id: 't', text: Array.from({ length: 50 }, (_, i) => `t${i}`).join('\n') }, id);
  assert.equal(think.length, 41); // 40 lines + the "+N lines" marker
  const marker = think[40]!;
  assert.equal(marker.kind === 'line' && /\+10/.test(marker.text), true);
});

test('a line wider than the screen is cut at spaces, a long word inside it', async () => {
  const { wrapLine, cellWidth: w } = await import('./layout.ts');
  assert.deepEqual(wrapLine('short', 20), ['short']);
  assert.deepEqual(wrapLine('', 20), ['']);
  const parts = wrapLine('the quick brown fox jumps over the lazy dog', 10);
  assert.ok(parts.every((p) => w(p) <= 10), JSON.stringify(parts));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), 'the quick brown fox jumps over the lazy dog');
  const word = wrapLine('x'.repeat(25), 10);
  assert.deepEqual(word, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  assert.ok(wrapLine('🐨'.repeat(8), 5).every((p) => w(p) <= 5));
});

test('a long reply line becomes several rows that scroll away one by one', async () => {
  const { explodeTurn } = await import('./layout.ts');
  let n = 0;
  const out = explodeTurn({ kind: 'agent', id: 'a', text: 'word '.repeat(60).trim() }, () => `y${n++}`, 40);
  assert.ok(out.length >= 8, String(out.length));
  assert.ok(out.slice(1).every((t) => t.kind === 'agent' && t.cont === true));
});
