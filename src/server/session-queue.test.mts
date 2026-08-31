// Regression tests for taking a queued user turn back (2026-08-26
// request: edit a message while it still shows ⌛ queued).
//
// Run: npx tsx src/server/session-queue.test.mts

import assert from 'node:assert/strict';
import { acquireSessionLock, DequeuedError, dequeueSessionTurn } from './session-queue.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}
const tick = () => new Promise((r) => setTimeout(r, 5));

const A = 'agent-q';
const S = 'sess-1';

// Holder + two queued user turns + one agent turn behind them.
const release1 = await acquireSessionLock(A, S, { priority: 'user', turnId: 'u1' });
const queuedAhead: Array<{ turnId: string; ahead: number }> = [];
const p2 = acquireSessionLock(A, S, {
  priority: 'user',
  turnId: 'u2',
  onQueued: (ahead) => queuedAhead.push({ turnId: 'u2', ahead }),
});
const p3 = acquireSessionLock(A, S, {
  priority: 'user',
  turnId: 'u3',
  onQueued: (ahead) => queuedAhead.push({ turnId: 'u3', ahead }),
});
const pAgent = acquireSessionLock(A, S, { priority: 'agent', turnId: 'a1', callId: 'c' });
await tick();
check('u2 queued ahead=1, u3 ahead=2', JSON.stringify(queuedAhead) === '[{"turnId":"u2","ahead":1},{"turnId":"u3","ahead":2}]', JSON.stringify(queuedAhead));

// Unknown id → unknown.
check('unknown turn → unknown', dequeueSessionTurn(A, S, 'nope').status === 'unknown');
check('unknown session → unknown', dequeueSessionTurn(A, 'other', 'u2').status === 'unknown');

// The running holder can't be dequeued.
check('running holder → running', dequeueSessionTurn(A, S, 'u1').status === 'running');

// Agent (A2A) waiters are not the human's to take back.
check('agent waiter → unknown (not dequeueable)', dequeueSessionTurn(A, S, 'a1').status === 'unknown');

// Dequeue u2 → its acquire rejects with DequeuedError, u3 moves up.
let p2Err: unknown = null;
p2.catch((e) => {
  p2Err = e;
});
const out = dequeueSessionTurn(A, S, 'u2');
await tick();
check('u2 removed', out.status === 'removed');
check('remaining lists u3 at ahead=1', out.status === 'removed' && JSON.stringify(out.remaining) === '[{"turnId":"u3","ahead":1}]', JSON.stringify(out));
check('u2 waiter rejected with DequeuedError', p2Err instanceof DequeuedError && (p2Err as DequeuedError).turnId === 'u2', String(p2Err));

// Second dequeue of the same id → unknown (idempotent, no throw).
check('dequeue twice → unknown', dequeueSessionTurn(A, S, 'u2').status === 'unknown');

// Release the holder: u3 (not the dequeued u2) gets the lock next.
release1();
const release3 = await p3;
check('u3 acquired after release', typeof release3 === 'function');
check('u3 now running → dequeue says running', dequeueSessionTurn(A, S, 'u3').status === 'running');
release3();
const releaseAgent = await pAgent;
releaseAgent();

// Dequeue while the signal path is also armed: abort + dequeue don't
// double-reject or throw.
const ac = new AbortController();
const holder = await acquireSessionLock(A, S, { priority: 'user', turnId: 'h' });
const pd = acquireSessionLock(A, S, { priority: 'user', turnId: 'd', signal: ac.signal });
let pdErr: unknown = null;
pd.catch((e) => {
  pdErr = e;
});
check('signal-armed waiter dequeues', dequeueSessionTurn(A, S, 'd').status === 'removed');
ac.abort();
await tick();
check('rejected once, with DequeuedError', pdErr instanceof DequeuedError);
holder();

console.log(`session-queue: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
