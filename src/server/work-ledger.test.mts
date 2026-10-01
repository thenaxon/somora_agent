// The work ledger (private/turn-dispatch-phase2-design.md §1): one book
// for every piece of work, one wake, take-back for any waiter with the
// permission rule the operator set (a person: anything; an agent: its own).
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
  FOLLOW_UP_PREFIX_A2A,
  forwardingNoteFor,
  getWork,
  listWork,
  markFetched,
  markRunning,
  onWorkFinished,
  onWorkFollowUp,
  openChainMembers,
  WAKE_WITHDRAWN,
  wakeAnswersFor,
  chainRootOf,
  openWork,
  pendingWakesFor,
  REMOVED_BY_USER,
  setWaiting,
  wakeTextFor,
  waitForWork,
  withdrawWork,
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

const wakes: Array<{ agent: string; session: string; about: string; ref: string; depth: number; text: string; prefix: string; id?: string }> = [];
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
    origin: { kind: 'agent', from: { agent: 'ada', session: 'main' }, callId: 'c1' },
    target: { agent: 'bea', session: 'main' },
    requester: { agent: 'ada', session: 'main' },
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
  openWork({ id: 'c2', origin: { kind: 'agent', from: { agent: 'ada' }, callId: 'c2' }, target: { agent: 'bea', session: 'main' }, text: 'q' });
  finishWork('c2', failed('boom'));
  check('result.error → failed with error', getWork('c2')?.state === 'failed' && getWork('c2')?.error === 'boom');
  openWork({ id: 'c3', origin: { kind: 'agent', from: { agent: 'ada' }, callId: 'c3' }, target: { agent: 'bea', session: 'main' }, text: 'q' });
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
      origin: { kind: 'agent', from: { agent: 'ada', session: 'main' }, callId: id },
      target: { agent: 'bea', session: 'main' },
      requester: { agent: 'ada', session: 'main' },
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

  base('w-nosession', { requester: { agent: 'ada', session: '?' } });
  setWaiting('w-nosession', false);
  finishWork('w-nosession', ok('a'));

  base('w-human', { requester: { human: true } });
  setWaiting('w-human', false);
  finishWork('w-human', ok('a'));

  base('w-failed');
  setWaiting('w-failed', false);
  finishWork('w-failed', failed('engine down'));

  check('pending wake listed before it fires', pendingWakesFor({ agent: 'ada', session: 'main' }).map((i) => i.id).sort().join(',') === 'w-failed,w-ok');
  await delay(80);
  const woke = wakes.map((w) => w.ref).sort();
  check('woke exactly the hung-up, unfetched, auto items (done and failed)', woke.join(',') === 'w-failed,w-ok', woke.join(','));
  check('wake carries about a2a + requester session', wakes.every((w) => w.about === 'a2a' && w.agent === 'ada' && w.session === 'main'));
  check('wake text is the a2a record line with the head; the fetch hint rides beside it', wakes.find((w) => w.ref === 'w-ok')?.text.includes('[agent answer] bea has answered') === true && wakes.find((w) => w.ref === 'w-ok')?.text.includes('answer text') === true && wakes.find((w) => w.ref === 'w-ok')?.prefix.includes('agent_ask_result') === true);
  check('nothing pending after firing', pendingWakesFor({ agent: 'ada', session: 'main' }).length === 0);
}

