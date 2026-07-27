// Tests for session-queue turnId carry-through (Juni-Audit 2026-06,
// fixed 2026-07-27).
//
// Run: npx tsx src/server/session-queue.test.mts

import assert from 'node:assert/strict';

import { acquireSessionLock, listAllSessionLockStates } from './session-queue.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const state = () =>
  listAllSessionLockStates().find((s) => s.agent === 'tq-agent' && s.session === 'tq-session');

// First acquire — immediately granted, turnId visible.
const release1 = await acquireSessionLock('tq-agent', 'tq-session', {
  priority: 'user',
  turnId: 'turn-1',
});
check('immediate grant turnId', state()?.activeTurnId === 'turn-1');

// Second acquire queues behind the first.
let queuedAhead = -1;
const p2 = acquireSessionLock('tq-agent', 'tq-session', {
  priority: 'user',
  turnId: 'turn-2',
  onQueued: (ahead) => {
    queuedAhead = ahead;
  },
});
check('second is queued', queuedAhead === 1);
check('while queued, active is still turn-1', state()?.activeTurnId === 'turn-1');

// Handoff: release #1 → #2 becomes active WITH its turnId (was
// undefined before the fix — /health showed null for queued-then-run).
release1();
const release2 = await p2;
check('handoff carries turnId', state()?.activeTurnId === 'turn-2', String(state()?.activeTurnId));
check('handoff carries priority', state()?.activePriority === 'user');

release2();
check('after final release, idle', state()?.busy === false && state()?.activeTurnId === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
