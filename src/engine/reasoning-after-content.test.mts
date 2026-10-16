// A backend that sends reasoning after the answer began is logged: that
// is how a model or reasoning parser looks when it slides the rest of the
// answer into the thinking (2026-09-24: answers "1" with "…11:06:59…" in
// the thinking, 35 of 650 turns on one test backend). A healthy stream
// (all reasoning first) logs nothing.
//
// Run: npm test src/engine/reasoning-after-content.test.mts

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import { logger } from '../server/logger.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';

let deltas: object[] = [];

function backend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on('data', () => {}).on('end', () => {
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const d of deltas) res.write(chunk(d));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function memStore(): SessionMetaStore {
  let data: SessionMeta = {} as SessionMeta;
  return {
    async get() { return { ...data }; },
    async set(_a: string, _s: string, m: SessionMeta) { data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) { data = merge({ ...data }); return data; },
  } as unknown as SessionMetaStore;
}

async function run(port: number): Promise<NormalizedEvent[]> {
  const model = { id: 'm', contextWindow: 200_000, capabilities: ['text', 'reasoning'] as const };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const input = {
    agent: 'a', session: 's', systemPrompt: 'SYS', userMessage: 'time only',
    history: [] as NormalizedEvent[], metaStore: memStore(), resolvedModel, availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 }, idleTimeoutMs: 10_000,
    agentLoopConfig: { maxRounds: 2, maxToolCalls: 4, toolCallTimeoutMs: 5_000 },
  } as unknown as TurnInput;
  const out: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) out.push(ev);
  return out;
}

const warned = () => {
  const spy = mock.method(logger, 'warn');
  return {
    hits: () => spy.mock.calls.filter((c) => (c.arguments[0] as { msg?: string })?.msg === 'engine.reasoning_after_content'),
    restore: () => spy.mock.restore(),
  };
};

test('reasoning after the answer began is logged with both halves', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  deltas = [{ role: 'assistant', reasoning_content: 'simple answer' }, { content: '1' }, { reasoning_content: '1:06:59' }];
  const w = warned();
  try {
    const events = await run(port);
    const final = events.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined;
    assert.equal(final?.text, '1', 'the answer is not guessed back together');
    const hits = w.hits();
    assert.equal(hits.length, 1);
    const fields = hits[0]!.arguments[0] as { contentStart: string; reasoningAfter: string };
    assert.equal(fields.contentStart, '1');
    assert.equal(fields.reasoningAfter, '1:06:59');
  } finally {
    w.restore();
  }
});

test('a healthy stream — all reasoning first — logs nothing', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  deltas = [{ role: 'assistant', reasoning_content: 'think' }, { reasoning_content: ' more' }, { content: '11:06' }, { content: ':59' }];
  const w = warned();
  try {
    const events = await run(port);
    const final = events.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined;
    assert.equal(final?.text, '11:06:59');
    assert.equal(w.hits().length, 0);
  } finally {
    w.restore();
  }
});
