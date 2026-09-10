// The budget check inside a running turn, against a fake backend.
//
// 2026-09-10: eighteen tool calls grew the prompt past the window and
// the turn died on a raw HTTP 400 with everything lost. The pre-turn
// compaction cannot help there — the tools have already run, so the
// remedy has to work inside the turn and must never cause a second
// execution of anything.
//
// Run: npm test src/engine/context-budget-midturn.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';

/** Prompt sizes the backend was asked to read, request by request. */
const requests: Array<{ messages: any[] }> = [];
let toolRuns = 0;

function startBackend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: any[] };
        requests.push({ messages: parsed.messages });
        const round = requests.length;
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (round === 1) {
          // One tool call, whose result will blow the window.
          res.write(
            chunk({
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'big_read', arguments: '{}' } }],
            }),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: 'done looking' }));
          res.write(chunk({}, 'stop'));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const bigTool: ToolDefinition = {
  name: 'big_read',
  toolset: 'file',
  description: 'returns a lot',
  inputSchema: { shape: {} } as never,
  jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler() {
    toolRuns++;
    return { text: 'z'.repeat(200_000) };
  },
} as unknown as ToolDefinition;

const invoker: ToolInvoker = {
  list: () => [bigTool],
  invoke: async () => ({ ok: true, data: await (bigTool.handler as any)({}, {}) }) as never,
};

function memStore(): SessionMetaStore {
  let data: SessionMeta = {} as SessionMeta;
  return {
    async get() { return { ...data }; },
    async set(_a: string, _s: string, m: SessionMeta) { data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) { data = merge({ ...data }); return data; },
  } as unknown as SessionMetaStore;
}

function run(port: number, over: { contextWindow?: number; systemPrompt?: string } = {}) {
  const model = { id: 'm', contextWindow: over.contextWindow ?? 30_000, capabilities: ['text'] as const, maxTokens: 1_000 };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const input = {
    agent: 'a',
    session: 's',
    systemPrompt: over.systemPrompt ?? 'SYS',
    userMessage: 'read the big thing',
    history: [] as NormalizedEvent[],
    metaStore: memStore(),
    resolvedModel,
    availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 },
    idleTimeoutMs: 10_000,
    tools: invoker,
    agentLoopConfig: { maxRounds: 4, maxToolCalls: 10, toolCallTimeoutMs: 5_000 },
  } as unknown as TurnInput;
  return (async () => {
    const out: NormalizedEvent[] = [];
    for await (const ev of openAiCompatibleEngine.runTurn(input)) out.push(ev);
    return out;
  })();
}

test('a turn that outgrows its window mid-round keeps going, and runs nothing twice', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  requests.length = 0;
  toolRuns = 0;

  const events = await run(port);
  const kinds = events.map((e) => e.kind);

  assert.equal(toolRuns, 1, 'the tool ran exactly once');
  assert.equal(kinds.filter((k) => k === 'turn_start').length, 1);
  assert.equal(kinds.filter((k) => k === 'turn_end').length, 1);
  assert.ok(!kinds.includes('error'), `no error surfaced: ${kinds.join(',')}`);

  const meta = events.find((e) => e.kind === 'engine_meta') as { itemType?: string; payload?: { trimmed?: number } } | undefined;
  assert.equal(meta?.itemType, 'context_trimmed', JSON.stringify(meta));
  assert.ok((meta?.payload?.trimmed ?? 0) >= 1);

  const final = events.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined;
  assert.equal(final?.text, 'done looking', 'the turn still produced its answer');

  // The second request carried the shortened result, and still carried
  // an answer for every tool call — that pairing is what a backend
  // rejects outright when a naive fix drops messages.
  assert.equal(requests.length, 2);
  const second = requests[1]!.messages;
  const toolMsgs = second.filter((m: any) => m.role === 'tool');
  assert.equal(toolMsgs.length, 1);
  // The only result there is: cut down to what fits, beginning kept, and
  // labelled so the model does not read the cut as "the call failed".
  assert.ok(toolMsgs[0].content.length < 200_000, 'it was shortened');
  assert.match(toolMsgs[0].content, /do not run it again/);
  const callIds = second.filter((m: any) => m.tool_calls).flatMap((m: any) => m.tool_calls.map((c: any) => c.id));
  assert.deepEqual(toolMsgs.map((m: any) => m.tool_call_id), callIds);
});

test('a conversation that cannot fit at all is refused before a tool runs', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  requests.length = 0;
  toolRuns = 0;

  // A system prompt that alone exceeds the window: nothing left to trim.
  const events = await run(port, { contextWindow: 12_000, systemPrompt: 'S'.repeat(200_000) });
  const err = events.find((e) => e.kind === 'error') as { message?: string } | undefined;

  assert.ok(err, 'the turn ends on an explained error, not a raw 400');
  assert.match(err!.message!, /does not fit/);
  assert.match(err!.message!, /nothing left to shorten/);
  assert.equal(events.at(-1)?.kind, 'turn_end', 'and it still closes the turn');
  assert.equal(toolRuns, 0, 'nothing was run for a request that could never be sent');
  assert.equal(requests.length, 0, 'the backend was never asked');
});