// ── 3. sub-agent wake carries depth; sentinel never wakes ───────────
{
  _resetWorkLedger();
  wakes.length = 0;
  openWork({
    id: 'task_a',
    origin: { kind: 'subagent', taskId: 'task_a', depth: 2, parent: { agent: 'ada', session: 'sub-1' } },
    target: { agent: 'ada', session: 'sub-2' },
    requester: { agent: 'ada', session: 'sub-1' },
    text: 'brief',
    waiting: false,
    parentDepth: 1,
    running: true,
  });
  finishWork('task_a', { ...ok('hello'), files_written: ['/tmp/x'] } as ChatTurnResult);
  openWork({
    id: 'task_s',
    origin: { kind: 'sentinel', triggerId: 'tr', taskId: 'task_s' },
    target: { agent: 'ada', session: 'main' },
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
  const A = 'bea';
  const S = 'sess-dq';
  const holder = await acquireSessionLock(A, S, { priority: 'user', turnId: 'h1', workId: 'h1' });
  openWork({ id: 'h1', origin: { kind: 'human', via: 'chat' }, target: { agent: A, session: S }, requester: { human: true }, text: 'first' });
  markRunning('h1', 'h1');
  openWork({ id: 'ask-1', origin: { kind: 'agent', from: { agent: 'ada', session: 'main' }, callId: 'ask-1' }, target: { agent: A, session: S }, requester: { agent: 'ada', session: 'main' }, text: 'second' });
  let rejected: unknown = null;
  const waiter = acquireSessionLock(A, S, { priority: 'agent', callId: 'ask-1', workId: 'ask-1' }).catch((e) => {
    rejected = e;
  });
  openWork({ id: 'ask-2', origin: { kind: 'agent', from: { agent: 'nova', session: 'main' }, callId: 'ask-2' }, target: { agent: A, session: S }, requester: { agent: 'nova', session: 'main' }, text: 'third' });
  const waiter2 = acquireSessionLock(A, S, { priority: 'agent', callId: 'ask-2', workId: 'ask-2' });
  await delay(5);
  const listed = listSessionWaiters(A, S);
  check('waiters listed in order with work ids', listed.map((w) => w.workId).join(',') === 'ask-1,ask-2' && listed[0]!.position === 1);

  check('agent may not remove another agent\'s item', dequeueWork('ask-1', { agent: 'nova' }).status === 'forbidden');
  check('running item cannot be dequeued', dequeueWork('h1', 'human').status === 'running');
  const out = dequeueWork('ask-1', 'human');
  check('human removes any waiter', out.status === 'removed');
  await waiter;
  check('waiter rejected with DequeuedError', rejected instanceof DequeuedError);
  check('item reads dequeued with the reason', getWork('ask-1')?.state === 'dequeued' && getWork('ask-1')?.error === REMOVED_BY_USER);
  check('queue shrank', getSessionLockStatus(A, S).queueLength === 1);
  check('agent removes its own item', dequeueWork('ask-2', { agent: 'nova' }).status === 'removed');
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
  const A = 'bea';
  const S = 'sess-dq2';
  const holder = await acquireSessionLock(A, S, { priority: 'user', turnId: 'h', workId: 'h' });
  openWork({ id: 'gone', origin: { kind: 'agent', from: { agent: 'nova', session: 'main' }, callId: 'gone' }, target: { agent: A, session: S }, requester: { agent: 'nova', session: 'main' }, text: 'q1', waiting: false });
  const w1 = acquireSessionLock(A, S, { priority: 'agent', workId: 'gone' }).catch(() => {});
  openWork({ id: 'online', origin: { kind: 'agent', from: { agent: 'ada', session: 'main' }, callId: 'online' }, target: { agent: A, session: S }, requester: { agent: 'ada', session: 'main' }, text: 'q2' });
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
  mk('root', ['ada', 'main'], ['ada', 'sub-1']);
  mk('child', ['ada', 'sub-1'], ['ada', 'sub-2']);
  mk('grand', ['ada', 'sub-2'], ['ada', 'sub-3']);
  mk('done-child', ['ada', 'sub-1'], ['ada', 'sub-4']);
  finishWork('done-child', ok('x'));
  // a queued child holds a real waiter behind a holder
  const hold = await acquireSessionLock('ada', 'sub-5', { priority: 'agent', workId: 'occupant' });
  mk('queued-child', ['ada', 'sub-1'], ['ada', 'sub-5'], false);
  let qRejected: unknown = null;
  const qWaiter = acquireSessionLock('ada', 'sub-5', { priority: 'agent', workId: 'queued-child' }).catch((e) => {
    qRejected = e;
  });
  const abort = registerChatAbort('ada', 'sub-1');
  let fired = false;
  abort.signal.addEventListener('abort', () => {
    fired = true;
  });
  // The occupant of sub-5 is somebody else's running turn: cancelling
  // the QUEUED child behind it must not stop it.
  const occupantAbort = registerChatAbort('ada', 'sub-5');
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
  openWork({ id: 'x1', origin: { kind: 'voice', consultId: 'x1', callId: 'call' }, target: { agent: 'ada', session: 'main' }, requester: { voiceCall: 'call' }, text: 'spoken' });
  openWork({ id: 'x2', origin: { kind: 'human', via: 'chat' }, target: { agent: 'ada', session: 'main' }, requester: { human: true }, text: 'typed' });
  openWork({ id: 'x3', origin: { kind: 'agent', from: { agent: 'bea', session: 'main' }, callId: 'x3' }, target: { agent: 'ada', session: 'proj' }, requester: { agent: 'bea', session: 'main' }, text: 'asked' });
  check('by target session', listWork({ target: { agent: 'ada', session: 'main' } }).map((i) => i.id).join(',') === 'x1,x2');
  check('by target agent', listWork({ target: { agent: 'ada' } }).length === 3);
  check('by requester', listWork({ requester: { agent: 'bea' } }).map((i) => i.id).join(',') === 'x3');
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

// ── 7. the follow-up (private/turn-dispatch-followup-design.md) ─────
// A wake turn about a chain member ended; the chain's root was asked by
// someone; nothing in the chain is open → that someone hears about it
// exactly once. Wake turns are simulated the way the server runs them:
// an item `wake-<ref>` with origin wake, opened and then finished.
const followUps: Array<{ from: string; to: string; callId: string; text: string; prefix: string; id: string }> = [];
function wireFollowUps(): void {
  wakes.length = 0;
  followUps.length = 0;
  configureWorkWake({
    graceMs: 30,
    dispatchWakeTurn: async (w) => {
      wakes.push(w);
    },
    dispatchFollowUpMessage: async (m) => {
      followUps.push({ from: `${m.from.agent}/${m.from.session}`, to: `${m.to.agent}/${m.to.session}`, callId: m.callId, text: m.text, prefix: m.prefix, id: m.id });
    },
  });
}
const NOVA = { agent: 'nova', session: 'main' };
const BEA = { agent: 'bea', session: 'main' };
/** nova's call to bea, answered "working on it" — the chain root. */
function rootCall(id = 'X'): void {
  openWork({ id, origin: { kind: 'agent', from: NOVA, callId: id }, target: BEA, requester: NOVA, text: 'research this' });
  markRunning(id);
}
/** a sub bea spawned during `during`, in its own session */
function sub(id: string, during: string, target = { agent: 'bea', session: `sub-${id}` }, requester = BEA): void {
  openWork({ id, origin: { kind: 'subagent', parent: requester, taskId: id, depth: 1 }, target, requester, text: `task ${id}`, waiting: false, startedDuring: during });
  markRunning(id);
}
/** the wake turn bea's session runs about a finished sub */
function wakeTurn(ref: string, text: string, id = `wake-${ref}`, session = BEA): void {
  openWork({ id, origin: { kind: 'wake', about: 'subagent', ref }, target: session, text: `[subagent attention] Task '${ref}'`, waiting: false, wake: 'never' });
  markRunning(id);
  finishWork(id, ok(text));
}

// 7a. one child → one follow-up to the asker, as a message from bea
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('working on it with a sub, will report back'));
  check('7a chainRootOf(sub) is the call', chainRootOf(getWork('S1')!)?.id === 'X');
  finishWork('S1', ok('sub result'));
  await delay(60); // the sub's own wake fires (bea hung up on it)
  check('7a the sub woke bea', wakes.some((w) => w.ref === 'S1'));
  wakeTurn('S1', 'Here is the assembled research.');
  check('7a nothing yet — the follow-up waits its grace', followUps.length === 0);
  await delay(60);
  check('7a exactly one follow-up', followUps.length === 1, JSON.stringify(followUps));
  const fu = followUps[0];
  check('7a from bea/main to nova/main, correlated by the call id', fu?.from === 'bea/main' && fu?.to === 'nova/main' && fu?.callId === 'X');
  check('7a text = the wake turn\'s answer; prefix = the follow-up frame', fu?.text === 'Here is the assembled research.' && fu?.prefix === FOLLOW_UP_PREFIX_A2A('X'));
  check('7a the call carries the follow-up in its result', getWork('X')?.result?.follow_ups?.[0] === 'Here is the assembled research.');
  check('7a the message item exists without a requester (nobody waits for it)', fu !== undefined && getWork(fu.id) === undefined);
}
// 7b. four children → the follow-up waits for the last, then once
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  for (const id of ['S1', 'S2', 'S3', 'S4']) sub(id, 'X');
  finishWork('X', ok('four subs running'));
  for (const id of ['S1', 'S2', 'S3']) {
    finishWork(id, ok(`result ${id}`));
    wakeTurn(id, `noted ${id}`);
  }
  await delay(60);
  check('7b three wakes ended, S4 still running → no follow-up', followUps.length === 0 && openChainMembers('X').some((c) => c.id === 'S4'));
  finishWork('S4', ok('result S4'));
  check('7b S4 finished but its wake is in grace → still open', openChainMembers('X').some((c) => c.id === 'S4'));
  await delay(60);
  wakeTurn('S4', 'all four assembled');
  await delay(60);
  check('7b exactly one follow-up, carrying every wake answer in order', followUps.length === 1 && followUps[0]?.text === 'noted S1\n\nnoted S2\n\nnoted S3\n\nall four assembled', JSON.stringify(followUps.map((f) => f.text)));
}
// 7c. a child started in the wake turn belongs to the chain
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('one sub'));
  finishWork('S1', ok('r1'));
  await delay(60);
  // bea's wake turn about S1 spawns S5 and ends
  openWork({ id: 'wake-S1', origin: { kind: 'wake', about: 'subagent', ref: 'S1' }, target: BEA, text: 'wake', waiting: false, wake: 'never' });
  markRunning('wake-S1');
  sub('S5', 'wake-S1');
  finishWork('wake-S1', ok('started one more'));
  await delay(60);
  check('7c S5 is in the chain (via the wake turn) and open → no follow-up', followUps.length === 0 && chainRootOf(getWork('S5')!)?.id === 'X');
  finishWork('S5', ok('r5'));
  await delay(60);
  wakeTurn('S5', 'now really done');
  await delay(60);
  check('7c the follow-up comes after S5, once, with both wake answers', followUps.length === 1 && followUps[0]?.text === 'started one more\n\nnow really done', JSON.stringify(followUps.map((f) => f.text)));
}
// 7d. no follow-up: root failed / dequeued / asked by a person / no requester
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall('F');
  sub('S1', 'F');
  failWork('F', 'model error');
  finishWork('S1', ok('r'));
  await delay(60);
  wakeTurn('S1', 'done anyway');
  await delay(60);
  check('7d root failed → none', followUps.length === 0);

  openWork({ id: 'D', origin: { kind: 'agent', from: NOVA, callId: 'D' }, target: BEA, requester: NOVA, text: 'q' });
  sub('S2', 'D');
  dequeueWork('D', 'human');
  finishWork('S2', ok('r'));
  await delay(60);
  wakeTurn('S2', 'done anyway');
  await delay(60);
  check('7d root dequeued → none', followUps.length === 0);

  openWork({ id: 'H', origin: { kind: 'human', via: 'chat' }, target: BEA, requester: { human: true }, text: 'q', wake: 'never' });
  markRunning('H');
  sub('S3', 'H');
  finishWork('H', ok('a'));
  finishWork('S3', ok('r'));
  await delay(60);
  wakeTurn('S3', 'for the person');
  await delay(60);
  check('7d root is a person\'s turn → none (the person sees the wake in the session)', followUps.length === 0 && wakes.length === 3);

  openWork({ id: 'T', origin: { kind: 'sentinel', triggerId: 't', taskId: 'T' }, target: BEA, text: 'fire', waiting: false, wake: 'never', running: true });
  sub('S4', 'T');
  finishWork('T', ok('a'));
  finishWork('S4', ok('r'));
  await delay(60);
  wakeTurn('S4', 'for nobody');
  await delay(60);
  check('7d root without requester (sentinel) → none', followUps.length === 0);
}
// 7e. the model reported on its own → no second delivery
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('working'));
  finishWork('S1', ok('r'));
  await delay(60);
  openWork({ id: 'wake-S1', origin: { kind: 'wake', about: 'subagent', ref: 'S1' }, target: BEA, text: 'wake', waiting: false, wake: 'never' });
  markRunning('wake-S1');
  // bea agent_asks nova in that turn
  openWork({ id: 'R', origin: { kind: 'agent', from: BEA, callId: 'R' }, target: NOVA, requester: BEA, text: 'here is the result', startedDuring: 'wake-S1' });
  finishWork('wake-S1', ok('sent it myself'));
  await delay(60);
  check('7e self-reported → no follow-up', followUps.length === 0);
}
// 7f. fetched during the grace → dropped; stopped wake turn → none; failed wake turn → carries the failure
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('working'));
  finishWork('S1', ok('r'));
  await delay(60);
  wakeTurn('S1', 'assembled');
  markFetched('X'); // nova read agent_ask_result(X) right then
  await delay(60);
  check('7f fetched within the grace → none', followUps.length === 0);

  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('working'));
  finishWork('S1', ok('r'));
  await delay(60);
  openWork({ id: 'wake-S1', origin: { kind: 'wake', about: 'subagent', ref: 'S1' }, target: BEA, text: 'wake', waiting: false, wake: 'never' });
  markRunning('wake-S1');
  failWork('wake-S1', 'stopped by the user');
  await delay(60);
  check('7f wake turn stopped by the user → none', followUps.length === 0);

  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('working'));
  finishWork('S1', ok('r'));
  await delay(60);
  openWork({ id: 'wake-S1', origin: { kind: 'wake', about: 'subagent', ref: 'S1' }, target: BEA, text: 'wake', waiting: false, wake: 'never' });
  markRunning('wake-S1');
  failWork('wake-S1', 'engine exploded');
  await delay(60);
  check('7f wake turn failed otherwise → the asker hears that', followUps.length === 1 && followUps[0]?.text.includes('engine exploded') === true, JSON.stringify(followUps));
}
// 7g. depth 3: grandchild → sub (as a wake with follow_ups) → bea → nova (as a message); each level once
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('Y', 'X'); // bea's sub, session sub-Y
  finishWork('X', ok('delegated to a sub'));
  // the sub spawns a grandchild and reports before it is done
  sub('Z', 'Y', { agent: 'bea', session: 'sub-Z' }, { agent: 'bea', session: 'sub-Y' });
  finishWork('Y', ok('started a grandchild, reporting now'));
  await delay(60);
  check('7g bea woke about Y (its wake), nova nothing yet', wakes.some((w) => w.ref === 'Y') && followUps.length === 0);
  wakeTurn('Y', 'noted, Y has a grandchild');
  await delay(60);
  check('7g Y\'s wake ended but Z is open → no follow-up to nova', followUps.length === 0);
  finishWork('Z', ok('grandchild result'));
  await delay(60);
  check('7g Z woke the sub in its session', wakes.some((w) => w.ref === 'Z' && w.session === 'sub-Y'));
  wakeTurn('Z', 'sub assembled the grandchild result', 'wake-Z', { agent: 'bea', session: 'sub-Y' });
  await delay(60);
  const fuWake = wakes.find((w) => w.ref === 'Y' && w.id === 'wake-Y-fu1');
  check('7g bea gets ONE follow-up wake about Y with the new text', fuWake !== undefined && fuWake.text.includes('has a follow-up') && fuWake.text.includes('sub assembled'), JSON.stringify(wakes.map((w) => w.id ?? w.ref)));
  check('7g Y\'s result carries the follow-up for subagent_result', getWork('Y')?.result?.follow_ups?.[0] === 'sub assembled the grandchild result');
  check('7g nova nothing yet (bea\'s follow-up wake has not run)', followUps.length === 0);
  wakeTurn('Y', 'final answer for nova', 'wake-Y-fu1');
  await delay(60);
  check('7g …then nova exactly once, with bea\'s wake answers (not the sub\'s internal one)', followUps.length === 1 && followUps[0]?.text === 'noted, Y has a grandchild\n\nfinal answer for nova', JSON.stringify(followUps.map((f) => f.text)));
}
// 7h. a second cycle after the first follow-up
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('working'));
  finishWork('S1', ok('r1'));
  await delay(60);
  wakeTurn('S1', 'first result');
  await delay(60);
  check('7h first follow-up', followUps.length === 1);
  // later, in a wake turn about S1's chain, bea starts S6
  openWork({ id: 'wake-S1-b', origin: { kind: 'wake', about: 'subagent', ref: 'S1' }, target: BEA, text: 'wake', waiting: false, wake: 'never' });
  markRunning('wake-S1-b');
  sub('S6', 'wake-S1-b');
  finishWork('wake-S1-b', ok('one more'));
  await delay(60);
  check('7h S6 open → no second follow-up yet', followUps.length === 1);
  finishWork('S6', ok('r6'));
  await delay(60);
  wakeTurn('S6', 'second result');
  await delay(60);
  check('7h second follow-up, numbered 2', followUps.length === 2 && followUps[1]?.id === 'followup-X-2' && getWork('X')?.result?.follow_ups?.length === 2);
}
// 7i. a voice consult as the root → the listener hears it
{
  _resetWorkLedger();
  wireFollowUps();
  const heard: Array<{ root: string; text: string }> = [];
  onWorkFollowUp((root, fu) => heard.push({ root: root.id, text: fu.text }));
  openWork({ id: 'V', origin: { kind: 'voice', consultId: 'V', callId: 'call1' }, target: { agent: 'ada', session: 'main' }, requester: { voiceCall: 'call1' }, text: 'q', waiting: true, wake: 'never' });
  markRunning('V');
  sub('S1', 'V', { agent: 'ada', session: 'sub-S1' }, { agent: 'ada', session: 'main' });
  finishWork('V', ok('checking with a sub'));
  finishWork('S1', ok('r'));
  await delay(60);
  wakeTurn('S1', 'the sub says 42', 'wake-S1', { agent: 'ada', session: 'main' });
  await delay(60);
  check('7i the voice listener heard the follow-up once', heard.length === 1 && heard[0]?.root === 'V' && heard[0]?.text === 'the sub says 42', JSON.stringify(heard));
  check('7i no message and no wake for a voice root', followUps.length === 0 && !wakes.some((w) => w.ref === 'V'));
}
// 7j. no follow-up when the item was started from nowhere (no startedDuring)
{
  _resetWorkLedger();
  wireFollowUps();
  openWork({ id: 'S1', origin: { kind: 'subagent', taskId: 'S1', depth: 1 }, target: { agent: 'bea', session: 'sub' }, requester: BEA, text: 't', waiting: false });
  markRunning('S1');
  check('7j chainRootOf is undefined', chainRootOf(getWork('S1')!) === undefined);
  finishWork('S1', ok('r'));
  await delay(60);
  wakeTurn('S1', 'x');
  await delay(60);
  check('7j nothing', followUps.length === 0);
}

