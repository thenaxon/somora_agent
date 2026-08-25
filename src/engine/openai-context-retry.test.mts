// Reactive context-overflow handling in the openai-compatible engine.
//
// 2026-08-22: somora estimated ~26k tokens for a session, the backend
// counted 251k and answered 400 "Prompt too long" — the pre-turn
// compaction never fired and the user saw a raw backend error on every
// turn. The engine must now: force a compaction, retry ONCE, and on a
// second refusal explain the situation instead of echoing the 400.
//
// Run: npx tsx src/engine/openai-context-retry.test.mts

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isContextLengthError, openAiCompatibleEngine } from './openai-compatible.ts';
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

// ── fake backend ─────────────────────────────────────────────────────
// /v1/chat/completions: chat requests (stream:true) are refused while
// they carry more than `tooLongAbove` messages; the compaction summary
// request (stream:false, 2 messages) always succeeds.
let tooLongAbove = 5;
const seen: Array<{ stream: boolean; n: number; status: number }> = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    const parsed = JSON.parse(body) as { stream?: boolean; messages: unknown[] };
    const n = parsed.messages.length;
    if (!parsed.stream) {
      seen.push({ stream: false, n, status: 200 });
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
    if (n > tooLongAbove) {
      seen.push({ stream: true, n, status: 400 });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: `litellm.BadRequestError: OpenAIException - Prompt too long: 251709 tokens exceeds max context window of 131072 tokens`, type: 'invalid_request_error' },
        }),
      );
      return;
    }
    seen.push({ stream: true, n, status: 200 });
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

// ── engine input ─────────────────────────────────────────────────────
let clock = 1_000_000;
const ts = () => (clock += 1000);
const history: NormalizedEvent[] = [];
for (let i = 1; i <= 6; i++) {
  history.push({ kind: 'user_message', ts: ts(), engine: 'openai-compatible', text: `question ${i} ${'x'.repeat(200)}` } as NormalizedEvent);
  history.push({ kind: 'assistant_message', ts: ts(), engine: 'openai-compatible', text: `answer ${i} ${'y'.repeat(200)}` } as NormalizedEvent);
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

const model = { id: 'm', contextWindow: 1_000_000, capabilities: ['text'] as const };
const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];

function input(store: SessionMetaStore): TurnInput {
  return {
    agent: 'a',
    session: 's',
    systemPrompt: 'SYS',
    userMessage: 'ping',
    history,
    metaStore: store,
    resolvedModel,
    availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 },
    idleTimeoutMs: 10_000,
  } as TurnInput;
}

async function collect(store: SessionMetaStore): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input(store))) out.push(ev);
  return out;
}

// ── classifier ───────────────────────────────────────────────────────
{
  check('classifier: litellm prompt too long', isContextLengthError(new Error('400 litellm.BadRequestError: OpenAIException - Prompt too long: 251709 tokens exceeds max context window of 131072 tokens')));
  check('classifier: oMLX prefill guard', isContextLengthError(new Error('400 oMLX prefill memory guard rejected this prompt: Prefill would require ~87.34 GB')));
  check('classifier: openai maximum context length', isContextLengthError(new Error("This model's maximum context length is 163840 tokens. However, you requested 170000 tokens")));
  check('classifier: context_length_exceeded code', isContextLengthError(new Error('400 context_length_exceeded')));
  check('classifier: unrelated 400 is not context', !isContextLengthError(new Error('400 invalid api key')));
  check('classifier: timeout is not context', !isContextLengthError(new Error('fetch failed: ETIMEDOUT')));
}

// ── overflow once → compaction → retry succeeds ──────────────────────
{
  tooLongAbove = 5;
  seen.length = 0;
  const store = memStore();
  const events = await collect(store);
  const kinds = events.map((e) => e.kind);
  check('exactly one turn_start', kinds.filter((k) => k === 'turn_start').length === 1, kinds.join(','));
  check('exactly one turn_end', kinds.filter((k) => k === 'turn_end').length === 1, kinds.join(','));
  check('no error event surfaced', !kinds.includes('error'), kinds.join(','));
  const meta = events.find((e) => e.kind === 'engine_meta') as { itemType?: string; payload?: { reason?: string } } | undefined;
  check('engine_meta context_compacted emitted', meta?.itemType === 'context_compacted' && meta.payload?.reason === 'context_overflow', JSON.stringify(meta));
  const final = events.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined;
  check('retry produced the answer', final?.text === 'pong', JSON.stringify(final));
  check('one compaction persisted', (store.data.compactions as unknown[] | undefined)?.length === 1, JSON.stringify(store.data));
  check('backend saw: 400 chat, summary, 200 chat', seen.map((s) => `${s.stream ? 'chat' : 'sum'}:${s.status}`).join(' ') === 'chat:400 sum:200 chat:200', JSON.stringify(seen));
  check('retried request was smaller', (seen[2]?.n ?? 99) < (seen[0]?.n ?? 0), JSON.stringify(seen));
}

// ── overflow persists → one retry, then a clear error, no loop ───────
{
  tooLongAbove = 0; // refuse everything
  seen.length = 0;
  const store = memStore();
  const events = await collect(store);
  const kinds = events.map((e) => e.kind);
  const err = events.find((e) => e.kind === 'error') as { message?: string } | undefined;
  check('second refusal → error event', typeof err?.message === 'string');
  check('error explains the situation (window + suggestion)', /context window/.test(err?.message ?? '') && /\/model|\/reset/.test(err?.message ?? ''), err?.message);
  check('backend message included', /Prompt too long/.test(err?.message ?? ''));
  check('exactly one retry (chat 400, summary, chat 400)', seen.filter((s) => s.stream).length === 2, JSON.stringify(seen));
  check('exactly one turn_end', kinds.filter((k) => k === 'turn_end').length === 1, kinds.join(','));
}

// ── nothing compactable (single pair) → straight to the clear error ──
{
  tooLongAbove = 0;
  seen.length = 0;
  const store = memStore();
  const short = input(store);
  short.history = history.slice(0, 2);
  const out: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(short)) out.push(ev);
  const err = out.find((e) => e.kind === 'error') as { message?: string } | undefined;
  check('no compaction possible → error names it', /nothing older could be compacted|last exchange/.test(err?.message ?? ''), err?.message);
  check('no summary request made', !seen.some((s) => !s.stream), JSON.stringify(seen));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
