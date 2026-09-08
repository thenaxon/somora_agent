// Auto-inject query construction: the current message decides, the
// history nudges (blendEmbeddings), and BM25 ignores filler words.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendEmbeddings, sanitizeFtsQuery, FTS_STOPWORDS } from './retrieval.ts';
import { buildRecallContext, historyWeightFor } from './inject.ts';
import type { NormalizedEvent } from '../types/events.ts';

const unit = (v: number[]): Float32Array => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / n));
};
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

test('blendEmbeddings: weight 0 or no context returns the query; blend is unit-length and leans to the query', () => {
  const q = unit([1, 0, 0, 0]);
  const c = unit([0, 1, 0, 0]);
  assert.equal(blendEmbeddings(q, null, 0.3), q);
  assert.equal(blendEmbeddings(q, c, 0), q);
  const b = blendEmbeddings(q, c, 0.3);
  assert.ok(Math.abs(dot(b, b) - 1) < 1e-6, 'unit length');
  assert.ok(dot(b, q) > dot(b, c), 'closer to the query than to the context');
  assert.ok(dot(b, c) > 0, 'but moved towards the context');
  // dimension mismatch → query untouched
  assert.equal(blendEmbeddings(q, unit([1, 1]), 0.3), q);
});

test('sanitizeFtsQuery drops filler words, keeps the term that matters, never returns empty for a real sentence', () => {
  const s = sanitizeFtsQuery('ok was kannst du mir über walter so erzählen?');
  assert.equal(s, '"walter"');
  // all stopwords → fall back to the unfiltered tokens rather than nothing
  const fallback = sanitizeFtsQuery('was war das?');
  assert.ok(fallback.length > 0);
  assert.ok(fallback.includes('"was"'));
  // english
  assert.equal(sanitizeFtsQuery('tell me about the pool terrace please'), '"pool" OR "terrace"');
  assert.ok(FTS_STOPWORDS.has('erzählen') && FTS_STOPWORDS.has('the'));
});

test('buildRecallContext takes the last turns, newest cut to the head, oldest first', () => {
  const ev = (kind: 'user_message' | 'assistant_message', text: string): NormalizedEvent =>
    ({ kind, ts: 0, engine: 't', text }) as NormalizedEvent;
  const history = [
    ev('user_message', 'first question about knx'),
    ev('assistant_message', 'answer one ' + 'x'.repeat(1000)),
    ev('user_message', 'second question about the pool'),
    ev('assistant_message', 'answer two ' + 'y'.repeat(1000)),
  ];
  const ctx = buildRecallContext(history, 3, 50);
  const parts = ctx.split('\n');
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'second question about the pool');
  assert.equal(parts[1]!.length, 50);
  assert.ok(parts[1]!.startsWith('answer two'));
  assert.equal(buildRecallContext([], 3, 50), '');
  assert.equal(buildRecallContext(history, 1, 50), '');
});

test('historyWeightFor: content words decide how much the history steers', () => {
  const cfg = { historyWeight: 0.3, historyWeightShort: 0.55, historyWeightEmpty: 0.8 };
  assert.equal(historyWeightFor('ok was kannst du mir über walter so erzählen?', cfg), 0.55); // one content word
  assert.equal(historyWeightFor('das solltest du aber wissen oder?', cfg), 0.8); // none
  assert.equal(historyWeightFor('wie ist der stand bei cerebrocraft und den medien für die expansion', cfg), 0.3);
  assert.equal(historyWeightFor('und seine frau?', cfg), 0.55);
});
