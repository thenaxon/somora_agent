// A first request that does not fit the window even after the compaction
// before the turn: compact once more on the same model and run the turn,
// instead of ending it (2026-10-28: the error moved a whole build to a
// smaller fallback model). When nothing is left to compact, the error
// says it is a context overflow, so the fallback chain skips models with
// no larger window (run-turn-fallback.test.mts).
//
// Run: npm test src/engine/context-budget-retry.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';

let summaryCalls = 0;
let streamCalls = 0;
function startBackend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { stream?: boolean };
        if (!parsed.stream) {
          summaryCalls++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 's',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'SUMMARY: earlier work.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
          return;
        }
        streamCalls++;
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(chunk({ role: 'assistant', content: 'answered' }));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

let clock = 1_000_000;
const t = () => (clock += 1000);
const E = 'openai-compatible';
/** One exchange whose bulk is a tool call's arguments (trimming tool
 *  results cannot shrink it). */
function exchange(i: number, chars: number): NormalizedEvent[] {
  return [
    { kind: 'user_message', ts: t(), engine: E, text: `order ${i}` },
    { kind: 'tool_call', ts: t(), engine: E, callId: `c${i}`, tool: 'file_write', input: { path: `f${i}.ts`, content: 'x'.repeat(chars) } },
    { kind: 'tool_result', ts: t(), engine: E, callId: `c${i}`, output: 'ok' },
    { kind: 'assistant_message', ts: t(), engine: E, text: `report ${i}` },
  ] as NormalizedEvent[];
}

function memStore(): SessionMetaStore & { data: () => SessionMeta } {
  let data = {} as SessionMeta;
  return {
    data: () => data,
    async get() { return { ...data }; },
    async set(_a: string, _s: string, m: SessionMeta) { data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) { data = merge({ ...data }); return data; },
  } as unknown as SessionMetaStore & { data: () => SessionMeta };
}

// Window 100k, output cap 10k → input budget 90k.
function models(port: number) {
  const mk = (id: string, contextWindow: number) => {
    const model = { id, contextWindow, maxTokens: 10_000, capabilities: ['text'] as const };
    const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
    return { providerName: 'fake', provider, modelId: id, model } as unknown as TurnInput['resolvedModel'];
  };
  return { main: mk('m', 100_000), worker: mk('worker', 1_000_000) };
}

async function run(port: number, history: NormalizedEvent[]) {
  summaryCalls = 0;
  streamCalls = 0;
  const store = memStore();
  const { main, worker } = models(port);
  const input = {
    agent: 'a',
    agentKind: 'chat',
    session: 's',
    systemPrompt: 'SYS',
    userMessage: 'next',
    history,
    metaStore: store,
    resolvedModel: main,
    availableModels: [main, worker],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 },
    idleTimeoutMs: 10_000,
  } as unknown as TurnInput;
  const events: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) events.push(ev);
  return { events, store };
}

test('four kept exchanges too big for the budget: compacted again on the same model, then answered', async () => {
  const { server, port } = await startBackend();
  try {
    // Five exchanges of ~25k tokens: the normal compaction keeps four
    // (~100k, above the 90k budget), so the first request cannot fit.
    const history = [1, 2, 3, 4, 5].flatMap((i) => exchange(i, 100_000));
    history.push({ kind: 'user_message', ts: t(), engine: E, text: 'next' } as NormalizedEvent);
    const { events, store } = await run(port, history);
    assert.equal(events.filter((e) => e.kind === 'error').length, 0, 'no error');
    assert.equal(streamCalls, 1, 'one model request, after the second compaction');
    assert.ok(events.some((e) => e.kind === 'assistant_message' && (e as { text: string }).text.includes('answered')));
    assert.equal(events.filter((e) => e.kind === 'turn_start').length, 1, 'one turn to the consumer');
    assert.equal(events.filter((e) => e.kind === 'turn_end').length, 1);
    const again = events.find(
      (e) => e.kind === 'engine_meta' && (e as { payload?: { reason?: string } }).payload?.reason === 'context_budget',
    ) as { payload: { text: string } } | undefined;
    assert.ok(again, 'the second compaction is a visible row');
    assert.match(again!.payload.text, /compacted again for m/);
    assert.equal((store.data() as { compactions?: unknown[] }).compactions?.length, 2, 'both compactions stored');
  } finally {
    server.close();
  }
});

test('nothing left to compact: the error is marked as a context overflow, the model is never asked', async () => {
  const { server, port } = await startBackend();
  try {
    // One exchange of ~120k tokens is above the budget on its own.
    const history = exchange(1, 480_000);
    history.push({ kind: 'user_message', ts: t(), engine: E, text: 'next' } as NormalizedEvent);
    const { events } = await run(port, history);
    const errs = events.filter((e) => e.kind === 'error') as Array<{ message: string; contextOverflow?: boolean; providerError?: boolean }>;
    assert.equal(errs.length, 1);
    assert.equal(errs[0]!.contextOverflow, true);
    assert.equal(errs[0]!.providerError, false);
    assert.match(errs[0]!.message, /does not fit m's context window/);
    assert.equal(streamCalls, 0);
    assert.equal(events.filter((e) => e.kind === 'turn_end').length, 1);
  } finally {
    server.close();
  }
});
