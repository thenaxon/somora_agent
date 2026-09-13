// startTurn — the one way a turn starts (private/turn-dispatch-design.md
// §2.3). Pins the six things it does for EVERY caller: lock with a turn
// id, pre-flight under the lock, abort registration, legacy fields
// derived from the origin, a stopped turn reported as stopped, and the
// release of everything in the error paths too.
//
// Run: npx tsx src/server/start-turn.test.mts

import assert from 'node:assert/strict';

import { triggerChatAbort } from './chat-aborts.ts';
import type { RunChatTurnArgs } from './run-turn.ts';
import type { ChatTurnResolveDeps, ChatTurnResult } from './run-turn-types.ts';
import { getSessionLockStatus } from './session-queue.ts';
import { configureStartTurn, startTurn, STOPPED_BY_USER } from './start-turn.ts';
import type { SseEvent } from '../types/events.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const ok = (text: string): ChatTurnResult =>
  ({ finalText: text, outcome: 'completed', tool_calls: 0, contextWindow: 1, provider: 'p', model: 'm', thinkingActive: false, ms: 1 }) as ChatTurnResult;

// The runner seam: records what it was called with, waits until
// released, honours the abort signal like an engine adapter does.
const calls: RunChatTurnArgs[] = [];
let releaseRun: (() => void) | null = null;
let nextResult: ChatTurnResult | (() => never) = ok('done');
/** Case 7: the engine already finished when the stop arrived. */
let ignoreAbort = false;
const fakeRun = (args: RunChatTurnArgs): Promise<ChatTurnResult> => {
  calls.push(args);
  return new Promise<ChatTurnResult>((resolve, reject) => {
    const finish = () => {
      releaseRun = null;
      if (typeof nextResult === 'function') {
        try {
          nextResult();
        } catch (e) {
          reject(e);
        }
        return;
      }
      resolve(nextResult);
    };
    releaseRun = finish;
    args.signal?.addEventListener('abort', () => {
      if (ignoreAbort) return;
      releaseRun = null;
      // What runChatTurn does on an engine abort: no throw, outcome failed.
      resolve({ ...ok(''), outcome: 'failed', error: 'The operation was aborted' } as ChatTurnResult);
    });
  });
};

const published: Array<{ agent: string; session: string; event: SseEvent }> = [];
const deps = { config: {}, sessionMetaStore: {}, tools: {}, onActivity: () => {} } as unknown as ChatTurnResolveDeps;
configureStartTurn({
  chatTurnDeps: deps,
  publish: (agent, session, event) => {
    published.push({ agent, session, event });
  },
  runTurn: fakeRun,
});

const A = 'agent-st';
let n = 0;
const fresh = () => `sess-${++n}`;

// ── 1. lock with turn id, abort registered, released after ──────────
{
  const S = fresh();
  const p = startTurn({ agent: A, session: S, text: 'hi', origin: { kind: 'human', via: 'chat' }, turnId: 'turn-1' });
  await tick();
  const st = getSessionLockStatus(A, S);
  check('lock held while running', st.busy === true);
  check('turn id on the lock', st.activeTurnId === 'turn-1', String(st.activeTurnId));
  check('label user for a human', st.activePriority === 'user', String(st.activePriority));
  check('runner got the signal', calls.at(-1)?.signal instanceof AbortSignal);
  check('runner got the turn id', calls.at(-1)?.turnId === 'turn-1');
  check('runner got the origin', calls.at(-1)?.origin?.kind === 'human');
  check('human: no prefix', calls.at(-1)?.turnPrefix === undefined);
  check('human: no legacy fields', calls.at(-1)?.fromAgent === undefined && calls.at(-1)?.fromSystem === undefined);
  releaseRun!();
  const r = await p;
  check('result returned', r?.finalText === 'done');
  check('lock released', getSessionLockStatus(A, S).busy === false);
  check('abort registry empty after', triggerChatAbort(A, S).aborted === false);
}

// ── 2. Stop reaches the turn; the asker reads "stopped by the user" ──
{
  const S = fresh();
  const p = startTurn({
    agent: A,
    session: S,
    text: 'q',
    origin: { kind: 'agent', from: { agent: 'hans', session: 'main' }, callId: 'c1' },
  });
  await tick();
  const st = getSessionLockStatus(A, S);
  check('agent_ask: call id on the lock', st.activeCallId === 'c1', String(st.activeCallId));
  check('agent_ask: label agent', st.activePriority === 'agent');
  check('agent_ask: legacy from_agent', calls.at(-1)?.fromAgent === 'hans');
  check('agent_ask: legacy from_session', calls.at(-1)?.fromSession === 'main');
  check('agent_ask: legacy call id', calls.at(-1)?.agentAskCallId === 'c1');
  check('agent_ask: the A2A header rides in the prefix, not the text', calls.at(-1)?.turnPrefix === '[Message from agent hans, session main]' && calls.at(-1)?.text === 'q', String(calls.at(-1)?.turnPrefix));
  const stop = triggerChatAbort(A, S);
  check('abort found the turn', stop.aborted === true);
  const r = await p;
  check('stopped turn is failed', r?.outcome === 'failed');
  check('stopped turn says so', r?.error === STOPPED_BY_USER, String(r?.error));
  check('lock released after stop', getSessionLockStatus(A, S).busy === false);
}