// 7k. the wake turn is told where its answer goes (the operator's hand test: bea wrote "leaving it" and nova got that)
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  finishWork('X', ok('working'));
  finishWork('S1', ok('r1'));
  await delay(60);
  const w = wakes.find((x) => x.ref === 'S1');
  check('7k the sub\'s wake frame says the answer is forwarded to nova for call X', w?.prefix.includes('forwarded to agent nova') === true && w?.prefix.includes('call_id "X"') === true && w?.prefix.includes('subagent_result') === true, w?.prefix);
  check('7k the record line is untouched', w?.text.startsWith('[subagent attention]') === true && !w?.text.includes('forwarded'));
  // a wake under a person's turn carries no such note
  openWork({ id: 'H', origin: { kind: 'human', via: 'chat' }, target: BEA, requester: { human: true }, text: 'q', wake: 'never' });
  markRunning('H');
  sub('S2', 'H');
  finishWork('H', ok('a'));
  finishWork('S2', ok('r2'));
  await delay(60);
  const w2 = wakes.find((x) => x.ref === 'S2');
  check('7k no note under a person\'s turn', w2 !== undefined && !w2.prefix.includes('forwarded'), w2?.prefix);
  // depth 3: the sub's own wake (about the grandchild) says its answer goes to bea for task Y;
  // bea's follow-up wake about Y says its answer goes to nova.
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('Y', 'X');
  finishWork('X', ok('delegated'));
  sub('Z', 'Y', { agent: 'bea', session: 'sub-Z' }, { agent: 'bea', session: 'sub-Y' });
  finishWork('Y', ok('started a grandchild'));
  await delay(60);
  wakeTurn('Y', 'noted');
  finishWork('Z', ok('grandchild result'));
  await delay(60);
  const wz = wakes.find((x) => x.ref === 'Z');
  check('7k the sub\'s wake about its grandchild: answer goes to the parent for task Y', wz?.prefix.includes("forwarded to your parent (bea, session main) as the follow-up to task 'Y'") === true, wz?.prefix);
  wakeTurn('Z', 'sub assembled', 'wake-Z', { agent: 'bea', session: 'sub-Y' });
  await delay(60);
  const fu = wakes.find((x) => x.id === 'wake-Y-fu1');
  check('7k bea\'s follow-up wake about Y: answer goes to nova for call X', fu?.prefix.includes('forwarded to agent nova') === true && fu?.prefix.includes('call_id "X"') === true, fu?.prefix);
  check('7k forwardingNoteFor is undefined for a root without requester', forwardingNoteFor(getWork('X')!) === undefined);
  // the sub finishes while the root still answers: the note is there already; a failed root gets none
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  check('7k note while the root is still running', forwardingNoteFor(getWork('S1')!)?.includes('forwarded to agent nova') === true);
  failWork('X', 'model error');
  check('7k no note once the root failed', forwardingNoteFor(getWork('S1')!) === undefined);
}

