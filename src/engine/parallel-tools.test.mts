// Tool calls of one round run side by side when their tools change
// nothing; everything else runs alone, in the model's order
// (private/parallel-tools/KONZEPT.md, 2026-11-09).
//
// The promise to the operator: the answer must not get worse. So the
// central check here is that what goes back to the model — the
// assistant message and every `tool` message, in order — is byte for
// byte what the old one-after-another execution produced; only the
// waiting is shorter.
//
// Run: npm test src/engine/parallel-tools.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine, PARALLEL_TOOL_HINT } from './openai-compatible.ts';
import { createLimiter, runsConcurrently } from './tool-concurrency.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';

type Call = { id: string; name: string; args: object };

/** What round 1 asks for; round 2 answers in text. */
let roundOne: Call[] = [];
const requests: Array<{ messages: any[] }> = [];

function backend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        requests.push({ messages: (JSON.parse(body) as { messages: any[] }).messages });
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (requests.length === 1) {
          res.write(
            chunk({
              role: 'assistant',
              tool_calls: roundOne.map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
            }),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: 'done' }));
          res.write(chunk({}, 'stop'));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const def = (name: string, concurrent: boolean): ToolDefinition =>
  ({
    name,
    toolset: 'file',
    description: name,
    inputSchema: { shape: {} },
    jsonSchema: { type: 'object', properties: {}, additionalProperties: true },
    ...(concurrent ? { concurrent: true } : {}),
  }) as unknown as ToolDefinition;

/** read: may run beside others · write: alone · fail: a read that answers ok:false. */
const defs = [def('read', true), def('write', false), def('fail', true)];

let timeline: Array<{ id: string; start: number; end: number }> = [];
let inFlight = 0;
let maxInFlight = 0;

const invoker: ToolInvoker = {
  list: () => defs,
  invoke: async (name: string, args: unknown) => {
    const a = args as { id: string; ms: number };
    const start = Date.now();
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, a.ms));
    inFlight--;
    timeline.push({ id: a.id, start, end: Date.now() });
    if (name === 'fail') return { ok: false, error: `no such file ${a.id}` } as never;
    return { ok: true, data: { id: a.id, by: name } } as never;
  },
};

function memStore(): SessionMetaStore {
  let data: SessionMeta = {} as SessionMeta;
  return {
    async get() { return { ...data }; },
    async set(_a: string, _s: string, m: SessionMeta) { data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) { data = merge({ ...data }); return data; },
  } as unknown as SessionMetaStore;
}

async function run(port: number, calls: Call[], loop: Record<string, unknown> = {}, signal?: AbortSignal, modelExtra: Record<string, unknown> = {}): Promise<{ events: NormalizedEvent[]; ms: number; error?: unknown }> {
  roundOne = calls;
  requests.length = 0;
  timeline = [];
  inFlight = 0;
  maxInFlight = 0;
  const model = { id: 'm', contextWindow: 200_000, capabilities: ['text'] as const, maxTokens: 4_000, ...modelExtra };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const input = {
    agent: 'a', session: 's', systemPrompt: 'SYS', userMessage: 'go',
    history: [] as NormalizedEvent[], metaStore: memStore(), resolvedModel, availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 }, idleTimeoutMs: 10_000, tools: invoker,
    agentLoopConfig: { maxRounds: 4, maxToolCallsPerTurn: 30, toolCallTimeoutMs: 5_000, ...loop },
    ...(signal ? { signal } : {}),
  } as unknown as TurnInput;
  const events: NormalizedEvent[] = [];
  const t0 = Date.now();
  try {
    for await (const ev of openAiCompatibleEngine.runTurn(input)) events.push(ev);
  } catch (error) {
    return { events, ms: Date.now() - t0, error };
  }
  return { events, ms: Date.now() - t0 };
}

const read = (id: string, ms: number): Call => ({ id, name: 'read', args: { id, ms } });
const write = (id: string, ms: number): Call => ({ id, name: 'write', args: { id, ms } });
const span = (id: string) => timeline.find((t) => t.id === id)!;
/** What went back to the model in round 2: the assistant message and the tool messages. */
const wire = () => requests[1]!.messages.filter((m: any) => m.tool_calls || m.role === 'tool');
const resultOrder = (events: NormalizedEvent[]) =>
  events.filter((e) => e.kind === 'tool_result').map((e) => (e as { callId: string }).callId);

test('reads of one round run at the same time; results keep the model\'s order', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  // B finishes first, A last — the order back must still be A, B, C.
  const r = await run(port, [read('A', 300), read('B', 100), read('C', 200)]);
  assert.equal(r.error, undefined);
  assert.equal(maxInFlight, 3, 'all three ran side by side');
  const tools = Math.max(...timeline.map((x) => x.end)) - Math.min(...timeline.map((x) => x.start));
  assert.ok(tools < 450, `the round waited for the slowest call, not the sum: ${tools} ms`);
  assert.deepEqual(resultOrder(r.events), ['A', 'B', 'C']);
  assert.deepEqual(wire().filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id), ['A', 'B', 'C']);
});

