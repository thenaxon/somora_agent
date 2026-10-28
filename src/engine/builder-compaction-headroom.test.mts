// A builder's compaction before a turn leaves room to work.
//
// 2026-10-28 (a builder, 700k window): the compaction kept the four newest
// pairs whatever they weighed. A builder pair is a whole build, so the
// four alone came to ~578k, above the trigger, and the turn compacted
// itself mid-way four times without getting below ~585k. A builder now
// keeps only as many newest pairs as fit below BUILDER_CONTEXT_TARGET
// (by their replayed size), compacts once more if the result is still
// above it, and its row says whether the target was reached. A chat
// session compacts exactly as before.
//
// Run: npm test src/engine/builder-compaction-headroom.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BUILDER_CONTEXT_TARGET, builderCushion, openAiCompatibleEngine } from './openai-compatible.ts';
import { splitReplayPairs } from '../compaction/summarize.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';

let summaryCalls = 0;
/** What the fake worker returns as the summary. */
let summaryText = 'SUMMARY: the parser was built and tested.';
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
            choices: [{ index: 0, message: { role: 'assistant', content: summaryText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
          return;
        }
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(chunk({ role: 'assistant', content: 'ok' }));
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
/** One builder turn: the order, one big write (the bulk of a build is
 *  its tool arguments), the result, the report. `chars` sizes the write. */
function buildTurn(i: number, chars: number): NormalizedEvent[] {
  return [
    { kind: 'user_message', ts: t(), engine: E, text: `order ${i}` },
    { kind: 'tool_call', ts: t(), engine: E, callId: `c${i}`, tool: 'file_write', input: { path: `f${i}.ts`, content: 'x'.repeat(chars) } },
    { kind: 'tool_result', ts: t(), engine: E, callId: `c${i}`, output: 'ok' },
    { kind: 'assistant_message', ts: t(), engine: E, text: `report ${i}: done` },
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

// Window 100k, output cap 10k → input budget 90k: chat trigger 0.8 → 72k,
// builder target 0.6 → 54k.
const WINDOW = 100_000;
function models(port: number) {
  const mk = (id: string, contextWindow: number) => {
    const model = { id, contextWindow, maxTokens: 10_000, capabilities: ['text'] as const };
    const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
    return { providerName: 'fake', provider, modelId: id, model } as unknown as TurnInput['resolvedModel'];
  };
  return { main: mk('m', WINDOW), worker: mk('worker', 1_000_000) };
}

async function run(port: number, kind: 'builder' | 'chat', history: NormalizedEvent[]) {
  summaryCalls = 0;
  const store = memStore();
  const { main, worker } = models(port);
  const input = {
    agent: 'a',
    agentKind: kind,
    session: 's',
    systemPrompt: 'SYS',
    userMessage: 'next order',
    history,
    metaStore: store,
    resolvedModel: main,
    availableModels: [main, worker],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 },
    idleTimeoutMs: 10_000,
  } as unknown as TurnInput;
  const events: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) events.push(ev);
  const rows = events.filter((e) => e.kind === 'engine_meta' && (e as { itemType?: string }).itemType === 'context_compacted') as Array<{
    payload: { text: string; contextAfter: number; builderTarget?: number; reachedTarget?: boolean; freeTokens?: number };
  }>;
  return { events, rows, store };
}

const target = Math.floor(BUILDER_CONTEXT_TARGET * (WINDOW - 10_000));

test('pairs are cut as the compaction counts them; the turn in flight is pending', () => {
  const h = [...buildTurn(1, 10), ...buildTurn(2, 10), { kind: 'user_message', ts: t(), engine: E, text: 'now' } as NormalizedEvent];
  const { pairs, pending } = splitReplayPairs(h, undefined);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]!.length, 4);
  assert.equal(pending.length, 1);
  // After a compaction only the newer pairs count.
  const after = splitReplayPairs(h, [{ throughTs: (h[3] as { ts: number }).ts, summary: 's' } as never]);
  assert.equal(after.pairs.length, 1);
});

