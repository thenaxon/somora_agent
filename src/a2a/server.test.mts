// somora as an A2A agent (docs/a2a.md), over real HTTP, with somora's own
// A2A client as the peer (so both ends are checked against each other)
// and raw 0.3 requests. The agent's turn is a stand-in (startTurn's test
// seam) that streams text, asks a question or waits to be stopped.
//   - cards: only agents with a2a: true, never a builder, nothing without peers;
//   - tokens: none or wrong → 401, a peer limited to other agents → not found;
//   - a task: blocking, streamed, returned at once and polled, 0.3 names;
//     one session per peer and conversation, quiet, the peer named in it;
//   - a question back: input-required, the next message answers it and
//     the same task finishes;
//   - a stop really stops the turn; a repeated messageId starts nothing;
//   - rate and daily limits; the tool deny for peer sessions; the login
//     key gate leaves exactly these paths open; idle conversations archive;
//   - the agent's a2a switch writes agent.yaml, refused for a builder.
import '../testing/own-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ConfigSchema } from '../config/types.ts';
import { setConfig } from '../server/server-state.ts';
import { configureStartTurn } from '../server/start-turn.ts';
import { askQuestion } from '../server/builder-questions.ts';
import { listSessions, sessionMetaStore } from '../storage/sessions.ts';
import { sessionToolDeny } from '../tools/gating.ts';
import type { RunChatTurnArgs } from '../server/run-turn.ts';
import type { ChatTurnResult } from '../server/run-turn-types.ts';
import { archiveIdlePeerSessions, isA2APublicPath, registerA2AInboundRoutes, resetInboundTasks } from './server.ts';
import { clearCardCache, getCard, runTask } from './client.ts';
import { registerAgentRoutes } from '../server/routes/agents.ts';

const home = process.env.SOMORA_HOME!;
for (const [name, yaml] of [
  ['ada', 'model: x\na2a: true\n'],
  ['bea', 'model: x\n'],
  ['cleo', 'model: x\na2a: true\n'],
  ['dora', 'model: x\nkind: builder\na2a: true\n'],
] as const) {
  mkdirSync(join(home, 'agents', name), { recursive: true });
  writeFileSync(join(home, 'agents', name, 'AGENTS.md'), `---\ndescription: ${name} the tester\n---\n# ${name}\n`);
  writeFileSync(join(home, 'agents', name, 'agent.yaml'), yaml);
}

const TOKEN = 'peer-token-0123456789abcdef';
const OTHER = 'other-token-0123456789abcdef';
function configure(a2a: Record<string, unknown>) {
  setConfig(ConfigSchema.parse({ providers: {}, a2a }));
  resetInboundTasks();
  clearCardCache();
}
configure({ peers: { hermes: { token: TOKEN }, narrow: { token: OTHER, agents: ['cleo'] } } });

// ── the stand-in turn ────────────────────────────────────────────────
type Script = (args: RunChatTurnArgs) => Promise<ChatTurnResult>;
const ok = (finalText: string): ChatTurnResult => ({ finalText, outcome: 'completed', tool_calls: 0, provider: 'p', model: 'm', ms: 1, contextWindow: 0, thinkingActive: false }) as ChatTurnResult;
const calls: RunChatTurnArgs[] = [];
let script: Script = async (args) => {
  await args.publishSse?.({ event: 'agent', data: { phase: 'start' } } as never);
  return ok(`echo: ${args.text}`);
};
configureStartTurn({
  chatTurnDeps: { config: {}, sessionMetaStore, tools: {}, onActivity: () => {} } as never,
  publish: () => {},
  runTurn: (args) => {
    calls.push(args);
    return script(args);
  },
});
const streamWords: Script = async (args) => {
  await args.publishSse?.({ event: 'agent', data: { phase: 'start' } } as never);
  let text = '';
  for (const w of ['\n\none ', 'two ', 'three']) {
    text += w;
    await args.publishSse?.({ event: 'chat', data: { state: 'delta', text } } as never);
    await new Promise((r) => setTimeout(r, 30));
  }
  // As the engines do: the final text is the streamed one, trimmed.
  text = text.trim();
  await args.publishSse?.({ event: 'chat', data: { state: 'final', text } } as never);
  await args.publishSse?.({ event: 'tool', data: { phase: 'call', tool: 'web_search', summary: '' } } as never);
  return ok(text);
};