// 7l. the grace lost its race: a wake already queued behind the requester's turn is withdrawn when the result is read
{
  _resetWorkLedger();
  wireFollowUps();
  const A = 'bea';
  const S = 'main';
  // bea's answering turn holds the lock (the root, nova's call)
  const release = await acquireSessionLock(A, S, { priority: 'agent', turnId: 'X', workId: 'X' });
  rootCall();
  sub('S1', 'X');
  sub('S2', 'X');
  // the dispatcher of this test: opens the wake item and queues it in the real lock, like the server does
  const queuedWakes: Array<Promise<unknown>> = [];
  configureWorkWake({
    graceMs: 30,
    dispatchWakeTurn: async (w) => {
      wakes.push(w);
      openWork({ id: w.id ?? `wake-${w.ref}`, origin: { kind: 'wake', about: 'subagent', ref: w.ref }, target: { agent: w.agent, session: w.session }, text: w.text, waiting: false, wake: 'never' });
      queuedWakes.push(acquireSessionLock(w.agent, w.session, { priority: 'agent', turnId: `t-${w.ref}`, workId: w.id ?? `wake-${w.ref}` }).catch((e: unknown) => e));
    },
    dispatchFollowUpMessage: async (m) => {
      followUps.push({ from: `${m.from.agent}/${m.from.session}`, to: `${m.to.agent}/${m.to.session}`, callId: m.callId, text: m.text, prefix: m.prefix, id: m.id });
    },
  });
  finishWork('S1', ok('r1'));
  finishWork('S2', ok('r2'));
  await delay(60);
  check('7l both wakes were dispatched and wait behind the running turn', wakes.filter((w) => w.ref === 'S1' || w.ref === 'S2').length === 2 && listSessionWaiters(A, S).length === 2);
  // bea, still in her answering turn, fetches S2 herself
  markFetched('S2');
  await delay(5);
  check('7l the queued wake for S2 is withdrawn: out of the lock queue, item dequeued with the reason', listSessionWaiters(A, S).length === 1 && getWork('wake-S2')?.state === 'dequeued' && getWork('wake-S2')?.error === WAKE_WITHDRAWN, JSON.stringify(getWork('wake-S2')));
  check('7l its lock waiter was rejected (DequeuedError), the S1 wake still waits', (await queuedWakes[1]) instanceof DequeuedError && listSessionWaiters(A, S)[0]?.workId === 'wake-S1');
  // the root answers, the S1 wake runs and ends: the tree is closed (S2's wake is withdrawn, not open)
  finishWork('X', ok('working on it'));
  release();
  await queuedWakes[0];
  markRunning('wake-S1');
  finishWork('wake-S1', ok('both results assembled: r1 + r2'));
  await delay(60);
  check('7l exactly one follow-up, with the assembled text — the withdrawn wake never spoke', followUps.length === 1 && followUps[0]?.text === 'both results assembled: r1 + r2', JSON.stringify(followUps));
  // a wake that is already RUNNING is left alone
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S3', 'X');
  finishWork('X', ok('w'));
  finishWork('S3', ok('r3'));
  await delay(60);
  openWork({ id: 'wake-S3', origin: { kind: 'wake', about: 'subagent', ref: 'S3' }, target: BEA, text: 'wake', waiting: false, wake: 'never' });
  markRunning('wake-S3');
  markFetched('S3');
  check('7l a running wake is not touched by a late fetch', getWork('wake-S3')?.state === 'running');
}
// 7m. the follow-up carries every wake answer the target wrote for this work, oldest first
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S1', 'X');
  sub('S2', 'X');
  finishWork('X', ok('working'));
  finishWork('S1', ok('r1'));
  await delay(60);
  wakeTurn('S1', 'Here are the three points: A, B, C.');
  finishWork('S2', ok('r2'));
  await delay(60);
  wakeTurn('S2', 'Already handled in my previous turn — duplicate notice.');
  await delay(60);
  check('7m one follow-up with both answers, in order', followUps.length === 1 && followUps[0]?.text === 'Here are the three points: A, B, C.\n\nAlready handled in my previous turn — duplicate notice.', JSON.stringify(followUps.map((f) => f.text)));
  check('7m wakeAnswersFor lists them', wakeAnswersFor(getWork('X')!).length === 2);
  // the sub's own wake turns (in its session) are not part of bea's answer
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('Y', 'X');
  finishWork('X', ok('delegated'));
  sub('Z', 'Y', { agent: 'bea', session: 'sub-Z' }, { agent: 'bea', session: 'sub-Y' });
  finishWork('Y', ok('started'));
  await delay(60);
  wakeTurn('Y', 'noted');
  finishWork('Z', ok('gz'));
  await delay(60);
  wakeTurn('Z', 'sub-internal assembly', 'wake-Z', { agent: 'bea', session: 'sub-Y' });
  await delay(60);
  wakeTurn('Y', 'final for nova', 'wake-Y-fu1');
  await delay(60);
  check('7m nova\'s follow-up = bea\'s own wake answers only (noted + final), not the sub\'s internal one', followUps.length === 1 && followUps[0]?.text === 'noted\n\nfinal for nova', JSON.stringify(followUps.map((f) => f.text)));
}

