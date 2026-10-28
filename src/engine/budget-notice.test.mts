// The budget notices inside a long turn, against a fake backend that
// calls a tool every round until it is told to write its answer.
//
// 2026-10-28: a builder ended four night builds 3–8 rounds after the 75 %
// notice ("Wrap up now"), with a quarter of its rounds unused. A builder
// now gets a checkpoint at 75 % and the wrap-up only at its report
// reserve; a chat agent keeps the 75 % wrap-up.
//
// Run: npm test src/engine/budget-notice.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { builderReserve, openAiCompatibleEngine } from './openai-compatible.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';

/** Rounds at which the backend saw a notice for the first time, by text. */
let seen: Array<{ round: number; text: string }> = [];
let requestCount = 0;

function startBackend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
        requestCount++;
        const notices = parsed.messages
          .filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[somora] Budget'))
          .map((m) => m.content as string);
        for (const n of notices) if (!seen.some((s) => s.text === n)) seen.push({ round: requestCount, text: n });
        // The model behaves as the reports describe: it keeps calling
        // tools until a notice asks for the answer or the report.
        const told = notices.some((n) => /Wrap up now|write your report/.test(n));
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (!told) {
          res.write(
            chunk({
              role: 'assistant',
              tool_calls: [{ index: 0, id: `call-${requestCount}`, type: 'function', function: { name: 'step', arguments: `{"n":${requestCount}}` } }],
            }),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: 'report' }));
          res.write(chunk({}, 'stop'));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const stepTool: ToolDefinition = {
  name: 'step',
  toolset: 'file',
  description: 'one step of work',
  inputSchema: { shape: {} } as never,
  jsonSchema: { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false },
  async handler() {
    return { text: 'ok' };
  },
} as unknown as ToolDefinition;

const invoker: ToolInvoker = {
  list: () => [stepTool],
  invoke: async () => ({ ok: true, data: { text: 'ok' } }) as never,
};

function memStore(): SessionMetaStore {
  let data: SessionMeta = {} as SessionMeta;
  return {
    async get() { return { ...data }; },
    async set(_a: string, _s: string, m: SessionMeta) { data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) { data = merge({ ...data }); return data; },
  } as unknown as SessionMetaStore;
}

async function run(port: number, agentKind: 'builder' | 'chat', maxRounds: number, maxToolCallsPerTurn = 10_000) {
  seen = [];
  requestCount = 0;
  const model = { id: 'm', contextWindow: 200_000, capabilities: ['text'] as const, maxTokens: 1_000 };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const input = {
    agent: 'a',
    agentKind,
    session: 's',
    systemPrompt: 'SYS',
    userMessage: 'build the thing',
    history: [] as NormalizedEvent[],
    metaStore: memStore(),
    resolvedModel,
    availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 },
    idleTimeoutMs: 10_000,
    tools: invoker,
    agentLoopConfig: { maxRounds, maxToolCallsPerTurn, toolCallTimeoutMs: 5_000 },
  } as unknown as TurnInput;
  const out: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) out.push(ev);
  return out;
}

test('the report reserve: 2 %, at least 5', () => {
  assert.equal(builderReserve(500), 10);
  assert.equal(builderReserve(1000), 20);
  assert.equal(builderReserve(2000), 40);
  assert.equal(builderReserve(40), 5);
});

test('a chat agent is told to wrap up at 75 %', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  const events = await run(port, 'chat', 40);
  assert.equal(seen.length, 1, JSON.stringify(seen));
  assert.match(seen[0]!.text, /Wrap up now/);
  // Notice pushed after round 30, seen by the 31st request.
  assert.equal(seen[0]!.round, 31);
  const end = events.find((e) => e.kind === 'turn_end') as { forced_final?: string } | undefined;
  assert.equal(end?.forced_final, undefined);
});

test('a builder gets a checkpoint at 75 % and keeps working until the reserve', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  const events = await run(port, 'builder', 100);
  assert.equal(seen.length, 2, JSON.stringify(seen));
  const [checkpoint, wrap] = seen;
  assert.match(checkpoint!.text, /Budget checkpoint/);
  assert.match(checkpoint!.text, /keep working/);
  assert.doesNotMatch(checkpoint!.text, /Wrap up|final answer|write your report/);
  assert.equal(checkpoint!.round, 76);
  // 100 rounds → reserve 5: the wrap-up comes after round 95.
  assert.match(wrap!.text, /write your report/);
  assert.equal(wrap!.round, 96);
  assert.equal(requestCount, 96, 'the builder used the rounds between the notices');
  const end = events.find((e) => e.kind === 'turn_end') as { forced_final?: string } | undefined;
  assert.equal(end?.forced_final, undefined, 'it ended on its own, not on the cap');
});

test('a builder near its tool-call limit gets the wrap-up from that limit', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  // One call per round: 40 calls → checkpoint after 30, reserve 5 → wrap-up after 35.
  await run(port, 'builder', 500, 40);
  assert.equal(seen.length, 2, JSON.stringify(seen));
  assert.equal(seen[0]!.round, 31);
  assert.equal(seen[1]!.round, 36);
});

test('a builder with a tiny budget gets the wrap-up only, not both at once', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  // 8 rounds, reserve 5: the reserve is reached (round 3) before 75 % (round 6).
  await run(port, 'builder', 8);
  assert.equal(seen.length, 1, JSON.stringify(seen));
  assert.match(seen[0]!.text, /write your report/);
  assert.equal(seen[0]!.round, 4);
});
