// The acceptance list's rules (src/server/builder-acceptance.ts): the
// builder cannot narrow the list, cannot accept, and a changed status or
// evidence clears an earlier review. Plus where the list shows up: the
// order builder_dispatch sends, the session block, the gating.
//
// Run: npm test src/server/builder-acceptance.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReview, mergeBuilderAcceptance, openAcceptance, readAcceptance, renderAcceptanceTable, type AcceptanceItem } from './builder-acceptance.ts';
import { renderBuilderSessionBlock } from './builder-session.ts';
import { composeBuildOrder } from '../tools/agents/builder-dispatch.ts';
import { BUILDER_ONLY_TOOLS, BUILDER_TOOL_ALLOW, effectiveToolGating, isToolAllowed } from '../tools/gating.ts';

const T0 = 1_000;
const first = mergeBuilderAcceptance([], [
  { id: 'A01', requirement: 'A rejected result is never shown as completed', status: 'open' },
  { id: 'A02', requirement: 'Two analyses are compared by content', status: 'open' },
], T0).items;

test('new items need a requirement; statuses default to open', () => {
  const r = mergeBuilderAcceptance([], [{ id: 'A01', status: 'open' }, { id: 'A02', requirement: 'x' }], T0);
  assert.deepEqual(r.items.map((i) => i.id), ['A02']);
  assert.equal(r.items[0]!.status, 'open');
  assert.match(r.warnings.join(' '), /A01: a new item needs its requirement/);
});

test('an item left out stays, and says so', () => {
  const r = mergeBuilderAcceptance(first, [{ id: 'A01', status: 'passed', evidence: 'npm test: gate.test 3/3, rejected → status failed' }], T0 + 1);
  assert.deepEqual(r.items.map((i) => i.id), ['A01', 'A02']);
  assert.equal(r.items[1]!.status, 'open');
  assert.match(r.warnings.join(' '), /A02 cannot be removed/);
});

test('a reworded requirement keeps its first wording', () => {
  const r = mergeBuilderAcceptance(first, [
    { id: 'A01', requirement: 'Mostly works', status: 'open' },
    { id: 'A02', status: 'open' },
  ], T0 + 1);
  assert.equal(r.items[0]!.requirement, 'A rejected result is never shown as completed');
  assert.match(r.warnings.join(' '), /keeps its first wording/);
});

test('the builder cannot accept; unknown statuses are refused', () => {
  const r = mergeBuilderAcceptance(first, [
    { id: 'A01', status: 'accepted' },
    { id: 'A02', status: 'done' },
  ], T0 + 1);
  assert.equal(r.items[0]!.status, 'open');
  assert.equal(r.items[1]!.status, 'open');
  assert.match(r.warnings.join(' '), /A01: "accepted" is a review/);
  assert.match(r.warnings.join(' '), /A02: unknown status "done"/);
});

test('passed or failed without evidence is kept but warned about', () => {
  const r = mergeBuilderAcceptance(first, [{ id: 'A01', status: 'passed' }, { id: 'A02', status: 'not_run' }], T0 + 1);
  assert.equal(r.items[0]!.status, 'passed');
  assert.match(r.warnings.join(' '), /A01: passed without evidence/);
  assert.doesNotMatch(r.warnings.join(' '), /A02/);
});

test('a required list refuses passed or failed without evidence and not_run without a reason', () => {
  const withEvidence = mergeBuilderAcceptance(first, [{ id: 'A01', status: 'failed', evidence: 'gate.test: 90 vs 100 judged as agreement' }, { id: 'A02', status: 'open' }], T0 + 1).items;
  const r = mergeBuilderAcceptance(
    withEvidence,
    [
      { id: 'A01', status: 'passed' },
      { id: 'A02', status: 'not_run' },
      { id: 'A03', requirement: 'a new one', status: 'passed' },
    ],
    T0 + 2,
    { strict: true },
  );
  assert.equal(r.items[0]!.status, 'failed', 'A01 keeps its status');
  assert.equal(r.items[0]!.evidence, 'gate.test: 90 vs 100 judged as agreement', '… and its evidence');
  assert.equal(r.items[0]!.updatedAt, T0 + 1, 'nothing changed');
  assert.equal(r.items[1]!.status, 'open');
  assert.equal(r.items[2]!.status, 'open', 'a new item without evidence starts open');
  const w = r.warnings.join(' ');
  assert.match(w, /A01: refused — passed without evidence; it stays failed/);
  assert.match(w, /A02: refused — not_run without the reason; it stays open/);
  assert.match(w, /A03: refused — passed without evidence; it stays open/);
  const ok = mergeBuilderAcceptance(withEvidence, [{ id: 'A01', status: 'passed', evidence: 'gate.test 3/3' }, { id: 'A02', status: 'not_run', evidence: 'no staging host' }], T0 + 3, { strict: true });
  assert.deepEqual(ok.items.map((i) => i.status), ['passed', 'not_run']);
  assert.equal(ok.warnings.length, 0);
});

