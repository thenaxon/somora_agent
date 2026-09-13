// The origin → legacy-field table IS the compatibility contract of the
// turn-dispatch refactor (private/turn-dispatch-design.md §2.1): every
// stored session, SSE consumer and engine adapter keeps reading
// from_agent / from_session / from_system / agent_ask_call_id exactly
// as before. Pin it.
//
// Run: npx tsx src/server/turn-origin-kind.test.mts

import assert from 'node:assert/strict';
import { originCallId, originKind, originLabel, originToLegacy, type TurnOrigin } from './turn-origin-kind.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};
const same = (name: string, a: unknown, b: unknown): void => check(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

const cases: Array<[string, TurnOrigin, ReturnType<typeof originToLegacy>, 'user' | 'agent', string]> = [
  ['human typed', { kind: 'human', via: 'chat' }, {}, 'user', 'human'],
  ['human dictated', { kind: 'human', via: 'voice-stt' }, {}, 'user', 'human'],
  [
    'agent_ask with session + call id',
    { kind: 'agent', from: { agent: 'hans', session: '20260906-172957_cerebrocraft' }, callId: 'c1' },
    { fromAgent: 'hans', fromSession: '20260906-172957_cerebrocraft', agentAskCallId: 'c1' },
    'agent',
    'agent',
  ],
  [
    'agent via /chat/send without session (third-party shape)',
    { kind: 'agent', from: { agent: 'hans' } },
    { fromAgent: 'hans' },
    'agent',
    'agent',
  ],
  ['subagent depth 1', { kind: 'subagent', depth: 1, taskId: 't1', parent: { agent: 'p', session: 's' } }, { subagentDepth: 1 }, 'agent', 'subagent'],
  ['subagent depth 0 stays unlabelled', { kind: 'subagent', depth: 0 }, {}, 'agent', 'subagent'],
  ['sentinel', { kind: 'sentinel', triggerId: 'tr', taskId: 'task_1' }, { fromSystem: 'sentinel' }, 'agent', 'sentinel'],
  ['tmux', { kind: 'tmux', tmuxSession: 'oc-x' }, { fromSystem: 'tmux' }, 'agent', 'tmux'],
  ['browser', { kind: 'browser', viewId: 'b1@hans', cause: 'handoff', handoffId: 'h1' }, { fromSystem: 'browser' }, 'agent', 'browser'],
  ['voice', { kind: 'voice', consultId: 'v1', callId: 'call1' }, { fromSystem: 'voice' }, 'agent', 'voice'],
  ['wake a2a', { kind: 'wake', about: 'a2a', ref: 'c1' }, { fromSystem: 'a2a' }, 'agent', 'wake:a2a'],
  ['wake subagent at depth', { kind: 'wake', about: 'subagent', ref: 't1', depth: 2 }, { fromSystem: 'subagent', subagentDepth: 2 }, 'agent', 'wake:subagent'],
  ['wake job', { kind: 'wake', about: 'job', ref: 'j1' }, { fromSystem: 'job' }, 'agent', 'wake:job'],
];

for (const [name, origin, legacy, label, kind] of cases) {
  same(`${name}: legacy fields`, originToLegacy(origin), legacy);
  check(`${name}: label`, originLabel(origin) === label, originLabel(origin));
  check(`${name}: kind`, originKind(origin) === kind, originKind(origin));
}

check('call id: agent_ask', originCallId({ kind: 'agent', from: { agent: 'a' }, callId: 'c9' }) === 'c9');
check('call id: async sub', originCallId({ kind: 'subagent', depth: 1, taskId: 't9' }) === 't9');
check('call id: sentinel', originCallId({ kind: 'sentinel', triggerId: 'x', taskId: 't8' }) === 't8');
check('call id: none for human', originCallId({ kind: 'human', via: 'chat' }) === undefined);
check('call id: none for wake', originCallId({ kind: 'wake', about: 'a2a', ref: 'c' }) === undefined);

// from_session never travels without from_agent — the stored shape
// depends on it (sse-serializer, run-turn).
const l = originToLegacy({ kind: 'agent', from: { agent: 'a', session: 's' } });
check('from_session only with from_agent', l.fromAgent === 'a' && l.fromSession === 's');

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