// 7n. attention:false does not count when someone else waits for the outcome
{
  _resetWorkLedger();
  wireFollowUps();
  rootCall(); // nova asks bea; bea's turn is the running root
  openWork({ id: 'S1', origin: { kind: 'subagent', parent: BEA, taskId: 'S1', depth: 1 }, target: { agent: 'bea', session: 'sub-S1' }, requester: BEA, text: 't', waiting: false, wake: 'never', startedDuring: 'X' });
  check('7n under an agent\'s question the wake stays on', getWork('S1')?.wake === 'auto');
  openWork({ id: 'V', origin: { kind: 'voice', consultId: 'V', callId: 'call1' }, target: { agent: 'ada', session: 'main' }, requester: { voiceCall: 'call1' }, text: 'q', waiting: true, wake: 'never' });
  markRunning('V');
  openWork({ id: 'S2', origin: { kind: 'subagent', parent: { agent: 'ada', session: 'main' }, taskId: 'S2', depth: 1 }, target: { agent: 'ada', session: 'sub-S2' }, requester: { agent: 'ada', session: 'main' }, text: 't', waiting: false, wake: 'never', startedDuring: 'V' });
  check('7n under a voice consult the wake stays on', getWork('S2')?.wake === 'auto');
  openWork({ id: 'H', origin: { kind: 'human', via: 'chat' }, target: BEA, requester: { human: true }, text: 'q', wake: 'never' });
  markRunning('H');
  openWork({ id: 'S3', origin: { kind: 'subagent', parent: BEA, taskId: 'S3', depth: 1 }, target: { agent: 'bea', session: 'sub-S3' }, requester: BEA, text: 't', waiting: false, wake: 'never', startedDuring: 'H' });
  check('7n under a person\'s turn attention:false is respected', getWork('S3')?.wake === 'never');
  openWork({ id: 'S4', origin: { kind: 'subagent', taskId: 'S4', depth: 1 }, target: { agent: 'bea', session: 'sub-S4' }, requester: BEA, text: 't', waiting: false, wake: 'never' });
  check('7n started from nowhere: respected', getWork('S4')?.wake === 'never');
  openWork({ id: 'W', origin: { kind: 'wake', about: 'subagent', ref: 'S1' }, target: BEA, text: 'w', waiting: false, wake: 'never' });
  check('7n a wake item itself is never touched', getWork('W')?.wake === 'never');
}