test('the cushion is sized by tokens, newest first, never above maxPairs', async () => {
  // ~20k tokens per pair.
  const h = [...buildTurn(1, 80_000), ...buildTurn(2, 80_000), ...buildTurn(3, 80_000)];
  const at = (keepTokens: number, maxPairs = 4) =>
    builderCushion({ history: h, compactions: undefined, keepTokens, maxPairs, caps: ['text'] });
  assert.equal(await at(10_000), 0, 'not even the newest fits');
  assert.equal(await at(25_000), 1);
  assert.equal(await at(45_000), 2);
  assert.equal(await at(1_000_000), 3);
  assert.equal(await at(1_000_000, 2), 2, 'capped by the normal cushion');
});

test('a builder above its target keeps only what fits and reaches it; a chat session is left alone', async (tt) => {
  const { server, port } = await startBackend();
  tt.after(() => server.close());
  // Three ~20k-token builds: ~60k, above the builder target (54k), below the chat trigger (72k).
  const history = [...buildTurn(1, 80_000), ...buildTurn(2, 80_000), ...buildTurn(3, 80_000)];

  const b = await run(port, 'builder', history);
  assert.equal(b.rows.length, 1, JSON.stringify(b.rows));
  const p = b.rows[0]!.payload;
  assert.equal(p.builderTarget, target);
  assert.equal(p.reachedTarget, true, p.text);
  assert.ok(p.contextAfter <= target, `${p.contextAfter} <= ${target}`);
  assert.match(p.text, /target \d+% reached, about [\d,]+ tokens free to work/);
  assert.ok((p.freeTokens ?? 0) >= 90_000 - target, String(p.freeTokens));
  assert.equal(summaryCalls, 1);

  const c = await run(port, 'chat', history);
  assert.equal(c.rows.length, 0, 'the chat trigger is not reached: no compaction');
  assert.equal(c.store.data().compactions, undefined);
  assert.equal(summaryCalls, 0);
});

test('one newest build too big on its own is compacted too', async (tt) => {
  const { server, port } = await startBackend();
  tt.after(() => server.close());
  // Two small turns, then one ~75k-token build (above the chat trigger too).
  const history = [...buildTurn(1, 400), ...buildTurn(2, 400), ...buildTurn(3, 300_000)];
  const b = await run(port, 'builder', history);
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0]!.payload.reachedTarget, true, b.rows[0]!.payload.text);
  assert.ok(b.rows[0]!.payload.contextAfter < 10_000, String(b.rows[0]!.payload.contextAfter));

  // The same history for a chat agent: as before, the four-pair cushion
  // covers everything, the second pass keeps the last exchange — the
  // big build stays, and the row carries no builder fields.
  const c = await run(port, 'chat', history);
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0]!.payload.builderTarget, undefined);
  assert.equal(c.rows[0]!.payload.reachedTarget, undefined);
  assert.ok(c.rows[0]!.payload.contextAfter > 60_000, String(c.rows[0]!.payload.contextAfter));
});

test('a builder below its target does not compact', async (tt) => {
  const { server, port } = await startBackend();
  tt.after(() => server.close());
  const b = await run(port, 'builder', [...buildTurn(1, 40_000), ...buildTurn(2, 40_000)]);
  assert.equal(b.rows.length, 0);
  assert.equal(summaryCalls, 0);
});

test('still above the target after the first pass: compacted once more, nothing kept', async (tt) => {
  const { server, port } = await startBackend();
  tt.after(() => server.close());
  // A ~30k-token summary: the two kept builds (~40k) plus it are above 54k.
  summaryText = 'SUMMARY ' + 'detail '.repeat(17_000);
  tt.after(() => { summaryText = 'SUMMARY: the parser was built and tested.'; });
  const history = [...buildTurn(1, 80_000), ...buildTurn(2, 80_000), ...buildTurn(3, 80_000)];
  const b = await run(port, 'builder', history);
  assert.equal(summaryCalls, 2, 'a second compaction ran');
  assert.equal(b.rows.length, 1, 'one row for the turn');
  assert.equal(b.rows[0]!.payload.reachedTarget, true, b.rows[0]!.payload.text);
  assert.equal((b.store.data().compactions as unknown[]).length, 2, 'both compactions stored');
});
