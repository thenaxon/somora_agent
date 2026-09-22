// Steering letterbox: order, drain, requeue, capability marks, frame.
// Run: npm test src/server/steer-inbox.test.mts (the runner sets a
// throwaway SOMORA_HOME so the logger never touches the live install)
import assert from 'node:assert/strict';
import {
  drainSteer,
  frameSteerMessage,
  markSteerable,
  pendingSteer,
  pushSteer,
  requeueSteer,
  steerableTurn,
  unmarkSteerable,
} from './steer-inbox.ts';

const human = { kind: 'human' as const, via: 'chat' as const };

// nothing steerable until a turn on a capable engine is marked
assert.equal(steerableTurn('a', 's'), null);
markSteerable('a', 's', 'grok-cli', 't1');
assert.equal(steerableTurn('a', 's'), null, 'grok-cli cannot steer');
markSteerable('a', 's', 'openai-compatible', 't1');
assert.deepEqual(steerableTurn('a', 's'), { engine: 'openai-compatible', turnId: 't1' });
// a stale unmark (another turn id) does not clear the live mark
unmarkSteerable('a', 's', 't0');
assert.ok(steerableTurn('a', 's'));
unmarkSteerable('a', 's', 't1');
assert.equal(steerableTurn('a', 's'), null);

// push → drain keeps order and empties the box
const m1 = pushSteer('a', 's', { text: 'first', origin: human });
const m2 = pushSteer('a', 's', { text: 'second', origin: human, from_agent: 'naxon', from_session: 'main' });
assert.equal(pendingSteer('a', 's'), 2);
assert.ok(m1.id && m1.ts);
const drained = drainSteer('a', 's');
assert.deepEqual(drained.map((m) => m.text), ['first', 'second']);
assert.equal(pendingSteer('a', 's'), 0);
assert.deepEqual(drainSteer('a', 's'), []);

// requeue puts messages in front of newer ones
pushSteer('a', 's', { text: 'third', origin: human });
requeueSteer('a', 's', [m2]);
assert.deepEqual(drainSteer('a', 's').map((m) => m.text), ['second', 'third']);

// sessions are independent
pushSteer('a', 'other', { text: 'x', origin: human });
assert.equal(pendingSteer('a', 's'), 0);
assert.equal(pendingSteer('a', 'other'), 1);

// the frame names who sent it and carries the text verbatim
assert.match(frameSteerMessage(m1), /Message from the user, sent while you were working/);
assert.ok(frameSteerMessage(m1).endsWith('\n\nfirst'));
assert.match(frameSteerMessage(m2), /Message from agent naxon \(session main\)/);
console.log('steer-inbox.test: ok');