// 7o. a person stops a running sub from the requester's popover: the requester hears it; the agent's own cancel and a cascaded child wake no one
{
  _resetWorkLedger();
  wireFollowUps();
  openWork({ id: 'H', origin: { kind: 'human', via: 'chat' }, target: BEA, requester: { human: true }, text: 'q', wake: 'never' });
  markRunning('H');
  sub('S1', 'H');
  sub('G1', 'S1', { agent: 'bea', session: 'sub-G1' }, { agent: 'bea', session: 'sub-S1' }); // the sub's own child
  const out = cancelWork('S1', 'stopped by the user', 'human');
  check('7o both cancelled (cascade)', out?.cancelled.length === 2 && getWork('S1')?.cancelledBy === 'human' && getWork('G1')?.cancelledBy === 'cascade');
  await delay(60);
  const w = wakes.find((x) => x.ref === 'S1');
  check('7o the requester is woken about the stop', w !== undefined && w.text.includes("Task 'S1'") && w.text.includes('was stopped by the user'), w?.text);
  check('7o the cascaded child wakes nobody', !wakes.some((x) => x.ref === 'G1'));
  _resetWorkLedger();
  wireFollowUps();
  openWork({ id: 'H', origin: { kind: 'human', via: 'chat' }, target: BEA, requester: { human: true }, text: 'q', wake: 'never' });
  markRunning('H');
  sub('S2', 'H');
  cancelWork('S2', 'cancelled by bea: not needed');
  await delay(60);
  check('7o the agent\'s own cancel wakes nobody', !wakes.some((x) => x.ref === 'S2'));
  // a person's cancel of a sub under nova's call: bea is woken, and nova still gets one follow-up after the rest
  _resetWorkLedger();
  wireFollowUps();
  rootCall();
  sub('S3', 'X');
  sub('S4', 'X');
  finishWork('X', ok('two subs'));
  cancelWork('S3', 'stopped by the user', 'human');
  await delay(60);
  check('7o under a call: bea is woken about the stopped sub, with the forwarding note', wakes.some((x) => x.ref === 'S3' && x.prefix.includes('forwarded to agent nova')));
  wakeTurn('S3', 'one of two was stopped, continuing with the other');
  finishWork('S4', ok('r4'));
  await delay(60);
  wakeTurn('S4', 'here is what the remaining sub found');
  await delay(60);
  check('7o nova gets exactly one follow-up with both wake answers', followUps.length === 1 && followUps[0]?.text.includes('remaining sub found') === true && followUps[0]?.text.includes('one of two was stopped') === true, JSON.stringify(followUps.map((f) => f.text)));
}

