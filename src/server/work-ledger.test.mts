// The work ledger (private/turn-dispatch-phase2-design.md §1): one book
// for every piece of work, one wake, take-back for any waiter with the
// permission rule Rene set (a person: anything; an agent: its own).
//
// Run: npx tsx src/server/work-ledger.test.mts

import assert from 'node:assert/strict';

import { registerChatAbort } from './chat-aborts.ts';
import type { ChatTurnResult } from './run-turn-types.ts';
import { acquireSessionLock, DequeuedError, getSessionLockStatus, listSessionWaiters } from './session-queue.ts';
import {
  _resetWorkLedger,
  cancelWork,
  configureWorkWake,
  dequeueWork,
  failWork,
  finishWork,
  getWork,
  listWork,
  markFetched,
  markRunning,
  onWorkFinished,
  openWork,
  pendingWakesFor,
  REMOVED_BY_USER,
  setWaiting,
  wakeTextFor,
  waitForWork,
} from './work-ledger.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (text: string): ChatTurnResult =>
  ({ finalText: text, outcome: 'completed', tool_calls: 0, contextWindow: 1, provider: 'p', model: 'm', thinkingActive: false, ms: 1 }) as ChatTurnResult;
const failed = (err: string): ChatTurnResult => ({ ...ok(''), outcome: 'failed', error: err }) as ChatTurnResult;

const wakes: Array<{ agent: string; session: string; about: string; ref: string; depth: number; text: string; prefix: string }> = [];
configureWorkWake({
  graceMs: 30,
  dispatchWakeTurn: async (w) => {
    wakes.push(w);
  },
});

// ── 1. lifecycle + preview ────────────────────────────────────────────
{
  _resetWorkLedger();
  const it = openWork({
    id: 'c1',
    origin: { kind: 'agent', from: { agent: 'hans', session: 'main' }, callId: 'c1' },
    target: { agent: 'lisa', session: 'main' },
    requester: { agent: 'hans', session: 'main' },
    text: 'What   is\n\nthe   state of the world? ' + 'x'.repeat(300),
  });
  check('opens queued', it.state === 'queued' && it.waiting === true && it.wake === 'auto');
  check('preview collapses whitespace and caps at 160', it.preview.startsWith('What is the state of the world?') && it.preview.length === 160);
  check('text kept while waiting', typeof getWork('c1')?.text === 'string');
  markRunning('c1', 'turn-1');
  check('running with turn id, text dropped', getWork('c1')?.state === 'running' && getWork('c1')?.turnId === 'turn-1' && getWork('c1')?.text === undefined);
  finishWork('c1', ok('42'));
  check('done', getWork('c1')?.state === 'done' && getWork('c1')?.finishedAt !== undefined);
  finishWork('c1', failed('late'));
  check('terminal stays terminal', getWork('c1')?.state === 'done');
  openWork({ id: 'c2', origin: { kind: 'agent', from: { agent: 'hans' }, callId: 'c2' }, target: { agent: 'lisa', session: 'main' }, text: 'q' });
  finishWork('c2', failed('boom'));
  check('result.error → failed with error', getWork('c2')?.state === 'failed' && getWork('c2')?.error === 'boom');
  openWork({ id: 'c3', origin: { kind: 'agent', from: { agent: 'hans' }, callId: 'c3' }, target: { agent: 'lisa', session: 'main' }, text: 'q' });
  failWork('c3', 'persona missing');
  check('failWork', getWork('c3')?.state === 'failed' && getWork('c3')?.error === 'persona missing');
}