// ── the server ───────────────────────────────────────────────────────
const app = new Hono();
registerA2AInboundRoutes(app);
registerAgentRoutes(app, { nextTurnPrompt: undefined as never, syncDreamers: async () => {} });
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise((r) => setTimeout(r, 50));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const rpc = async (agent: string, method: string, params: unknown, token = TOKEN) => {
  const res = await fetch(`${base}/a2a/agents/${agent}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message: { messageId: `m-${Math.random()}`, role: 'ROLE_USER', parts: [{ text }], ...extra } });

test('cards: agents with a2a: true only, never a builder; the default agent at the root', async () => {
  const card = await (await fetch(`${base}/a2a/agents/ada/.well-known/agent-card.json`)).json() as any;
  assert.equal(card.name, 'ada');
  assert.equal(card.description, 'ada the tester');
  assert.equal(card.supportedInterfaces[0].url, `${base}/a2a/agents/ada`);
  assert.equal(card.capabilities.streaming, true);
  assert.deepEqual(card.security, [{ bearer: [] }]);
  for (const a of ['bea', 'dora', 'nobody']) assert.equal((await fetch(`${base}/a2a/agents/${a}/.well-known/agent-card.json`)).status, 404, a);
  assert.equal((await fetch(`${base}/.well-known/agent-card.json`)).status, 404, 'no default agent set');
  configure({ peers: { hermes: { token: TOKEN } }, defaultAgent: 'ada', publicUrl: 'https://somora.example:18737' });
  const root = await (await fetch(`${base}/.well-known/agent-card.json`)).json() as any;
  assert.equal(root.supportedInterfaces[0].url, 'https://somora.example:18737/a2a/agents/ada');
  configure({});
  assert.equal((await fetch(`${base}/a2a/agents/ada/.well-known/agent-card.json`)).status, 404, 'no peers: nothing reachable');
  configure({ peers: { hermes: { token: TOKEN }, narrow: { token: OTHER, agents: ['cleo'] } } });
});

test('tokens: none or wrong is 401; a peer limited to other agents does not find this one', async () => {
  assert.equal((await rpc('ada', 'SendMessage', msg('x'), '')).status, 401);
  assert.equal((await rpc('ada', 'SendMessage', msg('x'), 'wrong-token-0123456789')).status, 401);
  const narrow = await rpc('ada', 'SendMessage', msg('x'), OTHER);
  assert.equal(narrow.status, 404);
  assert.equal(narrow.body.error.code, -32001);
  assert.equal((await rpc('bea', 'SendMessage', msg('x'))).status, 404, 'an agent without a2a: true');
  assert.equal((await rpc('ada', 'NoSuchMethod', {})).body.error.code, -32601);
});

test('a blocking SendMessage: the answer in the task; one quiet session per peer and conversation', async () => {
  script = async (args) => ok(`echo: ${args.text}`);
  calls.length = 0;
  const r = await rpc('ada', 'SendMessage', msg('hello', { contextId: 'conv-1' }));
  assert.equal(r.status, 200);
  const task = r.body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.contextId, 'conv-1');
  assert.equal(task.artifacts[0].parts[0].text, 'echo: hello');
  const turn = calls.at(-1)!;
  assert.equal(turn.origin?.kind, 'peer');
  assert.equal(turn.fromSystem, 'peer');
  assert.match(turn.turnPrefix ?? '', /^\[A task from 'hermes', an agent of another system, sent over A2A/);
  assert.equal(turn.text, 'hello', 'the stored text is the message itself');
  const sessions = (await listSessions('ada')).filter((s) => s.slug?.startsWith('a2a-hermes-'));
  assert.equal(sessions.length, 1);
  const meta = (await sessionMetaStore.get('ada', sessions[0]!.id)) as Record<string, unknown>;
  assert.deepEqual(meta.a2aPeer, { peer: 'hermes', contextId: 'conv-1' });
  assert.equal(meta.a2aQuiet, true);
  assert.deepEqual(sessionToolDeny({ a2a: { tools: { deny: ['exec'] } } }, meta), ['exec'], 'the peer session gets a2a.tools.deny');
  await rpc('ada', 'SendMessage', msg('again', { contextId: 'conv-1' }));
  await rpc('ada', 'SendMessage', msg('other', { contextId: 'conv-2' }));
  assert.equal((await listSessions('ada')).filter((s) => s.slug?.startsWith('a2a-hermes-')).length, 2);
});

test("somora's own client as the peer: the card, a streamed answer word by word", async () => {
  script = streamWords;
  const card = await getCard(`${base}/a2a/agents/ada`, { token: TOKEN, maxAgeMs: 1 });
  assert.equal(card.streaming, true);
  const seen: string[] = [];
  const notes: string[] = [];
  const out = await runTask({ card, token: TOKEN, text: 'stream it', contextId: 'conv-s', maxMs: 10_000, pollMaxMs: 100, onText: (t) => seen.push(t), onStatus: (_s, m) => m && notes.push(m) });
  assert.equal(out.state, 'completed');
  assert.equal(out.text, 'one two three');
  assert.ok(seen.length >= 2, `pieces: ${JSON.stringify(seen)}`);
  assert.equal(seen.filter((s) => s.trim() === 'one two three').length <= 2, true, 'the trimmed final text is not sent again as a replacement');
  assert.ok(notes.includes('using web_search'), JSON.stringify(notes));
});

test('returnImmediately, then GetTask; 0.3 names and shapes; ListTasks', async () => {
  script = async (args) => {
    await new Promise((r) => setTimeout(r, 200));
    return ok(`late: ${args.text}`);
  };
  const r = await rpc('ada', 'SendMessage', { ...msg('slow', { contextId: 'conv-p' }), configuration: { returnImmediately: true } });
  const id = r.body.result.task.id;
  assert.notEqual(r.body.result.task.status.state, 'TASK_STATE_COMPLETED');
  let state = '';
  for (let i = 0; i < 40 && state !== 'TASK_STATE_COMPLETED'; i++) {
    await new Promise((res) => setTimeout(res, 50));
    state = (await rpc('ada', 'GetTask', { id })).body.result.status.state;
  }
  assert.equal(state, 'TASK_STATE_COMPLETED');
  const old = await rpc('ada', 'message/send', { message: { kind: 'message', messageId: 'm03', role: 'user', parts: [{ kind: 'text', text: 'old style' }] } });
  assert.equal(old.body.result.kind, 'task');
  assert.equal(old.body.result.status.state, 'completed');
  assert.equal(old.body.result.artifacts[0].parts[0].kind, 'text');
  const list = (await rpc('ada', 'ListTasks', { contextId: 'conv-p' })).body.result.tasks;
  assert.equal(list.length, 1);
  assert.equal((await rpc('ada', 'GetTask', { id }, OTHER)).status, 404, 'another peer sees nothing of it');
});

test('a question back: input-required with the options; the next message answers it and the task finishes', async () => {
  script = async (args) => {
    await args.publishSse?.({ event: 'agent', data: { phase: 'start' } } as never);
    // As the real ask_user does: the question goes through the store
    // (the ask route), not through the turn's own stream.
    const answer = await askQuestion({ agent: args.agent, session: args.session, question: 'Which year?', options: [{ label: '2025' }, { label: '2026', description: 'this year' }], multiple: false, timeoutMs: 20_000 });
    return ok(`report for ${answer.answers.join(',')}`);
  };
  const first = await rpc('ada', 'SendMessage', msg('make the report', { contextId: 'conv-q' }));
  const t1 = first.body.result.task;
  assert.equal(t1.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(t1.status.message.parts[0].text, /^Which year\?\n\n1\) 2025\n2\) 2026 — this year/);
  const second = await rpc('ada', 'SendMessage', msg('2', { contextId: 'conv-q' }));
  const t2 = second.body.result.task;
  assert.equal(t2.id, t1.id, 'the same task goes on');
  assert.equal(t2.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(t2.artifacts[0].parts[0].text, 'report for 2026');
});

test('a stop really stops the turn; a stopped or finished task cannot be stopped again', async () => {
  let sawAbort = false;
  script = (args) =>
    new Promise((resolve) => {
      void args.publishSse?.({ event: 'agent', data: { phase: 'start' } } as never);
      args.signal?.addEventListener('abort', () => {
        sawAbort = true;
        resolve({ ...ok(''), outcome: 'failed', error: 'aborted' } as ChatTurnResult);
      });
    });
  const r = await rpc('ada', 'SendMessage', { ...msg('long', { contextId: 'conv-c' }), configuration: { returnImmediately: true } });
  const id = r.body.result.task.id;
  await new Promise((res) => setTimeout(res, 100));
  const c = await rpc('ada', 'CancelTask', { id });
  assert.equal(c.body.result.status.state, 'TASK_STATE_CANCELED');
  assert.equal(sawAbort, true);
  assert.equal((await rpc('ada', 'CancelTask', { id })).body.error.code, -32002);
});

test('a repeated messageId starts nothing new', async () => {
  script = async (args) => ok(`once: ${args.text}`);
  calls.length = 0;
  const m = { message: { messageId: 'same-id', role: 'ROLE_USER', parts: [{ text: 'hi' }], contextId: 'conv-d' } };
  const a = await rpc('ada', 'SendMessage', m);
  const b = await rpc('ada', 'SendMessage', m);
  assert.equal(a.body.result.task.id, b.body.result.task.id);
  assert.equal(calls.length, 1);
});

test('rate and daily limits answer 429 with the reason', async () => {
  configure({ peers: { hermes: { token: TOKEN } }, rateLimitPerMinute: 2 });
  script = async () => ok('x');
  await rpc('ada', 'SendMessage', msg('1'));
  await rpc('ada', 'SendMessage', msg('2'));
  const third = await rpc('ada', 'SendMessage', msg('3'));
  assert.equal(third.status, 429);
  assert.match(third.body.error.message, /rate limit/);
  configure({ peers: { hermes: { token: TOKEN } }, maxTasksPerDay: 1 });
  const usage = join(home, 'a2a', 'usage.json');
  writeFileSync(usage, JSON.stringify({ day: new Date().toISOString().slice(0, 10), counts: {} }));
  const day = new Date();
  const local = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  writeFileSync(usage, JSON.stringify({ day: local, counts: { 'peer-hermes': 1 } }));
  const over = await rpc('ada', 'SendMessage', msg('4'));
  assert.equal(over.status, 429);
  assert.match(over.body.error.message, /daily limit/);
  configure({ peers: { hermes: { token: TOKEN }, narrow: { token: OTHER, agents: ['cleo'] } } });
});

test('the login key gate leaves exactly the A2A paths open', () => {
  assert.equal(isA2APublicPath('GET', '/a2a/agents/ada/.well-known/agent-card.json'), true);
  assert.equal(isA2APublicPath('GET', '/.well-known/agent-card.json'), true);
  assert.equal(isA2APublicPath('POST', '/a2a/agents/ada'), true);
  assert.equal(isA2APublicPath('GET', '/a2a/agents/ada'), false);
  assert.equal(isA2APublicPath('POST', '/a2a/agents/ada/.well-known/agent-card.json'), false);
  assert.equal(isA2APublicPath('GET', '/a2a/turn-origin/ada/main'), false);
  assert.equal(isA2APublicPath('GET', '/a2a/ask-result'), false);
  assert.equal(isA2APublicPath('POST', '/a2a/agents/ada/extra'), false);
});

test('quiet conversations with peers are archived after a2a.archiveAfterDays', async () => {
  const before = (await listSessions('ada')).filter((s) => s.slug?.startsWith('a2a-hermes-')).length;
  assert.ok(before > 0);
  assert.equal(await archiveIdlePeerSessions(Date.now() + 8 * 24 * 60 * 60 * 1000), before);
  assert.equal((await listSessions('ada')).filter((s) => s.slug?.startsWith('a2a-hermes-')).length, 0);
});

test("the agent's a2a switch writes agent.yaml; a builder is refused", async () => {
  const off = await app.request('/agents/bea/a2a');
  assert.equal(((await off.json()) as any).on, false);
  const on = await app.request('/agents/bea/a2a', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) });
  const body = (await on.json()) as any;
  assert.equal(body.on, true);
  assert.deepEqual(body.peers, ['hermes']);
  assert.match(readFileSync(join(home, 'agents', 'bea', 'agent.yaml'), 'utf8'), /^a2a: true$/m);
  const builder = await app.request('/agents/dora/a2a', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) });
  assert.equal(builder.status, 409);
});

test('wrong tokens slow down their own address only, not the peers with the right one', async () => {
  for (let i = 0; i < 10; i++) await rpc('ada', 'GetTask', { id: 'x' }, `wrong-token-${i}-0123456789`);
  assert.equal((await rpc('ada', 'GetTask', { id: 'x' }, 'wrong-token-again-0123456789')).status, 429, 'this address waits now');
  // The test client shares the address; the brake is per address, so the
  // check here is that it is keyed by the connection, not by one bucket
  // for everyone: a header cannot move a sender out of it.
  const res = await fetch(`${base}/a2a/agents/ada`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope-0123456789abcdef', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }) });
  assert.equal(res.status, 429, 'a forged header does not escape the brake');
  script = async () => ok('still here');
  const right = await rpc('ada', 'SendMessage', msg('hello'));
  assert.equal(right.status, 200, 'the right token still passes from the same address');
});

test('by default a task from outside sets off no further agent work', () => {
  const meta = { a2aPeer: { peer: 'hermes', contextId: 'c' } };
  const deny = sessionToolDeny(ConfigSchema.parse({ providers: {} }), meta);
  for (const t of ['agent_ask', 'agent_ask_result', 'agent_ask_cancel', 'spawn_subagent', 'spawn_subagents', 'builder_dispatch', 'session_model', 'sentinel']) {
    assert.ok(deny.includes(t), t);
  }
  assert.equal(deny.includes('ask_user'), false, 'its question goes back to the sender');
});

// ── files ─────────────────────────────────────────────────────────────
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('files in: bytes in the message reach the turn as an attachment; a file alone is a task', async () => {
  script = async (args) => ok(`got ${args.attachments?.length ?? 0} file(s): ${args.attachments?.map((a) => `${a.name} ${a.mime}`).join(', ')}`);
  calls.length = 0;
  const r = await rpc('ada', 'SendMessage', { message: { messageId: `f-${Math.random()}`, role: 'ROLE_USER', contextId: 'files-1', parts: [{ raw: PNG.toString('base64'), mediaType: 'image/png', filename: 'dot.png' }] } });
  assert.equal(r.body.result.task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(r.body));
  assert.equal(r.body.result.task.artifacts[0].parts[0].text, 'got 1 file(s): dot.png image/png');
  assert.equal(calls.at(-1)!.text, '(a file is attached)');
  // 0.3 shape too
  const old = await rpc('ada', 'message/send', { message: { kind: 'message', messageId: `f03-${Math.random()}`, role: 'user', parts: [{ kind: 'text', text: 'and this' }, { kind: 'file', file: { bytes: PNG.toString('base64'), mimeType: 'image/png', name: 'old.png' } }] } });
  assert.equal(old.body.result.artifacts[0].parts[0].text, 'got 1 file(s): old.png image/png');
});

test('files in: a URL is fetched with the guard against internal addresses', async () => {
  const { createServer } = await import('node:http');
  const files = createServer((_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG));
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(files.address() as AddressInfo).port}/dot.png`;
  try {
    script = async (args) => ok(`got ${args.attachments?.length ?? 0}`);
    const refused = await rpc('ada', 'SendMessage', msg('look', { contextId: 'files-2', parts: [{ text: 'look' }, { url, mediaType: 'image/png', filename: 'dot.png' }] }));
    assert.equal(refused.body.error.code, -32602);
    assert.match(refused.body.error.message, /a file could not be taken: dot\.png: .*private/);
    setConfig(ConfigSchema.parse({ providers: {}, a2a: { peers: { hermes: { token: TOKEN } } }, web: { fetchAllowPrivate: ['127.0.0.1'] } }));
    const taken = await rpc('ada', 'SendMessage', { message: { messageId: `u-${Math.random()}`, role: 'ROLE_USER', contextId: 'files-3', parts: [{ text: 'look' }, { url, mediaType: 'image/png', filename: 'dot.png' }] } });
    assert.equal(taken.body.result.task.artifacts[0].parts[0].text, 'got 1');
  } finally {
    files.close();
    configure({ peers: { hermes: { token: TOKEN }, narrow: { token: OTHER, agents: ['cleo'] } } });
  }
});

