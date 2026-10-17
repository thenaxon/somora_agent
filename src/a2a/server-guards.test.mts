// somora as an A2A agent: the guards around a task from outside, over real
// HTTP with raw requests (docs/a2a.md).
//   - a body beyond the cap is refused before it is parsed, a file beyond
//     the limit before it is decoded, and neither costs a task of the day;
//   - the same message sent twice at once runs once; two first messages
//     of a new conversation share one session;
//   - a stop while the turn is still getting ready stops it;
//   - status requests count too (in their own, bigger bucket), and a peer
//     keeps at most ten streams open;
//   - a repeated streaming message for a finished task closes the stream;
//   - the daily limit is checked before a file is fetched;
//   - many finished tasks never push out one that still waits in line,
//     and with every place taken by open tasks a new one is refused;
//   - a reply that names only its task answers that task's question.
import '../testing/own-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ConfigSchema } from '../config/types.ts';
import { setConfig } from '../server/server-state.ts';
import { configureStartTurn } from '../server/start-turn.ts';
import { askQuestion } from '../server/builder-questions.ts';
import { listSessions, sessionMetaStore } from '../storage/sessions.ts';
import type { RunChatTurnArgs } from '../server/run-turn.ts';
import type { ChatTurnResult } from '../server/run-turn-types.ts';
import { registerA2AInboundRoutes, resetInboundTasks } from './server.ts';
import { dailyCalls } from './limits.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '---\ndescription: ada the tester\n---\n# ada\n');
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\na2a: true\n');

const TOKEN = 'peer-token-0123456789abcdef';
function configure(a2a: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  setConfig(ConfigSchema.parse({ providers: {}, a2a: { peers: { hermes: { token: TOKEN } }, rateLimitPerMinute: 100_000, maxTasksPerDay: 100_000, ...a2a }, ...extra }));
  resetInboundTasks();
}
configure();

type Script = (args: RunChatTurnArgs) => Promise<ChatTurnResult>;
const ok = (finalText: string): ChatTurnResult => ({ finalText, outcome: 'completed', tool_calls: 0, provider: 'p', model: 'm', ms: 1, contextWindow: 0, thinkingActive: false }) as ChatTurnResult;
const start = (args: RunChatTurnArgs) => args.publishSse?.({ event: 'agent', data: { phase: 'start' } } as never);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
let script: Script = async (args) => {
  await start(args);
  return ok('x');
};
configureStartTurn({
  chatTurnDeps: { config: {}, sessionMetaStore, tools: {}, onActivity: () => {} } as never,
  publish: () => {},
  runTurn: (args) => {
    calls += 1;
    return script(args);
  },
});

const app = new Hono();
registerA2AInboundRoutes(app);
const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await sleep(50);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const post = (body: string, signal?: AbortSignal) =>
  fetch(`${base}/a2a/agents/ada`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body, ...(signal ? { signal } : {}) });
const rpc = async (method: string, params: unknown) => {
  const res = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  return { status: res.status, body: (await res.json()) as any };
};
let n = 0;
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message: { messageId: `m-${++n}`, role: 'ROLE_USER', parts: [{ text }], ...extra } });
const now = { returnImmediately: true };
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('a body beyond the cap is refused before parsing; a file beyond the limit before decoding; neither counts', async () => {
  // Small limits: the cap is then about 0.7 MB.
  configure({ maxMessageChars: 1000 }, { attachments: { maxImageBytes: 16 * 1024, maxPdfBytes: 16 * 1024, maxTextBytes: 16 * 1024 } });
  const before = dailyCalls('peer-hermes');
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'huge', role: 'ROLE_USER', parts: [{ text: 'x' }, { raw: 'A'.repeat(1024 * 1024), mediaType: 'image/png', filename: 'a.png' }] } } });
  const res = await post(huge);
  assert.equal(res.status, 413);
  assert.match(((await res.json()) as any).error.message, /larger than/);
  const big = await rpc('SendMessage', { message: { messageId: 'big', role: 'ROLE_USER', parts: [{ text: 'x' }, { raw: 'A'.repeat(100 * 1024), mediaType: 'image/png', filename: 'a.png' }] } });
  assert.equal(big.body.error.code, -32602);
  assert.match(big.body.error.message, /a\.png: the file is larger than 64 KB/);
  assert.equal(dailyCalls('peer-hermes'), before, 'a refused task costs nothing of the day');
  configure();
});