// ── 2. one wake: every condition, negated one at a time ──────────────
{
  _resetWorkLedger();
  wakes.length = 0;
  const base = (id: string, extra: Partial<Parameters<typeof openWork>[0]> = {}) =>
    openWork({
      id,
      origin: { kind: 'agent', from: { agent: 'hans', session: 'main' }, callId: id },
      target: { agent: 'lisa', session: 'main' },
      requester: { agent: 'hans', session: 'main' },
      text: 'q',
      ...extra,
    });
  base('w-ok');
  setWaiting('w-ok', false);
  finishWork('w-ok', ok('answer text'));

  base('w-waiting'); // still on the line
  finishWork('w-waiting', ok('a'));

  base('w-fetched');
  setWaiting('w-fetched', false);
  finishWork('w-fetched', ok('a'));
  markFetched('w-fetched');

  base('w-never', { wake: 'never' });
  setWaiting('w-never', false);
  finishWork('w-never', ok('a'));

  base('w-nosession', { requester: { agent: 'hans', session: '?' } });
  setWaiting('w-nosession', false);
  finishWork('w-nosession', ok('a'));

  base('w-human', { requester: { human: true } });
  setWaiting('w-human', false);
  finishWork('w-human', ok('a'));

  base('w-failed');
  setWaiting('w-failed', false);
  finishWork('w-failed', failed('engine down'));

  check('pending wake listed before it fires', pendingWakesFor({ agent: 'hans', session: 'main' }).map((i) => i.id).sort().join(',') === 'w-failed,w-ok');
  await delay(80);
  const woke = wakes.map((w) => w.ref).sort();
  check('woke exactly the hung-up, unfetched, auto items (done and failed)', woke.join(',') === 'w-failed,w-ok', woke.join(','));
  check('wake carries about a2a + requester session', wakes.every((w) => w.about === 'a2a' && w.agent === 'hans' && w.session === 'main'));
  check('wake text is the a2a record line with the head; the fetch hint rides beside it', wakes.find((w) => w.ref === 'w-ok')?.text.includes('[agent answer] lisa has answered') === true && wakes.find((w) => w.ref === 'w-ok')?.text.includes('answer text') === true && wakes.find((w) => w.ref === 'w-ok')?.prefix.includes('agent_ask_result') === true);
  check('nothing pending after firing', pendingWakesFor({ agent: 'hans', session: 'main' }).length === 0);
}

// ── 3. sub-agent wake carries depth; sentinel never wakes ───────────
{
  _resetWorkLedger();
  wakes.length = 0;
  openWork({
    id: 'task_a',
    origin: { kind: 'subagent', taskId: 'task_a', depth: 2, parent: { agent: 'hans', session: 'sub-1' } },
    target: { agent: 'hans', session: 'sub-2' },
    requester: { agent: 'hans', session: 'sub-1' },
    text: 'brief',
    waiting: false,
    parentDepth: 1,
    running: true,
  });
  finishWork('task_a', { ...ok('hello'), files_written: ['/tmp/x'] } as ChatTurnResult);
  openWork({
    id: 'task_s',
    origin: { kind: 'sentinel', triggerId: 'tr', taskId: 'task_s' },
    target: { agent: 'hans', session: 'main' },
    requester: { agent: 'sentinel', session: 'tr' },
    text: 'fire',
    waiting: false,
    wake: 'never',
    running: true,
  });
  finishWork('task_s', ok('pong'));
  await delay(80);
  check('sub wake with depth 1 and about subagent', wakes.length === 1 && wakes[0]!.about === 'subagent' && wakes[0]!.depth === 1 && wakes[0]!.ref === 'task_a');
  check('sub wake text names task and files; the fetch hint rides beside it', wakes[0]!.text.includes("Task 'task_a'") && wakes[0]!.text.includes('Files written (1)') && !wakes[0]!.text.includes('subagent_result') && wakes[0]!.prefix.includes('subagent_result'));
  check('wakeTextFor: override wins', wakeTextFor({ ...getWork('task_a')!, wakeText: 'custom', wakePrefix: 'do' }).text === 'custom' && wakeTextFor({ ...getWork('task_a')!, wakeText: 'custom', wakePrefix: 'do' }).prefix === 'do');
}