// ── 8. woken with an agent's answer: a reply goes back to the session that answered ──
// ada (project session) asks nova/kittyapp with wait:false, is woken
// with the answer and writes back without naming a session. The wake
// turn has no from_agent, so it used to land in nova/main.
{
  _resetWorkLedger();
  const { wakeReplyTargetFor } = await import('./work-ledger.ts');
  const adaProject = { agent: 'ada', session: '20260914-090000_kittyapp-build' };
  openWork({ id: 'call-1', origin: { kind: 'agent', from: { agent: 'ada', session: adaProject.session }, callId: 'call-1' }, target: { agent: 'nova', session: '20260914-080000_kittyapp' }, requester: adaProject, text: 'report', waiting: false, wake: 'never' });
  check('8a no wake turn running: nothing to reply to', wakeReplyTargetFor(adaProject) === null);
  openWork({ id: 'wake-call-1', origin: { kind: 'wake', about: 'a2a', ref: 'call-1' }, target: adaProject, text: '[agent answer] …', running: true, wake: 'never' });
  const t = wakeReplyTargetFor(adaProject);
  check('8b woken with the answer: reply target is the session that answered', t?.agent === 'nova' && t?.session === '20260914-080000_kittyapp', JSON.stringify(t));
  check('8c only for the session that was woken', wakeReplyTargetFor({ agent: 'ada', session: 'main' }) === null);
  // A sub-agent's session is a sealed room — a wake about a finished sub gives no reply target.
  openWork({ id: 'task-9', origin: { kind: 'subagent', parent: { agent: 'ada', session: 'main' }, taskId: 'task-9' } as never, target: { agent: 'bea', session: 'sub-ada-9' }, requester: { agent: 'ada', session: 'main' }, text: 'job', waiting: false, wake: 'never' });
  openWork({ id: 'wake-task-9', origin: { kind: 'wake', about: 'subagent', ref: 'task-9' }, target: { agent: 'ada', session: 'main' }, text: '[subagent attention] …', running: true, wake: 'never' });
  check('8d a wake about a SUB-agent is not a reply target', wakeReplyTargetFor({ agent: 'ada', session: 'main' }) === null);
  // Once the wake turn is over, the target is gone again.
  finishWork('wake-call-1', ok('done'));
  check('8e after the wake turn ended: nothing', wakeReplyTargetFor(adaProject) === null);
}

