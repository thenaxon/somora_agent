// A builder on claude-cli, codex-cli or grok-cli that ends its turn while
// it still owes its order something gets a follow-up turn before the
// asker hears of the result (start-turn.ts holdBuilderToOrder, check in
// builder-turn-end.ts). openai-compatible asks inside its own turn
// (src/engine/builder-turn-end.test.mts) and is left alone here.
//
// Run: npx tsx src/server/builder-follow-up.test.mts

import assert from 'node:assert/strict';

import { triggerChatAbort } from './chat-aborts.ts';
import { claimOfSession, claimWorkdir, releaseWorkdir } from './builder-busy.ts';
import { mergeBuilderAcceptance } from './builder-acceptance.ts';
import { checkBuilderTurnEnd, followUpNotice, turnWorked } from './builder-turn-end.ts';
import type { RunChatTurnArgs } from './run-turn.ts';
import type { ChatTurnResolveDeps, ChatTurnResult } from './run-turn-types.ts';
import { getSessionLockStatus } from './session-queue.ts';
import { configureStartTurn, startTurn, STOPPED_BY_USER } from './start-turn.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log('  ok  ', name);
  } else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};

// ── the check itself ────────────────────────────────────────────────
{
  const required = { acceptanceRequired: true };
  check('worked: file_write, file_patch, todo_write', turnWorked(['exec', 'file_patch']) && turnWorked(['todo_write']) && !turnWorked(['exec', 'file_read']));
  check(
    'required, worked, no list: missing',
    checkBuilderTurnEnd({ meta: required, worked: true, todoWritten: false, acceptanceWritten: false, acceptanceTool: true })?.accMissing === true,
  );
  check(
    'required, only answered: nothing',
    checkBuilderTurnEnd({ meta: required, worked: false, todoWritten: false, acceptanceWritten: false, acceptanceTool: true }) === null,
  );
  check(
    'not required, list not written this turn: nothing',
    checkBuilderTurnEnd({ meta: { acceptance: mergeBuilderAcceptance([], [{ id: 'A01', requirement: 'r' }]).items }, worked: true, todoWritten: false, acceptanceWritten: false, acceptanceTool: true }) === null,
  );
  const openItems = mergeBuilderAcceptance([], [{ id: 'A01', requirement: 'r' }, { id: 'A02', requirement: 's', status: 'passed', evidence: 'e' }]).items;
  const c = checkBuilderTurnEnd({ meta: { ...required, acceptance: openItems }, worked: true, todoWritten: false, acceptanceWritten: false, acceptanceTool: true });
  check('required with an open item: that item', c?.accOpen.map((i) => i.id).join() === 'A01');
  const t = checkBuilderTurnEnd({
    meta: { todos: [{ content: 'wire the API', status: 'in_progress' }, { content: 'done', status: 'completed' }] },
    worked: true,
    todoWritten: true,
    acceptanceWritten: false,
    acceptanceTool: true,
  });
  check('open task when the turn worked the list', t?.open.length === 1);
  const text = followUpNotice(t!);
  check('notice names the task and asks for the full report', /"wire the API"/.test(text) && /complete report again/.test(text) && text.startsWith('[somora]'), text);
}

// ── the follow-up turns ─────────────────────────────────────────────
let meta: Record<string, unknown> = {};
const store = {
  async get() {
    return { ...meta };
  },
  async update(_a: string, _s: string, f: (m: Record<string, unknown>) => Record<string, unknown>) {
    meta = f({ ...meta });
    return meta;
  },
};
const deps = { config: {}, sessionMetaStore: store, tools: {}, onActivity: () => {} } as unknown as ChatTurnResolveDeps;

type Step = { text?: string; tools?: string[]; then?: () => void; engine?: string; kind?: string; outcome?: ChatTurnResult['outcome']; hold?: boolean };
let steps: Step[] = [];
const calls: RunChatTurnArgs[] = [];
let releaseHeld: (() => void) | null = null;

const resultOf = (s: Step): ChatTurnResult =>
  ({
    finalText: s.text ?? '',
    outcome: s.outcome ?? 'completed',
    tool_calls: s.tools?.length ?? 0,
    ...(s.tools && s.tools.length > 0 ? { tools_used: [...new Set(s.tools)] } : {}),
    engine: s.engine ?? 'claude-cli',
    agentKind: s.kind ?? 'builder',
    contextWindow: 1,
    provider: 'p',
    model: 'm',
    thinkingActive: false,
    ms: 1,
  }) as ChatTurnResult;