// ── 4. dequeue: permissions + the real lock waiter ──────────────────
{
  _resetWorkLedger();
  const A = 'lisa';
  const S = 'sess-dq';
  const holder = await acquireSessionLock(A, S, { priority: 'user', turnId: 'h1', workId: 'h1' });
  openWork({ id: 'h1', origin: { kind: 'human', via: 'chat' }, target: { agent: A, session: S }, requester: { human: true }, text: 'first' });
  markRunning('h1', 'h1');
  openWork({ id: 'ask-1', origin: { kind: 'agent', from: { agent: 'hans', session: 'main' }, callId: 'ask-1' }, target: { agent: A, session: S }, requester: { agent: 'hans', session: 'main' }, text: 'second' });
  let rejected: unknown = null;
  const waiter = acquireSessionLock(A, S, { priority: 'agent', callId: 'ask-1', workId: 'ask-1' }).catch((e) => {
    rejected = e;
  });
  openWork({ id: 'ask-2', origin: { kind: 'agent', from: { agent: 'naxon', session: 'main' }, callId: 'ask-2' }, target: { agent: A, session: S }, requester: { agent: 'naxon', session: 'main' }, text: 'third' });
  const waiter2 = acquireSessionLock(A, S, { priority: 'agent', callId: 'ask-2', workId: 'ask-2' });
  await delay(5);
  const listed = listSessionWaiters(A, S);
  check('waiters listed in order with work ids', listed.map((w) => w.workId).join(',') === 'ask-1,ask-2' && listed[0]!.position === 1);

  check('agent may not remove another agent\'s item', dequeueWork('ask-1', { agent: 'naxon' }).status === 'forbidden');
  check('running item cannot be dequeued', dequeueWork('h1', 'human').status === 'running');
  const out = dequeueWork('ask-1', 'human');
  check('human removes any waiter', out.status === 'removed');
  await waiter;
  check('waiter rejected with DequeuedError', rejected instanceof DequeuedError);
  check('item reads dequeued with the reason', getWork('ask-1')?.state === 'dequeued' && getWork('ask-1')?.error === REMOVED_BY_USER);
  check('queue shrank', getSessionLockStatus(A, S).queueLength === 1);
  check('agent removes its own item', dequeueWork('ask-2', { agent: 'naxon' }).status === 'removed');
  let rejected2: unknown = null;
  await waiter2.catch((e) => {
    rejected2 = e;
  });
  check('second waiter rejected too', rejected2 instanceof DequeuedError);
  check('unknown id', dequeueWork('nope', 'human').status === 'unknown');
  holder();
  check('lock free after holder', getSessionLockStatus(A, S).busy === false);
}

// ── 4b. take-back wakes the requester that hung up, never one on the line ──
{
  _resetWorkLedger();
  wakes.length = 0;
  const A = 'lisa';
  const S = 'sess-dq2';
  const holder = await acquireSessionLock(A, S, { priority: 'user', turnId: 'h', workId: 'h' });
  openWork({ id: 'gone', origin: { kind: 'agent', from: { agent: 'naxon', session: 'main' }, callId: 'gone' }, target: { agent: A, session: S }, requester: { agent: 'naxon', session: 'main' }, text: 'q1', waiting: false });
  const w1 = acquireSessionLock(A, S, { priority: 'agent', workId: 'gone' }).catch(() => {});
  openWork({ id: 'online', origin: { kind: 'agent', from: { agent: 'hans', session: 'main' }, callId: 'online' }, target: { agent: A, session: S }, requester: { agent: 'hans', session: 'main' }, text: 'q2' });
  const w2 = acquireSessionLock(A, S, { priority: 'agent', workId: 'online' }).catch(() => {});
  await delay(5);
  dequeueWork('gone', 'human');
  dequeueWork('online', 'human');
  await Promise.all([w1, w2]);
  await delay(80);
  check('the requester that hung up is woken about the take-back', wakes.some((w) => w.ref === 'gone' && w.text.includes('removed from the queue') && w.text.includes('will not be answered')), wakes.map((w) => w.ref).join(','));
  check('the requester still on the line is not (it got the failed result)', !wakes.some((w) => w.ref === 'online'));
  holder();
}

