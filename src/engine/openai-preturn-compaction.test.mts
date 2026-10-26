// The automatic compaction before a turn says so in the chat.
//
// 2026-10-19: rudi's context gauge dropped from 87 % to 23 % and nothing
// in the history explained it. Of the four compaction paths (by hand,
// mid-turn, after an overflow, before a turn) only the last one wrote
// no `context_compacted` row. Now it does, exactly once, before the
// reply, with context numbers on the gauge's scale — not the size of
// the summarised slice.
//
// Run: npm test src/engine/openai-preturn-compaction (isolated SOMORA_HOME)

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// Fake backend: the summary request (stream:false) gets a short summary,
// every chat request a one-word answer.
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const parsed = JSON.parse(body) as { stream?: boolean };
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 's',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'SUMMARY: earlier turns discussed tetris.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      return;
    }
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(chunk({ role: 'assistant', content: 'pong' }));
    res.write(chunk({}, 'stop'));
    res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 50, completion_tokens: 1 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

let clock = 1_000_000;
const ts = () => (clock += 1000);
function historyOf(pairs: number, chars: number): NormalizedEvent[] {
  const h: NormalizedEvent[] = [];
  for (let i = 1; i <= pairs; i++) {
    h.push({ kind: 'user_message', ts: ts(), engine: 'openai-compatible', text: `question ${i} ${'x'.repeat(chars)}` } as NormalizedEvent);
    h.push({ kind: 'assistant_message', ts: ts(), engine: 'openai-compatible', text: `answer ${i} ${'y'.repeat(chars)}` } as NormalizedEvent);
  }
  return h;
}

function memStore(): SessionMetaStore & { data: SessionMeta } {
  const store = {
    data: {} as SessionMeta,
    async get() { return { ...store.data }; },
    async set(_a: string, _s: string, m: SessionMeta) { store.data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) { store.data = merge({ ...store.data }); return store.data; },
  };
  return store as unknown as SessionMetaStore & { data: SessionMeta };
}

function resolvedModelFor(contextWindow: number, id = 'm'): TurnInput['resolvedModel'] {
  // A declared output cap keeps the per-request budget sane on a tiny
  // window (the default reserve would leave nothing).
  const model = { id, contextWindow, maxTokens: Math.floor(contextWindow / 10), capabilities: ['text'] as const };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  return { providerName: 'fake', provider, modelId: id, model } as unknown as TurnInput['resolvedModel'];
}
/** A big-window worker, so the summary of an oversized slice fits. */
const worker = resolvedModelFor(1_000_000, 'worker');

async function run(history: NormalizedEvent[], contextWindow: number, store: SessionMetaStore, cushion = 4): Promise<NormalizedEvent[]> {
  const resolvedModel = resolvedModelFor(contextWindow);
  const input = {
    agent: 'a',
    session: 's',
    systemPrompt: 'SYS',
    userMessage: 'ping',
    history,
    metaStore: store,
    resolvedModel,
    availableModels: [resolvedModel, worker],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: cushion },
    idleTimeoutMs: 10_000,
  } as TurnInput;
  const out: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) out.push(ev);
  return out;
}

type Marker = {
  kind: 'engine_meta';
  itemType: string;
  payload: { text: string; reason: string; contextBefore: number; contextAfter: number; contextWindow: number; cushion?: number };
};
const markersOf = (events: NormalizedEvent[]) =>
  events.filter((e) => e.kind === 'engine_meta' && (e as Marker).itemType === 'context_compacted') as unknown as Marker[];

// ── the normal case: older pairs summarised, newest four kept ────────
{
  // 8 pairs × ~430 chars ≈ 900 tokens against a 1,000-token window
  // (trigger 0.8 × (1,000 − 100 output) = 720): compacts; the kept four
  // pairs are well below it.
  const store = memStore();
  const events = await run(historyOf(8, 200), 1_000, store);
  const markers = markersOf(events);
  check('exactly one context_compacted', markers.length === 1, JSON.stringify(markers));
  const m = markers[0];
  check('reason auto', m?.payload.reason === 'auto', JSON.stringify(m));
  check('context drops', !!m && m.payload.contextAfter < m.payload.contextBefore, JSON.stringify(m?.payload));
  check('before is the trigger reading, not the slice', !!m && m.payload.contextBefore >= 720, JSON.stringify(m?.payload));
  check('window carried', m?.payload.contextWindow === 1_000, JSON.stringify(m?.payload));
  check('text gives both percentages', !!m && /\d+% → about \d+% of the 1,000-token window/.test(m.payload.text), m?.payload.text);
  check('no cushion field on the normal path', m?.payload.cushion === undefined, JSON.stringify(m?.payload));
  const kinds = events.map((e) => (e.kind === 'engine_meta' ? 'meta' : e.kind));
  const iMeta = kinds.indexOf('meta');
  check('after turn_start, before the reply', kinds[0] === 'turn_start' && iMeta > 0 && iMeta < kinds.indexOf('assistant_message'), kinds.join(','));
  check('one compaction stored', (store.data.compactions as unknown[] | undefined)?.length === 1, JSON.stringify(store.data));
  check('the answer still came', (events.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined)?.text === 'pong');
}

// ── the tight case: the cushion covers everything, one exchange kept ──
{
  // 3 big pairs, cushion 4: the normal pass finds nothing to summarise,
  // the second pass keeps only the last exchange.
  const store = memStore();
  const events = await run(historyOf(3, 1_200), 1_000, store);
  const markers = markersOf(events);
  check('tight: exactly one context_compacted', markers.length === 1, JSON.stringify(markers));
  check('tight: cushion 1 recorded', markers[0]?.payload.cushion === 1, JSON.stringify(markers[0]?.payload));
  check('tight: reason auto', markers[0]?.payload.reason === 'auto');
}

// ── no compaction, no row ────────────────────────────────────────────
{
  const store = memStore();
  const events = await run(historyOf(2, 50), 100_000, store);
  check('small session: no context_compacted', markersOf(events).length === 0);
  check('small session: no compaction stored', store.data.compactions === undefined, JSON.stringify(store.data));
}

server.close();
console.log(`openai-preturn-compaction: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
