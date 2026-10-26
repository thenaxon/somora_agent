// Judged checks with perItem: each item judged on its own, once, and
// seen only after its answer. Pure rules, no clock, no files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterItemDecisions, afterRun, initialCheckState, itemKey, itemsOf, manyItemsWarning, markSeen, SEEN_ITEMS_MAX, type CheckLimits, type ItemOutcome } from './check-logic.ts';
import type { CheckSource, CheckState, Evaluator } from './types.ts';
import type { CheckRunOutcome } from './check-runner.ts';

const limits: CheckLimits = { errorStreak: 3, maxWakesPerDay: 24, maxItemsPerCheck: 3 };
const t0 = new Date('2026-10-26T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const script = { file: 'check.py', lang: 'python' as const, sha256: 'x' };
const watch: CheckSource = { type: 'check', description: 'mail', interval: '5m', mode: 'watch', script };
const once: CheckSource = { type: 'check', description: 'mail', interval: '1m', mode: 'once', deadline: at(60).toISOString(), script };
const perItem: Evaluator = { type: 'decision', questions: {}, wake: { question: 'reply', minProbability: 0.8 }, perItem: true };
const whole: Evaluator = { type: 'decision', questions: {}, wake: { question: 'reply', minProbability: 0.8 } };
const ok = (data: unknown): CheckRunOutcome => ({ ok: true, answer: { data }, ms: 5, stderr: '' });
const mail = (id: string) => ({ id, from: `${id}@example.com`, subject: `about ${id}` });

function run(state: CheckState, data: unknown, source = watch, now = t0, evaluator = perItem) {
  return afterRun({ source, evaluator, state, run: ok(data), now, limits });
}
const yes = (p: number) => ({ ok: true as const, wake: p >= 0.8, question: 'reply', value: p, detail: 'probability of yes, wakes from 0.8' });
const answer = (items: Array<{ key: string; item: unknown }>, values: Record<string, number | 'fail'>): ItemOutcome[] =>
  items.map((i) => ({ ...i, outcome: values[i.key] === 'fail' ? { ok: false, error: 'unreachable' } : yes(values[i.key] as number) }));

test('items: a list, the one list in an object, or the data as one item; empty ones left out', () => {
  assert.equal(itemsOf([mail('a'), mail('b')]).length, 2);
  assert.equal(itemsOf({ mails: [mail('a'), {}, mail('b')], count: 2 }).length, 2);
  assert.equal(itemsOf({ subject: 'one thing' }).length, 1);
  assert.equal(itemsOf([]).length, 0);
  assert.equal(itemKey(mail('a')), 'id:a');
  assert.equal(itemKey({ uid: 7 }), 'uid:7');
  assert.equal(itemKey({ subject: 'x' }), itemKey({ subject: 'x' }));
  assert.notEqual(itemKey({ subject: 'x' }), itemKey({ subject: 'y' }));
});

test('watch: the first check knows the items, asks nobody; a new one is asked about alone', () => {
  const a = run(initialCheckState('t', t0), [mail('a'), mail('b')]);
  assert.equal(a.needItems, undefined);
  assert.equal(a.wake, undefined);
  assert.deepEqual(Object.keys(a.state.seenItems ?? {}).sort(), ['id:a', 'id:b']);
  // The script prints the recent mails again, plus one new.
  const b = run(a.state, [mail('c'), mail('a'), mail('b')], watch, at(5));
  assert.deepEqual(b.needItems?.items.map((i) => i.key), ['id:c']);
  assert.equal(b.needItems?.more, 0);
});

test('one answer per item; a wake carries only the items above the rule; all count as seen', () => {
  const a = run(initialCheckState('t', t0), []);
  const b = run(a.state, [mail('x'), mail('y'), mail('z')], watch, at(5));
  const step = afterItemDecisions({ source: watch, state: b.state, results: answer(b.needItems!.items, { 'id:x': 0.1, 'id:y': 0.93, 'id:z': 0.02 }), more: 0, now: at(5), limits });
  assert.equal(step.wake?.reason, 'decision');
  assert.deepEqual(step.wake?.data, [mail('y')]);
  assert.equal(step.state.last?.decision?.value, 0.93);
  assert.match(step.state.last?.decision?.detail ?? '', /3 items judged: 0\.1, 0\.93, 0\.02; 1 above the wake rule/);
  assert.match(step.judged ?? '', /wakes$/);
  assert.deepEqual(Object.keys(step.state.seenItems ?? {}).sort(), ['id:x', 'id:y', 'id:z']);
  // Next check, same mails: nobody is asked, nobody woken.
  const c = run(step.state, [mail('x'), mail('y'), mail('z')], watch, at(10));
  assert.equal(c.needItems, undefined);
  assert.equal(c.wake, undefined);
});

test('an item without an answer stays new and is asked about again; nobody answering is a check error', () => {
  const a = run(initialCheckState('t', t0), []);
  const b = run(a.state, [mail('x'), mail('y')], watch, at(5));
  const partly = afterItemDecisions({ source: watch, state: b.state, results: answer(b.needItems!.items, { 'id:x': 0.2, 'id:y': 'fail' }), more: 0, now: at(5), limits });
  assert.equal(partly.state.errorStreak, 0);
  assert.equal(partly.wake, undefined);
  assert.deepEqual(Object.keys(partly.state.seenItems ?? {}), ['id:x']);
  assert.match(partly.state.last?.decision?.detail ?? '', /1 not answered, asked again next check/);
  const again = run(partly.state, [mail('x'), mail('y')], watch, at(10));
  assert.deepEqual(again.needItems?.items.map((i) => i.key), ['id:y']);
  const none = afterItemDecisions({ source: watch, state: again.state, results: answer(again.needItems!.items, { 'id:y': 'fail' }), more: 0, now: at(10), limits });
  assert.equal(none.state.errorStreak, 1);
  assert.equal(none.state.last?.ok, false);
  assert.equal(none.state.seenItems?.['id:y'], undefined);
});

test('over maxItemsPerCheck the rest waits for the next check, nothing is lost', () => {
  const a = run(initialCheckState('t', t0), []);
  const five = ['1', '2', '3', '4', '5'].map(mail);
  const b = run(a.state, five, watch, at(5));
  assert.equal(b.needItems?.items.length, 3);
  assert.equal(b.needItems?.more, 2);
  const s = afterItemDecisions({ source: watch, state: b.state, results: answer(b.needItems!.items, { 'id:1': 0, 'id:2': 0, 'id:3': 0 }), more: 2, now: at(5), limits });
  assert.match(s.judged ?? '', /2 more new items next check/);
  const c = run(s.state, five, watch, at(10));
  assert.deepEqual(c.needItems?.items.map((i) => i.key), ['id:4', 'id:5']);
});

test('the same id twice in one output is asked about once', () => {
  const a = run(initialCheckState('t', t0), []);
  const b = run(a.state, [mail('d'), { ...mail('d'), subject: 'changed' }], watch, at(5));
  assert.equal(b.needItems?.items.length, 1);
});

test('notifyOnFirst: the first check judges the items it finds', () => {
  const b = run(initialCheckState('t', t0), [mail('a')], { ...watch, notifyOnFirst: true });
  assert.deepEqual(b.needItems?.items.map((i) => i.key), ['id:a']);
  assert.equal(b.state.baselineTaken, true);
});

test('once: the first item above the rule wakes and completes; past the deadline wakes once', () => {
  const b = run(initialCheckState('t', t0), [mail('a'), mail('b')], once);
  const s = afterItemDecisions({ source: once, state: b.state, results: answer(b.needItems!.items, { 'id:a': 0.5, 'id:b': 0.9 }), more: 0, now: t0, limits });
  assert.equal(s.wake?.reason, 'decision');
  assert.ok(s.complete);
  const late = run(s.state, [mail('a'), mail('b')], once, at(61));
  assert.equal(late.wake?.reason, 'deadline');
  assert.ok(late.complete);
});

test('without perItem a list of several items is judged as one, with a warning', () => {
  assert.match(manyItemsWarning([mail('a'), mail('b')]) ?? '', /list of 2 items, judged as one.*perItem: true/);
  assert.equal(manyItemsWarning([mail('a')]), undefined);
  assert.equal(manyItemsWarning({ text: 'x' }), undefined);
  const a = run(initialCheckState('t', t0), [], watch, t0, whole);
  const b = run(a.state, [mail('a'), mail('b')], watch, at(5), whole);
  assert.ok(b.needDecision);
  assert.match(b.state.last?.warning ?? '', /judged as one/);
});

test('the seen list stays bounded, newest kept', () => {
  let seen: Record<string, string> = {};
  for (let i = 0; i < SEEN_ITEMS_MAX + 10; i++) seen = markSeen(seen, [`k${i}`], new Date(t0.getTime() + i * 1000).toISOString());
  assert.equal(Object.keys(seen).length, SEEN_ITEMS_MAX);
  assert.equal(seen.k0, undefined);
  assert.ok(seen[`k${SEEN_ITEMS_MAX + 9}`]);
});