// ── 5. cancel cascade over the requester tree, queued child taken out ──
{
  _resetWorkLedger();
  const mk = (id: string, parent: [string, string], target: [string, string], running = true) =>
    openWork({
      id,
      origin: { kind: 'subagent', taskId: id, depth: 1, parent: { agent: parent[0], session: parent[1] } },
      target: { agent: target[0], session: target[1] },
      requester: { agent: parent[0], session: parent[1] },
      text: 'b',
      waiting: false,
      running,
    });
  mk('root', ['hans', 'main'], ['hans', 'sub-1']);
  mk('child', ['hans', 'sub-1'], ['hans', 'sub-2']);
  mk('grand', ['hans', 'sub-2'], ['hans', 'sub-3']);
  mk('done-child', ['hans', 'sub-1'], ['hans', 'sub-4']);
  finishWork('done-child', ok('x'));
  // a queued child holds a real waiter behind a holder
  const hold = await acquireSessionLock('hans', 'sub-5', { priority: 'agent', workId: 'occupant' });
  mk('queued-child', ['hans', 'sub-1'], ['hans', 'sub-5'], false);
  let qRejected: unknown = null;
  const qWaiter = acquireSessionLock('hans', 'sub-5', { priority: 'agent', workId: 'queued-child' }).catch((e) => {
    qRejected = e;
  });
  const abort = registerChatAbort('hans', 'sub-1');
  let fired = false;
  abort.signal.addEventListener('abort', () => {
    fired = true;
  });
  // The occupant of sub-5 is somebody else's running turn: cancelling
  // the QUEUED child behind it must not stop it.
  const occupantAbort = registerChatAbort('hans', 'sub-5');
  let occupantStopped = false;
  occupantAbort.signal.addEventListener('abort', () => {
    occupantStopped = true;
  });
  const out = cancelWork('root', 'switching models');
  check('cancelling a queued item leaves the running occupant alone', occupantStopped === false);
  occupantAbort.release();
  check('cascade cancels root, running descendants and the queued child', out?.cancelled.sort().join(',') === 'child,grand,queued-child,root', JSON.stringify(out));
  check('finished child skipped with its state', out?.skipped.some((s) => s.id === 'done-child' && s.state === 'done') === true);
  check('abort delivered to the root session', fired);
  await qWaiter;
  check('queued child waiter rejected', qRejected instanceof DequeuedError);
  check('reason recorded', getWork('grand')?.error === 'switching models');
  finishWork('root', ok('late'));
  check('cancelled stays cancelled', getWork('root')?.state === 'cancelled');
  abort.release();
  hold();
  check('unknown root → null', cancelWork('nope', 'x') === null);
}

// ── 6. listWork filters, waitForWork, finish listeners ──────────────
{
  _resetWorkLedger();
  const heard: string[] = [];
  const off = onWorkFinished((it) => heard.push(`${it.id}:${it.state}`));
  openWork({ id: 'x1', origin: { kind: 'voice', consultId: 'x1', callId: 'call' }, target: { agent: 'hans', session: 'main' }, requester: { voiceCall: 'call' }, text: 'spoken' });
  openWork({ id: 'x2', origin: { kind: 'human', via: 'chat' }, target: { agent: 'hans', session: 'main' }, requester: { human: true }, text: 'typed' });
  openWork({ id: 'x3', origin: { kind: 'agent', from: { agent: 'lisa', session: 'main' }, callId: 'x3' }, target: { agent: 'hans', session: 'proj' }, requester: { agent: 'lisa', session: 'main' }, text: 'asked' });
  check('by target session', listWork({ target: { agent: 'hans', session: 'main' } }).map((i) => i.id).join(',') === 'x1,x2');
  check('by target agent', listWork({ target: { agent: 'hans' } }).length === 3);
  check('by requester', listWork({ requester: { agent: 'lisa' } }).map((i) => i.id).join(',') === 'x3');
  check('by kind', listWork({ kinds: ['voice'] }).map((i) => i.id).join(',') === 'x1');
  check('by state', listWork({ states: ['queued'] }).length === 3);
  const p = waitForWork('x1', 2_000);
  await delay(20);
  finishWork('x1', ok('spoken back'));
  const w = await p;
  check('waitForWork returns the finished item', w?.state === 'done');
  check('listener heard the finish', heard.includes('x1:done'));
  dequeueWork('x2', 'human');
  check('listener heard the dequeue', heard.includes('x2:dequeued'));
  off();
  finishWork('x3', ok('a'));
  check('listener removed', !heard.includes('x3:done'));
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
