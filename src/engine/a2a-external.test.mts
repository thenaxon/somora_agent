// Handing an external agent work over A2A (docs/a2a.md), through the real
// turn entry (runChatTurn) against a stand-in peer:
//   - a somora agent's question goes over A2A, not ACP; the session shows
//     who asked and the answer; it gets no unread dot;
//   - the task starts with one line naming the asker, its team title and
//     the principal; the setting switches it off;
//   - one session = one conversation over there; a reset starts a new one;
//   - a sub-agent spawn (origin subagent) goes over A2A too;
//   - an agent without A2A access, and images, are refused with a clear
//     reason; a question back, a refusal, an unreachable peer, a stop and
//     the daily limit end the turn with a message that says what happened;
//   - at most N tasks per agent run at once, the rest wait.
import '../testing/own-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConfigSchema, type Config } from '../config/types.ts';
import { setConfig } from '../server/server-state.ts';
import { runChatTurn } from '../server/run-turn.ts';
import { registerSessionRoutes } from '../server/routes/sessions.ts';
import { createSession, getHistory, listSessions, sessionMetaStore } from '../storage/sessions.ts';
import { clearCardCache } from '../a2a/client.ts';
import { resetSlots, slotState } from '../a2a/limits.ts';
import { resetTeamCache } from '../team/store.ts';
import { A2A_CONTEXT_KEY } from './a2a-external.ts';
import { startFakePeer, type FakePeer } from '../a2a/__fixtures__/fake-peer.ts';
import type { SseEvent } from '../types/events.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '---\nrole: Research lead\n---\n# ada\n');
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(
  join(home, 'team.yaml'),
  'version: 1\nprincipal:\n  name: Pat\nagents:\n  ada:\n    reports_to: principal\n    title: Research lead\n',
);

const peers: FakePeer[] = [];
after(async () => {
  for (const p of peers) await p.close();
});

let config: Config;
function configure(peerUrl: string, a2a: Record<string, unknown> = {}) {
  config = ConfigSchema.parse({
    providers: {},
    external: {
      a2a,
      systems: {
        loc: {
          transport: { local: true },
          agents: {
            probe: { command: 'false', a2a: { url: peerUrl, token: 'tok' } },
            chatonly: { command: 'false' },
          },
        },
      },
    },
  });
  setConfig(config);
  clearCardCache();
  resetSlots();
  resetTeamCache();
}

async function peer(opts: Parameters<typeof startFakePeer>[0] = {}): Promise<FakePeer> {
  const p = await startFakePeer({ token: 'tok', ...opts });
  peers.push(p);
  return p;
}

async function ask(session: string, text: string, extra: Record<string, unknown> = {}) {
  const sid = (await listSessions('probe')).find((s) => s.slug === session || s.id === session)?.id ?? (await createSession('probe', session));
  const events: SseEvent[] = [];
  const result = await runChatTurn({
    agent: 'probe',
    session: sid,
    text,
    fromAgent: 'ada',
    fromSession: 'main',
    origin: { kind: 'agent', from: { agent: 'ada', session: 'main' }, callId: 'c1' },
    agentAskCallId: 'c1',
    publishSse: async (e) => {
      events.push(e);
    },
    deps: { config, sessionMetaStore, tools: undefined as never, onActivity: () => {} },
    ...extra,
  } as Parameters<typeof runChatTurn>[0]);
  return { sid, result, events, history: await getHistory('probe', sid) };
}