test('files out: an image the agent made comes back as a download link that serves it', async () => {
  const imgPath = join(home, 'made.png');
  writeFileSync(imgPath, PNG);
  script = async () => ({ ...ok('here is the picture'), media: [{ type: 'image', id: 'm1', path: imgPath, filename: 'made.png', mime: 'image/png', prompt: 'p', url: '/media/m1/file' }] }) as ChatTurnResult;
  const r = await rpc('ada', 'SendMessage', msg('draw something', { contextId: 'files-4' }));
  const parts = r.body.result.task.artifacts[0].parts;
  assert.equal(parts[0].text, 'here is the picture');
  assert.equal(parts[1].mediaType, 'image/png');
  assert.equal(parts[1].filename, 'made.png');
  assert.match(parts[1].url, new RegExp(`^${base}/a2a/files/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$`));
  const got = await fetch(parts[1].url);
  assert.equal(got.status, 200, 'open without the login key: the token is the key');
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await got.arrayBuffer()).equals(PNG), true);
  const tampered = parts[1].url.replace(/.$/, (ch: string) => (ch === 'A' ? 'B' : 'A'));
  assert.equal((await fetch(tampered)).status, 404);
  assert.equal(isA2APublicPath('GET', new URL(parts[1].url).pathname), true);
  assert.equal(isA2APublicPath('GET', '/a2a/files/../../etc'), false);
});

test('download links expire after an hour', async () => {
  const { fileLinkToken, verifyFileLink } = await import('./files.ts');
  const f = { hash: 'a'.repeat(64), name: 'x.png', mime: 'image/png', size: 1 };
  const tok = fileLinkToken(f, 1_000);
  assert.deepEqual(verifyFileLink(tok, 1_000 + 59 * 60_000), { hash: f.hash, mime: 'image/png', name: 'x.png' });
  assert.deepEqual(verifyFileLink(tok, 1_000 + 61 * 60_000), { error: 'this link has expired' });
});
