// The message a builder gets for rejected items (builder-review.ts).
//
// Run: npm test src/tools/agents/builder-review.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSendBack } from './builder-review.ts';
import { mergeBuilderAcceptance, applyReview } from '../../server/builder-acceptance.ts';

test('the send-back names each rejection and tells the builder to leave the other items as they are', () => {
  const m = composeSendBack('orderer', [{ id: 'A02', note: 'the test must also check the exit code' }]);
  assert.match(m, /^\[review\] orderer rejected 1 item\(s\) of your acceptance list:\n- A02: the test must also check the exit code/);
  assert.match(m, /Every other item goes as id and status only/);
});

test('following it keeps an acceptance: an accepted item sent as id + status keeps its review', () => {
  const items = mergeBuilderAcceptance([], [
    { id: 'A01', requirement: 'prints hello', status: 'passed', evidence: 'ran hello.py → hello' },
    { id: 'A02', requirement: 'test checks it', status: 'passed', evidence: 'test ok' },
  ], 1).items;
  const reviewed = applyReview(applyReview(items, { id: 'A01', verdict: 'accepted', by: 'orderer', note: 'ran it' }, 2)!, { id: 'A02', verdict: 'rejected', by: 'orderer', note: 'exit code' }, 3)!;
  const next = mergeBuilderAcceptance(reviewed, [{ id: 'A01', status: 'passed' }, { id: 'A02', status: 'passed', evidence: 'test now asserts returncode == 0' }], 4, { strict: true }).items;
  assert.equal(next[0]!.review?.verdict, 'accepted');
  assert.equal(next[1]!.review, undefined, 'new evidence clears the rejection');
});