test('a somora agent asks: over A2A, the session shows who asked and the answer, no unread dot', async () => {
  const p = await peer();
  configure(p.url);
  const { sid, result, events, history } = await ask('a2a-ada', 'What is 2+2?');
  assert.equal(result.outcome, 'completed');
  assert.match(result.finalText, /^echo: \[a task from ada \(Research lead\), an agent of Pat's somora team, sent over A2A\]\n\nWhat is 2\+2\?$/);
  const user = history.find((e) => e.kind === 'user_message') as Record<string, unknown>;
  assert.equal(user.from_agent, 'ada');
  assert.equal(user.engine, 'a2a');
  assert.equal(user.text, 'What is 2+2?', 'the session keeps the question as asked');
  assert.ok(history.some((e) => e.kind === 'assistant_message' && e.engine === 'a2a'));
  assert.ok(history.some((e) => e.kind === 'engine_meta' && /sent to probe over A2A/.test(String((e as { payload?: { text?: string } }).payload?.text))));
  const start = events.find((e) => e.event === 'agent' && (e.data as { phase?: string }).phase === 'start')!;
  assert.deepEqual((start.data as { external?: unknown }).external, { system: 'loc', via: 'a2a' });
  assert.equal(p.requests[0]!.auth, 'Bearer tok');
  const meta = (await sessionMetaStore.get('probe', sid)) as Record<string, unknown>;
  assert.equal(meta.a2aQuiet, true);
  assert.equal(typeof meta[A2A_CONTEXT_KEY], 'string');
  const row = (await listSessions('probe')).find((s) => s.id === sid)!;
  assert.equal(row.unreadAt ?? null, null);
});

test('one session = one conversation over there; a reset starts a new one', async () => {
  const p = await peer({ finish: (_t, _c, h) => ({ state: 'TASK_STATE_COMPLETED', answer: `earlier tasks: ${h.length}` }) });
  configure(p.url, { introduce: false });
  const first = await ask('conv', 'one');
  assert.equal(first.result.finalText, 'earlier tasks: 0');
  const second = await ask('conv', 'two');
  assert.equal(second.result.finalText, 'earlier tasks: 1');
  const ctx1 = p.requests[0]!.params.message.contextId;
  assert.equal(p.requests[1]!.params.message.contextId, ctx1);
  assert.equal(p.requests[0]!.params.message.parts[0].text, 'one', 'introduce: false sends the text alone');

  const app = new Hono();
  registerSessionRoutes(app, { nextTurnPrompt: undefined as never, publish: (async () => {}) as never, resolveEffectiveModel: undefined as never, streamKey: ((a: string, s: string) => `${a}::${s}`) as never, streams: new Map() as never });
  const r = await app.request(`/agents/probe/sessions/${first.sid}/reset`, { method: 'POST' });
  assert.equal(r.status, 200);
  const meta = (await sessionMetaStore.get('probe', first.sid)) as Record<string, unknown>;
  assert.equal(meta[A2A_CONTEXT_KEY], undefined);
  assert.equal(meta.a2aQuiet, true, 'still no unread dot after the reset');
  const third = await ask('conv', 'three');
  assert.equal(third.result.finalText, 'earlier tasks: 0', 'the other side starts fresh');
  assert.notEqual(p.requests.at(-1)!.params.message.contextId, ctx1);
});

test('a sub-agent spawn goes over A2A too, named as a sub-task', async () => {
  const p = await peer();
  configure(p.url);
  const { result } = await ask('sub-ada-001-abcd', 'research this', {
    fromAgent: undefined,
    fromSession: undefined,
    agentAskCallId: undefined,
    origin: { kind: 'subagent', depth: 1, taskId: 't1', parent: { agent: 'ada', session: 'main' } },
  });
  assert.equal(result.outcome, 'completed');
  assert.match(p.requests[0]!.params.message.parts[0].text, /^\[a sub-task from ada/);
});

test('refused with a reason: no A2A access, images', async () => {
  const p = await peer();
  configure(p.url);
  const sid = await createSession('chatonly', 'x');
  await assert.rejects(
    runChatTurn({ agent: 'chatonly', session: sid, text: 'hi', fromAgent: 'ada', origin: { kind: 'agent', from: { agent: 'ada' } }, deps: { config, sessionMetaStore, tools: undefined as never, onActivity: () => {} } }),
    /without A2A access.*external\.systems\.loc\.agents\.chatonly\.a2a/,
  );
  await assert.rejects(ask('img', 'look', { attachments: [{ hash: 'h', name: 'a.png', mime: 'image/png', size: 1 }] }), /images and files cannot be handed/);
  assert.equal(p.requests.length, 0, 'nothing reached the peer');
});

test('a question back: the answer says so and how to reply', async () => {
  const p = await peer({ finish: () => ({ state: 'TASK_STATE_INPUT_REQUIRED', said: 'Which year?' }) });
  configure(p.url);
  const { result } = await ask('q', 'report');
  assert.equal(result.outcome, 'completed');
  assert.match(result.finalText, /^Which year\?\n\n\[probe needs an answer before it goes on — reply with agent_ask to probe in this same session/);
});

test('refusal, failure and an unreachable peer end the turn as failed, with the reason', async () => {
  const p = await peer({ finish: (t) => (t.endsWith('no') ? { state: 'TASK_STATE_REJECTED', said: 'not my job' } : { state: 'TASK_STATE_FAILED', said: 'disk full' }) });
  configure(p.url, { introduce: false });
  const no = await ask('f1', 'no');
  assert.equal(no.result.outcome, 'failed');
  assert.match(no.result.error ?? '', /probe refused the task: not my job/);
  const bad = await ask('f2', 'x');
  assert.match(bad.result.error ?? '', /probe could not do the task: disk full/);
  configure('http://127.0.0.1:9');
  const down = await ask('f3', 'x');
  assert.equal(down.result.outcome, 'failed');
  assert.match(down.result.error ?? '', /probe \(A2A\): agent card .* not reachable/);
});

test('a stop: the turn ends with the marker and whether the other side confirmed it', async () => {
  const p = await peer({ workMs: 5_000 });
  configure(p.url);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const { result } = await ask('stop', 'long', { signal: ac.signal });
  assert.equal(result.finalText, '[somora] stopped — probe confirmed the stop');
  const q = await peer({ workMs: 5_000, cancel: 'unsupported' });
  configure(q.url);
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 200);
  const r2 = await ask('stop2', 'long', { signal: ac2.signal });
  assert.equal(r2.result.finalText, '[somora] stopped — probe may still finish it on its side');
});

test('at most N at once per external agent; the rest wait (and say so)', async () => {
  const p = await peer({ workMs: 1_500 });
  configure(p.url, { maxConcurrentPerAgent: 2 });
  const runs = [ask('p1', 'a'), ask('p2', 'b'), ask('p3', 'c')];
  // Wait for the state, not for a time: under a loaded test run the
  // three turns take a while to reach the line.
  for (let i = 0; i < 100 && slotState('probe').waiting === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(slotState('probe'), { running: 2, waiting: 1 });
  assert.equal(p.requests.filter((r) => r.method === 'SendMessage').length <= 2, true, 'the third was not sent yet');
  const done = await Promise.all(runs);
  assert.ok(done.every((d) => d.result.outcome === 'completed'));
  // Whichever arrived last waited, and its session says so.
  const waited = done.filter((d) => d.history.some((e) => e.kind === 'engine_meta' && /waiting for a free slot/.test(String((e as { payload?: { text?: string } }).payload?.text))));
  assert.equal(waited.length, 1);
});

test('the daily limit stops the task before anything is sent', async () => {
  rmSync(join(home, 'a2a'), { recursive: true, force: true });
  const p = await peer();
  configure(p.url, { maxCallsPerDay: 1 });
  assert.equal((await ask('d1', 'a')).result.outcome, 'completed');
  const second = await ask('d2', 'b');
  assert.equal(second.result.outcome, 'failed');
  assert.match(second.result.error ?? '', /daily limit for external agents reached \(1 tasks, external\.a2a\.maxCallsPerDay\)/);
  assert.equal(p.requests.filter((r) => r.method === 'SendMessage').length, 1);
});
