// Block markdown of a reply (2026-11-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply } from './blocks.ts';

const kinds = (text: string) => classifyReply(text.split('\n')).map((r) => r.kind);

test('fences hold code, even lines that look like markdown', () => {
  const rows = classifyReply(['```ts', '# not a heading', '- not a bullet', '```', 'after'].map(String));
  assert.deepEqual(rows.map((r) => r.kind), ['fence', 'code', 'code', 'fence', 'text']);
  assert.deepEqual(rows[0], { kind: 'fence', lang: 'ts', open: true });
});

test('headings, bullets, numbers, quotes, rules, blanks', () => {
  assert.deepEqual(kinds('## Title\n- one\n  * nested\n3. third\n> said\n---\n\nplain'), ['heading', 'bullet', 'bullet', 'bullet', 'quote', 'rule', 'blank', 'text']);
  const rows = classifyReply(['  * nested', '3. third']);
  assert.deepEqual(rows[0], { kind: 'bullet', text: 'nested', marker: '•', indent: 2 });
  assert.deepEqual(rows[1], { kind: 'bullet', text: 'third', marker: '3.', indent: 0 });
});

test('a table lines up its columns', () => {
  const rows = classifyReply(['| Model | Size |', '|---|---|', '| alpha | 70B |', '| b | 7 |']);
  assert.deepEqual(rows.map((r) => r.kind), ['table', 'table-rule', 'table', 'table']);
  const texts = rows.map((r) => ('text' in r ? r.text : ''));
  assert.equal(texts[0], 'Model │ Size');
  assert.equal(texts[2], 'alpha │ 70B ');
  assert.equal(texts[3], 'b     │ 7   ');
  assert.equal(texts[1], '──────┼─────');
  assert.equal(rows[0]!.kind === 'table' && rows[0]!.head, true);
});

test('an unclosed fence keeps the rest as code (streaming)', () => {
  assert.deepEqual(kinds('text\n```\ncode so far'), ['text', 'fence', 'code']);
});

test('a longer fence closes only with a run at least as long', () => {
  assert.deepEqual(kinds('````md\n```\ninner\n```\n````\nafter'), ['fence', 'code', 'code', 'code', 'fence', 'text']);
});

test('pipe text without a header separator is not a table', () => {
  assert.deepEqual(kinds('| a | b |\n| c | d |'), ['text', 'text']);
  assert.deepEqual(kinds('|---|---|'), ['text']);
});