test('the same message sent twice at once runs once; two first messages of a conversation share a session', async () => {
  script = async (args) => {
    await start(args);
    await sleep(100);
    return ok(`once: ${args.text}`);
  };
  calls = 0;
  const m = { message: { messageId: 'dup-1', role: 'ROLE_USER', parts: [{ text: 'hi' }], contextId: 'c-dup' } };
  const [a, b] = await Promise.all([rpc('SendMessage', m), rpc('SendMessage', m)]);
  assert.equal(a.body.result.task.id, b.body.result.task.id);
  assert.equal(calls, 1);
  const [c, d] = await Promise.all([rpc('SendMessage', msg('a', { contextId: 'c-fresh' })), rpc('SendMessage', msg('b', { contextId: 'c-fresh' }))]);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(c.body.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(d.body.result.task.status.state, 'TASK_STATE_COMPLETED');
  const slug = `a2a-hermes-${createHash('sha256').update('c-fresh').digest('hex').slice(0, 10)}`;
  assert.equal((await listSessions('ada')).filter((s) => s.slug === slug).length, 1, 'one session for the conversation');
});

test('a stop while the turn is still getting ready stops it', async () => {
  let sawAbort = false;
  script = async (args) => {
    await sleep(300); // getting ready: memory, media — before agent/start
    await start(args);
    await sleep(200);
    sawAbort = args.signal?.aborted ?? false;
    return ok('finished anyway');
  };
  const r = await rpc('SendMessage', { ...msg('x', { contextId: 'c-prep' }), configuration: now });
  const id = r.body.result.task.id;
  await sleep(100);
  const c = await rpc('CancelTask', { id });
  assert.equal(c.body.result.status.state, 'TASK_STATE_CANCELED');
  await sleep(600);
  assert.equal((await rpc('GetTask', { id })).body.result.status.state, 'TASK_STATE_CANCELED');
  assert.equal(sawAbort, true, 'the turn itself was stopped');
});

test('status requests count, in their own bucket; at most ten open streams per peer', async () => {
  configure({ rateLimitPerMinute: 2 });
  script = async () => ok('x');
  const r = await rpc('SendMessage', msg('x'));
  const id = r.body.result.task.id;
  for (let i = 0; i < 8; i++) assert.equal((await rpc('GetTask', { id })).status, 200, `status request ${i + 1}`);
  const ninth = await rpc('GetTask', { id });
  assert.equal(ninth.status, 429);
  assert.match(ninth.body.error.message, /more than 8 status requests a minute/);
  assert.equal((await rpc('SendMessage', msg('y'))).status, 200, 'the room for new tasks is its own');
  configure();

  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  script = async (args) => {
    await start(args);
    await gate;
    return ok('done');
  };
  const long = await rpc('SendMessage', { ...msg('long', { contextId: 'c-sub' }), configuration: now });
  const ctl = new AbortController();
  const open = await Promise.all(Array.from({ length: 10 }, () => post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SubscribeToTask', params: { id: long.body.result.task.id } }), ctl.signal)));
  assert.ok(open.every((x) => x.status === 200));
  const eleventh = await rpc('SubscribeToTask', { id: long.body.result.task.id });
  assert.equal(eleventh.status, 429);
  assert.match(eleventh.body.error.message, /too many open streams/);
  release();
  await Promise.all(open.map((x) => x.text()));
  await sleep(50);
  const again = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SubscribeToTask', params: { id: long.body.result.task.id } }));
  assert.equal(again.status, 200, 'closed streams make room again');
  await again.text();
});

test('a repeated streaming message for a finished task closes the stream', async () => {
  script = async (args) => {
    await start(args);
    return ok('done');
  };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params: { message: { messageId: 's-replay', role: 'ROLE_USER', parts: [{ text: 'x' }], contextId: 'c-replay' } } });
  const first = await (await post(body, AbortSignal.timeout(3000))).text();
  assert.match(first, /TASK_STATE_COMPLETED/);
  const t0 = Date.now();
  const replay = await (await post(body, AbortSignal.timeout(3000))).text();
  assert.ok(Date.now() - t0 < 1000, `closed after ${Date.now() - t0} ms`);
  assert.match(replay, /TASK_STATE_COMPLETED/);
  assert.match(replay, /"final":true|statusUpdate/);
});

test('the daily limit is checked before a file is fetched; a file that fails gives the task back', async () => {
  let hits = 0;
  const files = createServer((req, res) => {
    hits += 1;
    if (req.url === '/gone.png') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  });
  await new Promise<void>((r) => files.listen(0, '127.0.0.1', r));
  const url = (p: string) => `http://127.0.0.1:${(files.address() as AddressInfo).port}${p}`;
  try {
    configure({ maxTasksPerDay: 1 }, { web: { fetchAllowPrivate: ['127.0.0.1'] } });
    mkdirSync(join(home, 'a2a'), { recursive: true });
    writeFileSync(join(home, 'a2a', 'usage.json'), JSON.stringify({ day: localDay(), counts: {} }));
    const gone = await rpc('SendMessage', msg('look', { parts: [{ text: 'look' }, { url: url('/gone.png'), mediaType: 'image/png', filename: 'gone.png' }] }));
    assert.match(gone.body.error.message, /a file could not be taken: gone\.png/);
    assert.equal(dailyCalls('peer-hermes'), 0, 'the refused task was given back');
    script = async () => ok('got it');
    assert.equal((await rpc('SendMessage', msg('look', { parts: [{ text: 'look' }, { url: url('/dot.png'), mediaType: 'image/png', filename: 'dot.png' }] }))).status, 200);
    hits = 0;
    const over = await rpc('SendMessage', msg('look', { parts: [{ text: 'look' }, { url: url('/dot.png'), mediaType: 'image/png', filename: 'dot.png' }] }));
    assert.equal(over.status, 429);
    assert.match(over.body.error.message, /daily limit/);
    assert.equal(hits, 0, 'nothing fetched for a task that is refused');
  } finally {
    files.close();
    configure();
  }
});

test('finished tasks never push out one that waits in line; all places open → a new task is refused', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ran: string[] = [];
  script = async (args) => {
    if (args.text === 'blocker') {
      await start(args);
      await gate;
    }
    ran.push(args.text);
    return ok(`ran: ${args.text}`);
  };
  await rpc('SendMessage', { ...msg('blocker', { contextId: 'c-line' }), configuration: now });
  await sleep(50);
  const queued = (await rpc('SendMessage', { ...msg('queued', { contextId: 'c-line' }), configuration: now })).body.result.task.id;
  // 505 finished tasks, all in one conversation of their own.
  for (let i = 0; i < 505; i++) await rpc('SendMessage', msg(`f${i}`, { contextId: 'c-many' }));
  const g = await rpc('GetTask', { id: queued });
  assert.equal(g.body.result?.status.state, 'TASK_STATE_SUBMITTED', JSON.stringify(g.body));
  // Fill every place with tasks that wait in line behind the blocker.
  let refused: any = null;
  for (let i = 0; i < 520 && !refused; i++) {
    const r = await rpc('SendMessage', { ...msg(`w${i}`, { contextId: 'c-line' }), configuration: now });
    if (r.body.error) refused = r;
  }
  assert.ok(refused, 'a new task is refused once every place is taken');
  assert.equal(refused.status, 429);
  assert.match(refused.body.error.message, /too many open tasks/);
  release();
  for (let i = 0; i < 100 && (await rpc('GetTask', { id: queued })).body.result.status.state !== 'TASK_STATE_COMPLETED'; i++) await sleep(50);
  assert.equal((await rpc('GetTask', { id: queued })).body.result.status.state, 'TASK_STATE_COMPLETED');
  assert.ok(ran.includes('queued'));
});

test('a reply that names only its task answers that task; a different conversation is refused', async () => {
  script = async (args) => {
    await start(args);
    if (!args.text.startsWith('ask')) return ok(`new task: ${args.text}`);
    const a = await askQuestion({ agent: args.agent, session: args.session, question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiple: false, timeoutMs: 10_000 });
    return ok(`answered ${a.answers.join(',')}`);
  };
  const first = (await rpc('SendMessage', msg('ask me', { contextId: 'c-ask' }))).body.result.task;
  assert.equal(first.status.state, 'TASK_STATE_INPUT_REQUIRED');
  const wrong = await rpc('SendMessage', msg('1', { taskId: first.id, contextId: 'c-other' }));
  assert.equal(wrong.body.error.code, -32602);
  assert.match(wrong.body.error.message, /belongs to conversation 'c-ask'/);
  const reply = (await rpc('SendMessage', msg('1', { taskId: first.id }))).body.result.task;
  assert.equal(reply.id, first.id, 'the same task goes on');
  assert.equal(reply.contextId, 'c-ask');
  assert.equal(reply.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(reply.artifacts[0].parts[0].text, 'answered A');
});