// ── 9. withdraw: the soft take-back of a running call (2026-09-24) ──
{
  _resetWorkLedger();
  wakes.length = 0;
  openWork({ id: 'w-1', origin: { kind: 'agent', from: { agent: 'ada', session: 'main' }, callId: 'w-1' }, target: { agent: 'bea', session: 'main' }, requester: { agent: 'ada', session: 'main' }, text: 'research this', waiting: false });
  check('9a a queued call is not withdrawable (dequeue is the tool for it)', withdrawWork('w-1', { agent: 'ada' }).status === 'not_running');
  markRunning('w-1', 'turn-w1');
  check('9b another agent may not withdraw it', withdrawWork('w-1', { agent: 'nova' }).status === 'forbidden');
  const w = withdrawWork('w-1', { agent: 'ada' });
  check('9c the requester withdraws a running call', w.status === 'withdrawn');
  const it = getWork('w-1')!;
  check('9d it keeps running, wakes no one, records who took it back', it.state === 'running' && it.wake === 'never' && it.withdrawnBy === 'ada' && typeof it.withdrawnAt === 'number');
  check('9e unknown id', withdrawWork('nope', { agent: 'ada' }).status === 'unknown');
  finishWork('w-1', ok('here is the research anyway'));
  await delay(60);
  check('9f the late result wakes nobody', wakes.length === 0 && pendingWakesFor({ agent: 'ada', session: 'main' }).length === 0, JSON.stringify(wakes));
  check('9g the result is still readable for agent_ask_result', getWork('w-1')?.state === 'done' && getWork('w-1')?.result?.finalText === 'here is the research anyway');
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