test('an item sent again without its evidence keeps the evidence and the review', () => {
  const withEvidence = mergeBuilderAcceptance(first, [{ id: 'A01', status: 'passed', evidence: 'gate.test 3/3' }, { id: 'A02', status: 'open' }], T0 + 1).items;
  const reviewed = applyReview(withEvidence, { id: 'A01', verdict: 'accepted', by: 'person' }, T0 + 2)!;
  for (const strict of [false, true]) {
    const r = mergeBuilderAcceptance(reviewed, [{ id: 'A01', status: 'passed' }, { id: 'A02', status: 'open' }], T0 + 3, { strict });
    assert.equal(r.items[0]!.evidence, 'gate.test 3/3');
    assert.equal(r.items[0]!.review?.verdict, 'accepted');
    assert.equal(r.items[0]!.updatedAt, T0 + 1);
    assert.equal(r.warnings.length, 0, `strict ${strict}: ${r.warnings.join(' ')}`);
  }
});

test('a review sticks while nothing changes, and is cleared by new evidence', () => {
  const withEvidence = mergeBuilderAcceptance(first, [
    { id: 'A01', status: 'passed', evidence: 'run 1' },
    { id: 'A02', status: 'open' },
  ], T0 + 1).items;
  const reviewed = applyReview(withEvidence, { id: 'A01', verdict: 'accepted', by: 'person', note: 'checked the job file' }, T0 + 2)!;
  assert.equal(reviewed[0]!.review?.verdict, 'accepted');
  // Same status and evidence: the review stays.
  const same = mergeBuilderAcceptance(reviewed, [{ id: 'A01', status: 'passed', evidence: 'run 1' }, { id: 'A02', status: 'open' }], T0 + 3).items;
  assert.equal(same[0]!.review?.verdict, 'accepted');
  assert.equal(same[0]!.updatedAt, T0 + 1);
  // New evidence: the review was of the old one.
  const changed = mergeBuilderAcceptance(same, [{ id: 'A01', status: 'passed', evidence: 'run 2' }, { id: 'A02', status: 'open' }], T0 + 4).items;
  assert.equal(changed[0]!.review, undefined);
  assert.equal(changed[0]!.updatedAt, T0 + 4);
  assert.equal(applyReview(changed, { id: 'A99', verdict: 'accepted', by: 'person' }), null, 'unknown id');
});

test('duplicates and the item cap', () => {
  const r = mergeBuilderAcceptance([], [{ id: 'A01', requirement: 'x', status: 'open' }, { id: 'A01', requirement: 'y', status: 'open' }]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.requirement, 'x');
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `A${i}`, requirement: 'r', status: 'open' }));
  assert.equal(mergeBuilderAcceptance([], many).items.length, 60);
});

test('reading, open items and the table', () => {
  const meta = { acceptance: first, acceptanceRequired: true };
  const acc = readAcceptance(meta);
  assert.equal(acc.required, true);
  assert.equal(openAcceptance(acc.items).length, 2);
  assert.deepEqual(readAcceptance({}), { items: [], required: false });
  const items: AcceptanceItem[] = [{ ...first[0]!, status: 'failed', evidence: 'a | b\nc', review: { verdict: 'rejected', by: 'person', note: 'no', at: 1 } }];
  const table = renderAcceptanceTable(items);
  assert.match(table, /^\| ID \| Requirement \| Status \| Evidence \| Review \|/);
  assert.match(table, /\| A01 \| A rejected result is never shown as completed \| failed \| a \\\| b c \| rejected \(person\): no \|/);
});

test('builder_dispatch orders the list; the plan phase writes it first', () => {
  const build = composeBuildOrder({ task: 'Build the gate.' });
  assert.match(build, /acceptance_write: one item per requirement of this order/);
  assert.match(build, /An item still open is not done/);
  const plan = composeBuildOrder({ task: 'Build the gate.', phase: 'plan' });
  assert.match(plan, /Write the acceptance list with acceptance_write now/);
});

test('the session block names the list only when it is required', () => {
  const state = { mode: 'unattended', phase: 'build', planPath: null, todos: [] } as const;
  assert.match(renderBuilderSessionBlock({ ...state, todos: [] }, { acceptanceRequired: true }), /Acceptance list: REQUIRED/);
  assert.doesNotMatch(renderBuilderSessionBlock({ ...state, todos: [] }, {}), /Acceptance list/);
});

test('acceptance_write is a builder tool; a chat agent never gets it', () => {
  assert.ok(BUILDER_ONLY_TOOLS.has('acceptance_write'));
  assert.ok(BUILDER_TOOL_ALLOW.includes('acceptance_write'));
  assert.equal(isToolAllowed('acceptance_write', 'builder', effectiveToolGating('chat', undefined)), false);
  assert.equal(isToolAllowed('todo_write', 'builder', effectiveToolGating('chat', undefined)), false, 'same as todo_write');
  assert.equal(isToolAllowed('acceptance_write', 'builder', effectiveToolGating('builder', undefined)), true);
});
