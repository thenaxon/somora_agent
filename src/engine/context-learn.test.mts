// A refusal is the one moment a backend states its truth. Read it.
//
// 2026-09-10: a session walked into
//   "This model's maximum context length is 524288 tokens. However, you
//    requested 16384 output tokens and your prompt contains at least
//    507905 input tokens"
// while every check said it fits, because the estimate was 36 % low. The
// numbers in that sentence are exactly what corrects the next estimate,
// so the turn that fails still teaches the session something.
//
// Run: npm test src/engine/context-learn.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';

const REFUSAL =
  "This model's maximum context length is 524288 tokens. However, you requested 16384 output tokens " +
  'and your prompt contains at least 507905 input tokens, for a total of at least 524289 tokens.';

function backend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: REFUSAL, type: 'invalid_request_error' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function memStore(): SessionMetaStore & { data: SessionMeta } {
  const store = {
    data: {} as SessionMeta,
    async get() { return { ...store.data }; },
    async set(_a: string, _s: string, m: SessionMeta) { store.data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) {
      store.data = merge({ ...store.data });
      return store.data;
    },
  };
  return store as unknown as SessionMetaStore & { data: SessionMeta };
}

test('a context refusal is read, remembered, and ends the turn in plain words', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  const store = memStore();

  const model = { id: 'm', contextWindow: 1_000_000, capabilities: ['text'] as const, maxTokens: 16_384 };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const history: NormalizedEvent[] = [
    { kind: 'user_message', ts: 1, engine: 'openai-compatible', text: 'x'.repeat(40_000) } as NormalizedEvent,
  ];
  const input = {
    agent: 'a', session: 's', systemPrompt: 'SYS', userMessage: 'go', history,
    metaStore: store, resolvedModel, availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 }, idleTimeoutMs: 10_000,
  } as unknown as TurnInput;

  const events: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) events.push(ev);

  // The session now knows how this model counts, even though the turn failed.
  const ratio = (store.data as { tokenRatio?: { ratio: number; model: string } }).tokenRatio;
  assert.ok(ratio, 'a ratio was learned from the refusal');
  assert.equal(ratio!.model, 'm');
  assert.ok(ratio!.ratio > 1, `code-dense content: the backend counted more than we estimated (${ratio!.ratio})`);
  const measured = (store.data as { contextTokens?: { tokens: number } }).contextTokens;
  assert.equal(measured?.tokens, 507_905, 'and what it actually counted');

  // And the user gets words, not a stack trace.
  const err = events.find((e) => e.kind === 'error') as { message?: string } | undefined;
  assert.ok(err, 'the turn ends on an error event');
  assert.equal(events.at(-1)?.kind, 'turn_end');
});