configureStartTurn({
  chatTurnDeps: deps,
  publish: () => {},
  runTurn: (args) => {
    calls.push(args);
    const s = steps.shift() ?? { text: 'extra turn' };
    s.then?.();
    if (!s.hold) return Promise.resolve(resultOf(s));
    return new Promise((resolve) => {
      releaseHeld = () => resolve(resultOf(s));
      args.signal?.addEventListener('abort', () => resolve({ ...resultOf(s), outcome: 'failed', error: 'aborted' } as ChatTurnResult));
    });
  },
});

const A = 'bert';
let n = 0;
const order = { kind: 'agent' as const, from: { agent: 'ada', session: 'main' }, callId: 'c1' };
const build = (extra: Record<string, unknown> = {}) => {
  meta = { builderMode: 'unattended', builderPhase: 'build', ...extra };
  calls.length = 0;
};
const writeList = (items: unknown[]) => () => {
  const prev = (meta.acceptance as never[]) ?? [];
  meta = { ...meta, acceptance: mergeBuilderAcceptance(prev, items).items };
};

// 1. claude-cli, list required and missing: one follow-up, then done.
{
  build({ acceptanceRequired: true });
  steps = [
    { text: 'Report: built it.', tools: ['file_write', 'exec'] },
    { text: 'Report: built it, list written.', tools: ['acceptance_write'], then: writeList([{ id: 'A01', requirement: 'it builds', status: 'passed', evidence: 'npm run build: exit 0' }]) },
  ];
  const r = await startTurn({ agent: A, session: `s${++n}`, text: 'build it', origin: order });
  check('1: two turns', calls.length === 2, String(calls.length));
  const f = calls[1]!;
  check('1: follow-up is somora speaking', f.origin?.kind === 'wake' && f.origin.about === 'system' && f.origin.cause === 'open items', JSON.stringify(f.origin));
  check('1: follow-up names the missing list', /requires an acceptance list and there is none/.test(f.text), f.text);
  check('1: follow-up has its own turn id', f.turnId !== calls[0]!.turnId);
  check('1: the asker reads the last report', r?.finalText.startsWith('Report: built it, list written.') === true, r?.finalText);
  check('1: … with the list from the session', /## Acceptance list \(from the session\)[\s\S]*\| A01 \| it builds \| passed \| npm run build: exit 0 \|/.test(r?.finalText ?? ''));
  check('1: tool calls of both turns', r?.tool_calls === 3, String(r?.tool_calls));
  check('1: lock free after', getSessionLockStatus(A, `s${n}`).busy === false);
}

// 2. It never writes the list: two follow-ups, no more.
{
  build({ acceptanceRequired: true });
  steps = [
    { text: 'r1', tools: ['file_patch'] },
    { text: 'r2', tools: ['exec'] },
    { text: 'r3', tools: ['exec'] },
  ];
  const r = await startTurn({ agent: A, session: `s${++n}`, text: 'build it', origin: order });
  check('2: at most two follow-ups', calls.length === 3, String(calls.length));
  check('2: last report', r?.finalText === 'r3', r?.finalText);
}

// 3. A follow-up without a tool call is its considered answer.
{
  build({ acceptanceRequired: true });
  steps = [
    { text: 'r1', tools: ['file_write'] },
    { text: 'Blocked: no access to the staging host, so no list can be checked.' },
  ];
  const r = await startTurn({ agent: A, session: `s${++n}`, text: 'build it', origin: order });
  check('3: one follow-up', calls.length === 2, String(calls.length));
  check('3: the blocker is the answer', /^Blocked/.test(r?.finalText ?? ''));
}

// 4. An empty follow-up answer keeps the report already given.
{
  build({ todos: [] });
  steps = [
    { text: 'The full report.', tools: ['todo_write'], then: () => (meta = { ...meta, todos: [{ content: 'tests', status: 'pending' }] }) },
    { text: '', tools: ['todo_write'], then: () => (meta = { ...meta, todos: [{ content: 'tests', status: 'completed' }] }) },
  ];
  const r = await startTurn({ agent: A, session: `s${++n}`, text: 'build it', origin: { kind: 'human', via: 'chat' } });
  check('4: open task → follow-up', calls.length === 2 && /"tests"/.test(calls[1]!.text), calls[1]?.text);
  check('4: empty answer keeps the report', r?.finalText === 'The full report.', r?.finalText);
}

// 5. Who is left alone.
{
  build({ acceptanceRequired: true, acceptance: mergeBuilderAcceptance([], [{ id: 'A01', requirement: 'r' }]).items });
  steps = [{ text: 'It is up.', tools: ['exec', 'file_read'] }];
  const up = await startTurn({ agent: A, session: `s${++n}`, text: 'is it up?', origin: order });
  check('5a: a turn that only answered: no follow-up', calls.length === 1);
  check('5a: … and no table under the answer', up?.finalText === 'It is up.', up?.finalText);

  build({ acceptanceRequired: true });
  steps = [{ text: 'r', tools: ['file_write'], engine: 'openai-compatible' }];
  await startTurn({ agent: A, session: `s${++n}`, text: 'x', origin: order });
  check('5b: openai-compatible asked inside its own turn', calls.length === 1);

  build({ acceptanceRequired: true, builderPhase: 'plan' });
  steps = [{ text: 'Plan ready', tools: ['file_write'] }];
  await startTurn({ agent: A, session: `s${++n}`, text: 'x', origin: order });
  check('5c: plan phase', calls.length === 1);

  build({ acceptanceRequired: true });
  steps = [{ text: 'r', tools: ['file_write'], kind: 'chat' }];
  const r = await startTurn({ agent: A, session: `s${++n}`, text: 'x', origin: order });
  check('5d: a chat agent, and its answer is not extended', calls.length === 1 && r?.finalText === 'r');

  build({ acceptanceRequired: true });
  steps = [{ text: 'r', tools: ['file_write'], outcome: 'failed' }];
  await startTurn({ agent: A, session: `s${++n}`, text: 'x', origin: order });
  check('5e: a failed turn', calls.length === 1);

  for (const engine of ['codex-cli', 'grok-cli']) {
    build({ acceptanceRequired: true });
    steps = [{ text: 'r', tools: ['file_write'], engine }, { text: 'r2', engine }];
    await startTurn({ agent: A, session: `s${++n}`, text: 'x', origin: order });
    check(`5f: ${engine} gets the follow-up too`, calls.length === 2);
  }
}

// 6. Stop during a follow-up: the asker reads "stopped by the user".
{
  build({ acceptanceRequired: true });
  steps = [{ text: 'r1', tools: ['file_write'] }, { text: 'r2', tools: ['exec'], hold: true }];
  const S = `s${++n}`;
  const p = startTurn({ agent: A, session: S, text: 'build it', origin: order });
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  check('6: follow-up holds the lock', getSessionLockStatus(A, S).busy === true);
  const stop = triggerChatAbort(A, S);
  check('6: Stop reaches the follow-up', stop.aborted === true);
  const r = await p;
  check('6: stopped', r?.outcome === 'failed' && r.error === STOPPED_BY_USER, JSON.stringify(r));
  check('6: no third turn', calls.length === 2);
  releaseHeld = null;
}

// 7. A failed follow-up (rate limit) does not undo the order.
{
  build({ acceptanceRequired: true });
  steps = [{ text: 'Report: all built.', tools: ['file_write'] }, { text: '', tools: [], outcome: 'failed' }];
  const r = await startTurn({ agent: A, session: `s${++n}`, text: 'build it', origin: order });
  check('7: the order stays completed', r?.outcome === 'completed', JSON.stringify(r));
  check('7: … with its report', r?.finalText === 'Report: all built.', r?.finalText);
}

// 8. A stop naming the order's turn id reaches the follow-up (somora acp
//    stops "its" turn by id).
{
  build({ acceptanceRequired: true });
  steps = [{ text: 'r1', tools: ['file_write'] }, { text: 'r2', tools: ['exec'], hold: true }];
  const S = `s${++n}`;
  const p = startTurn({ agent: A, session: S, text: 'build it', origin: order, turnId: 'order-turn' });
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  check('8: stop by the order turn id', triggerChatAbort(A, S, 'order-turn').aborted === true);
  const r = await p;
  check('8: stopped, tools of both turns kept', r?.error === STOPPED_BY_USER && r.tool_calls === 2 && (r.tools_used ?? []).includes('exec'), JSON.stringify(r));
}

// 9. The running-turn line shows the follow-up, not the order's turn.
{
  claimWorkdir({ agent: A, session: 'claims', turnId: 'first', workdir: '/w' });
  claimWorkdir({ agent: A, session: 'claims', turnId: 'second', workdir: '/w' });
  check('9: newest claim of the session', claimOfSession(A, 'claims')?.turnId === 'second');
  releaseWorkdir('second');
  check('9: back to the order turn', claimOfSession(A, 'claims')?.turnId === 'first');
  releaseWorkdir('first');
}

console.log(`\nbuilder follow-up: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
process.exit(0);