// ── 3. beforeRun false: nothing runs, lock released, null ───────────
{
  const S = fresh();
  const before = calls.length;
  let ranBefore = false as boolean;
  const r = await startTurn({
    agent: A,
    session: S,
    text: 'x',
    origin: { kind: 'tmux', tmuxSession: 't' },
    beforeRun: () => {
      ranBefore = getSessionLockStatus(A, S).busy;
      return false;
    },
  });
  check('beforeRun ran under the lock', ranBefore === true);
  check('skipped: null', r === null);
  check('skipped: runner not called', calls.length === before);
  check('skipped: lock released', getSessionLockStatus(A, S).busy === false);
}

// ── 4. queue: FIFO, onQueued, lockSignal aborts only the WAIT ───────
{
  const S = fresh();
  const first = startTurn({ agent: A, session: S, text: '1', origin: { kind: 'human', via: 'chat' }, turnId: 'q1' });
  await tick();
  let ahead = -1;
  const ctrl = new AbortController();
  const second = startTurn({
    agent: A,
    session: S,
    text: '2',
    origin: { kind: 'voice', consultId: 'v1' },
    lockSignal: ctrl.signal,
    onQueued: (a) => {
      ahead = a;
    },
  });
  await tick();
  check('second queued behind first', ahead === 1, String(ahead));
  check('queue length 1', getSessionLockStatus(A, S).queueLength === 1);
  ctrl.abort();
  let err: unknown = null;
  try {
    await second;
  } catch (e) {
    err = e;
  }
  check('lockSignal: AbortError while queued', (err as Error)?.name === 'AbortError', String(err));
  check('lockSignal: first still running', getSessionLockStatus(A, S).busy === true && getSessionLockStatus(A, S).activeTurnId === 'q1');
  check('lockSignal: waiter gone', getSessionLockStatus(A, S).queueLength === 0);
  releaseRun!();
  await first;
  check('first finished normally', getSessionLockStatus(A, S).busy === false);
}

// ── 5. publish: default broadcasts, false is silent, a sink also broadcasts ──
{
  const S = fresh();
  published.length = 0;
  const p = startTurn({ agent: A, session: S, text: 'p', origin: { kind: 'sentinel', triggerId: 'tr', taskId: 'task_1' }, turnId: 'task_1' });
  await tick();
  const args = calls.at(-1)!;
  check('sentinel: legacy from_system', args.fromSystem === 'sentinel');
  check('sentinel: task id is the turn id', args.turnId === 'task_1' && getSessionLockStatus(A, S).activeCallId === 'task_1');
  await args.publishSse?.({ event: 'status', data: { msg: 'x' } });
  check('default publish broadcasts', published.length === 1 && published[0]!.session === S);
  releaseRun!();
  await p;

  const S2 = fresh();
  const p2 = startTurn({ agent: A, session: S2, text: 'p', origin: { kind: 'wake', about: 'job', ref: 'j1' }, publish: false });
  await tick();
  check('publish false: no publisher', calls.at(-1)!.publishSse === undefined);
  check('wake job: legacy from_system job', calls.at(-1)!.fromSystem === 'job');
  releaseRun!();
  await p2;

  const S3 = fresh();
  published.length = 0;
  const seen: string[] = [];
  const p3 = startTurn({
    agent: A,
    session: S3,
    text: 'p',
    origin: { kind: 'human', via: 'voice-stt' },
    publish: (ev) => {
      seen.push(ev.event);
    },
  });
  await tick();
  await calls.at(-1)!.publishSse?.({ event: 'status', data: { msg: 'y' } });
  check('sink sees the event', seen.length === 1);
  check('sink AND broadcast', published.length === 1);
  releaseRun!();
  await p3;
}

// ── 6. runner throws: lock + abort released, error propagates ───────
{
  const S = fresh();
  nextResult = () => {
    throw new Error('persona missing');
  };
  const p = startTurn({ agent: A, session: S, text: 'e', origin: { kind: 'browser', viewId: 'b', cause: 'activity' } });
  await tick();
  releaseRun!();
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  check('throw propagates', (err as Error)?.message === 'persona missing');
  check('throw: lock released', getSessionLockStatus(A, S).busy === false);
  check('throw: abort registry released', triggerChatAbort(A, S).aborted === false);
  nextResult = ok('done');
}

// ── 7. the signal is the authority: an engine that ends a stopped turn
//       "cleanly" (openai-compatible: outcome completed + marker text)
//       is still reported as stopped, with its text kept ──────────────
{
  const S = fresh();
  ignoreAbort = true;
  const p = startTurn({ agent: A, session: S, text: 'c', origin: { kind: 'wake', about: 'subagent', ref: 't1', depth: 2 } });
  await tick();
  check('wake subagent: depth carried', calls.at(-1)!.subagentDepth === 2);
  check('stop finds the registration', triggerChatAbort(A, S).aborted === true);
  nextResult = ok('[somora] aborted by user');
  releaseRun!();
  const r = await p;
  check('clean engine end after stop → failed, stopped by the user', r?.outcome === 'failed' && r?.error === STOPPED_BY_USER, JSON.stringify(r));
  check('engine text kept on the result', r?.finalText === '[somora] aborted by user');
  ignoreAbort = false;
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