test('a call that must run alone is a barrier: reads before it finish first, reads after it wait', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const r = await run(port, [read('A', 150), read('B', 150), write('C', 150), read('D', 150), read('E', 150)]);
  assert.equal(r.error, undefined);
  assert.ok(span('C').start >= Math.max(span('A').end, span('B').end), 'C waited for A and B');
  assert.ok(span('D').start >= span('C').end && span('E').start >= span('C').end, 'D and E waited for C');
  assert.ok(Math.abs(span('A').start - span('B').start) < 50, 'A and B started together');
  assert.ok(Math.abs(span('D').start - span('E').start) < 50, 'D and E started together');
  assert.deepEqual(resultOrder(r.events), ['A', 'B', 'C', 'D', 'E']);
});

test('at most maxParallelTools at once; 1 runs them one after another', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const five = ['A', 'B', 'C', 'D', 'E'].map((id) => read(id, 80));
  await run(port, five, { maxParallelTools: 2 });
  assert.equal(maxInFlight, 2);
  await run(port, five, { maxParallelTools: 1 });
  assert.equal(maxInFlight, 1);
});

test('the model gets byte for byte the same messages as with one-after-another execution', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const calls = [read('A', 120), read('B', 20), { id: 'F', name: 'fail', args: { id: 'F', ms: 60 } }, write('C', 30), read('D', 50)];
  await run(port, calls, { maxParallelTools: 1 });
  const sequential = JSON.stringify(wire());
  const r = await run(port, calls, { maxParallelTools: 8 });
  assert.equal(JSON.stringify(wire()), sequential);
  const failed = r.events.find((e) => e.kind === 'tool_result' && (e as { callId: string }).callId === 'F') as { error?: string };
  assert.equal(failed.error, 'no such file F', 'a failing call only fails itself');
});

test('a call that times out answers with the timeout; the others still deliver', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const r = await run(port, [read('A', 50), read('SLOW', 1_500), read('B', 50)], { toolCallTimeoutMs: 300 });
  assert.equal(r.error, undefined);
  const tool = wire().filter((m: any) => m.role === 'tool');
  assert.deepEqual(tool.map((m: any) => m.tool_call_id), ['A', 'SLOW', 'B']);
  assert.match(tool[1].content, /timed out after 300ms/);
  assert.match(tool[0].content, /"id":"A"/);
  assert.match(tool[2].content, /"id":"B"/);
});

test('stop during a group ends the turn at once, not after the slowest call', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const r = await run(port, [read('A', 2_000), read('B', 2_000)], {}, ac.signal);
  assert.ok(r.ms < 1_000, `the turn ended at the stop: ${r.ms} ms`);
  assert.equal(r.events.filter((e) => e.kind === 'tool_result').length, 0, 'no result is made up for a stopped call');
});

test('stop while calls wait for a slot: the waiting ones never start', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const started: string[] = [];
  const orig = invoker.invoke;
  invoker.invoke = (async (name: string, args: unknown) => {
    started.push((args as { id: string }).id);
    return orig(name, args);
  }) as typeof invoker.invoke;
  try {
    await run(port, ['A', 'B', 'C', 'D'].map((id) => read(id, 400)), { maxParallelTools: 2 }, ac.signal);
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    invoker.invoke = orig;
  }
  assert.deepEqual(started, ['A', 'B'], 'C and D were still waiting when the turn stopped');
});

test('the batching hint reaches only a model that may call several tools, and only when switched on', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const system = () => requests[0]!.messages.find((m: any) => m.role === 'system')?.content as string;
  await run(port, [read('A', 10)], { parallelToolHint: true }, undefined, { parallelToolCalls: true });
  assert.ok(system().endsWith(PARALLEL_TOOL_HINT), 'switched on, model allowed: told');
  await run(port, [read('A', 10)], { parallelToolHint: true }, undefined, {});
  assert.ok(!system().includes(PARALLEL_TOOL_HINT), 'model not allowed several calls: not told');
  await run(port, [read('A', 10)], {}, undefined, { parallelToolCalls: true });
  assert.ok(!system().includes(PARALLEL_TOOL_HINT), 'off by default');
});

test('which calls may run side by side: only a tool that says so, never on a doubt', () => {
  assert.equal(runsConcurrently({ concurrent: true } as never, {}), true);
  assert.equal(runsConcurrently({} as never, {}), false, 'unset: alone');
  assert.equal(runsConcurrently(undefined, {}), false, 'unknown tool: alone');
  assert.equal(runsConcurrently({ concurrent: (i: { op: string }) => i.op === 'list' } as never, { op: 'list' }), true);
  assert.equal(runsConcurrently({ concurrent: (i: { op: string }) => i.op === 'list' } as never, { op: 'kill' }), false);
  assert.equal(runsConcurrently({ concurrent: () => { throw new Error('x'); } } as never, {}), false, 'a throwing classifier: alone');
  assert.equal(runsConcurrently({ concurrent: () => 'yes' } as never, {}), false, 'only exactly true counts');
});

test('the limiter starts waiting tasks in order as slots free', async () => {
  const limit = createLimiter(2);
  const started: string[] = [];
  const task = (id: string, ms: number) => () => {
    started.push(id);
    return new Promise<string>((r) => setTimeout(() => r(id), ms));
  };
  const out = await Promise.all([limit(task('a', 60)), limit(task('b', 20)), limit(task('c', 10)), limit(task('d', 10))]);
  assert.deepEqual(out, ['a', 'b', 'c', 'd']);
  assert.deepEqual(started.slice(0, 2), ['a', 'b']);
  assert.deepEqual(started.slice(2), ['c', 'd']);
  await assert.rejects(limit(() => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await limit(async () => 'after a failure the slot is free'), 'after a failure the slot is free');
});
