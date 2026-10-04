// Backup workers for Deep and Lucid (deep-llm.ts): the next model
// answers when the worker is not reachable, a refused request does not
// switch, and outages are remembered like everywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { ConfigSchema, resolveAnyRef, type ResolvedModel } from '../config/types.ts';
import { modelUnavailable, resetModelAvailability } from '../engine/model-availability.ts';
import { callOneShotLLM, oneShotAnsweredBy, oneShotOrder } from './deep-llm.ts';
import { resolveDreamWorker } from './worker-model.ts';

type Mode = 'ok' | '503' | '400';
interface Fake { server: Server; port: number; hits: number; mode: Mode }

async function fake(mode: Mode, text: string): Promise<Fake> {
  const f: Fake = { server: undefined as never, port: 0, hits: 0, mode };
  f.server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; }).on('end', () => {
      f.hits++;
      if (f.mode === '503') { res.statusCode = 503; return res.end('{"error":{"message":"overloaded"}}'); }
      if (f.mode === '400') { res.statusCode = 400; res.setHeader('content-type', 'application/json'); return res.end('{"error":{"message":"bad request: unknown parameter"}}'); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: JSON.parse(body).model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => f.server.listen(0, '127.0.0.1', r));
  f.port = (f.server.address() as { port: number }).port;
  return f;
}

function configFor(ports: { a: number; b: number; c: number }, deepFallback: string | string[] | undefined, lucidFallback?: string | string[]) {
  const provider = (port: number, id: string, alias: string) => ({ engine: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'none', models: [{ id, alias, contextWindow: 32768, capabilities: ['text'] }] });
  return ConfigSchema.parse({
    providers: { pa: provider(ports.a, 'model-a', 'a'), pb: provider(ports.b, 'model-b', 'b'), pc: provider(ports.c, 'model-c', 'c') },
    wiki: { deep: { model: 'a', ...(deepFallback ? { fallback: deepFallback } : {}) }, lucid: { model: 'a', ...(lucidFallback ? { fallback: lucidFallback } : {}) } },
  });
}

const ask = (worker: ResolvedModel) => callOneShotLLM({ workerModel: worker, systemPrompt: 's', userMessage: 'u', timeoutMs: 10_000, logCtx: { op: 'test' } });

test('config: a string or a list is accepted, an unknown backup is skipped at resolve time', () => {
  const cfg = configFor({ a: 1, b: 2, c: 3 }, 'b', ['b', 'c']);
  assert.equal(resolveDreamWorker(cfg, 'deep').fallbacks.length, 1);
  assert.deepEqual(resolveDreamWorker(cfg, 'lucid').fallbacks.map((m) => m.modelId), ['model-b', 'model-c']);
  const odd = configFor({ a: 1, b: 2, c: 3 }, ['nope', 'a', 'c']);
  assert.deepEqual(resolveDreamWorker(odd, 'deep').fallbacks.map((m) => m.modelId), ['model-c'], 'unknown ref and the worker itself are left out');
  assert.equal(resolveDreamWorker(configFor({ a: 1, b: 2, c: 3 }, undefined), 'deep').fallbacks.length, 0);
});

test('worker dead (connection refused) → second backup overloaded (503) → third answers; outages are remembered', async () => {
  resetModelAvailability();
  const b = await fake('503', 'from b');
  const c = await fake('ok', 'from c');
  // a: a port nobody listens on
  const dead = await fake('ok', 'x'); const deadPort = dead.port; await new Promise((r) => dead.server.close(r));
  try {
    const cfg = configFor({ a: deadPort, b: b.port, c: c.port }, ['b', 'c']);
    const { model } = resolveDreamWorker(cfg, 'deep');
    assert.equal(await ask(model!), 'from c');
    assert.deepEqual(oneShotAnsweredBy(model!), ['pc/model-c']);
    assert.ok(modelUnavailable('pa/model-a'), 'the dead worker is marked');
    assert.ok(modelUnavailable('pb/model-b'), 'the overloaded backup is marked');
    assert.equal(modelUnavailable('pc/model-c'), null);

    // next call: the marked ones are not tried first — c answers at once
    const hitsB = b.hits;
    assert.deepEqual(oneShotOrder(model!).map((m) => m.modelId), ['model-c', 'model-a', 'model-b']);
    assert.equal(await ask(model!), 'from c');
    assert.equal(b.hits, hitsB, 'the marked backup was not asked again');

    // a chat turn (or anything else) sees the same memory: a fresh resolve of the same config starts at c too
    const again = resolveDreamWorker(cfg, 'deep').model!;
    assert.equal(oneShotOrder(again)[0]!.modelId, 'model-c');
  } finally {
    b.server.close(); c.server.close(); resetModelAvailability();
  }
});

test('a refused request (400) does not switch and marks nothing', async () => {
  resetModelAvailability();
  const a = await fake('400', 'x');
  const b = await fake('ok', 'from b');
  try {
    const { model } = resolveDreamWorker(configFor({ a: a.port, b: b.port, c: 9 }, 'b'), 'deep');
    await assert.rejects(() => ask(model!), /400|bad request/i);
    assert.equal(b.hits, 0, 'the backup was not asked');
    assert.equal(modelUnavailable('pa/model-a'), null);
  } finally {
    a.server.close(); b.server.close(); resetModelAvailability();
  }
});

test('everything down: the error of the last one tried comes out; a recovered worker is used again and unmarked', async () => {
  resetModelAvailability();
  const a = await fake('503', 'from a');
  const b = await fake('503', 'from b');
  try {
    const cfg = configFor({ a: a.port, b: b.port, c: 9 }, 'b');
    const { model } = resolveDreamWorker(cfg, 'lucid') as { model: ResolvedModel };
    const lucid = resolveDreamWorker(configFor({ a: a.port, b: b.port, c: 9 }, undefined, 'b'), 'lucid').model!;
    await assert.rejects(() => ask(lucid), /503/);
    assert.ok(modelUnavailable('pa/model-a') && modelUnavailable('pb/model-b'));
    // all marked → the configured worker is still the first try
    assert.equal(oneShotOrder(lucid)[0]!.modelId, 'model-a');
    a.mode = 'ok';
    assert.equal(await ask(lucid), 'from a');
    assert.equal(modelUnavailable('pa/model-a'), null, 'a success clears the mark');
    void model; void resolveAnyRef;
  } finally {
    a.server.close(); b.server.close(); resetModelAvailability();
  }
});

test('no backup configured: behaviour as before — the error comes out', async () => {
  resetModelAvailability();
  const a = await fake('503', 'x');
  try {
    const { model } = resolveDreamWorker(configFor({ a: a.port, b: 8, c: 9 }, undefined), 'deep');
    await assert.rejects(() => ask(model!), /503/);
  } finally {
    a.server.close(); resetModelAvailability();
  }
});
