// A tool call whose arguments arrive cut off must never go back on the
// wire, and must not be executed.
//
// 2026-09-10, spielberg/main: the model's call arrived as
// `{"project_id": "…", "files": ` — 64 characters, not valid JSON.
// somora ran it anyway (confusing "project_id is required") and then
// sent the fragment back with the next request. The backend parses
// tool-call arguments while building the prompt, so it answered
// 400 "Expecting value: line 1 column 65 (char 64)", and every further
// round of that turn hit the same wall. The whole turn was lost.
//
// Run: npm test src/engine/tool-args-cutoff.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';

/** The exact fragment from the incident. */
const CUT_OFF = '{"project_id": "a349a96a-7196-434c-9825-f7bec5356226", "files": ';
/** Complete, but not JSON: a slip, not a truncation. */
const MALFORMED = "{'path': 'a.txt'}";

const requests: Array<{ messages: any[] }> = [];
let invoked: string[] = [];
let finishReason = 'tool_calls';
/** What the first round answers with, and how often it repeats itself. */
let firstRoundArgs = CUT_OFF;
let badRounds = 1;
let usage: { completion_tokens?: number } | null = null;

function backend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: any[] };
        // What a real backend does with tool_calls it is handed back:
        // parse the arguments while rendering the prompt. This is the
        // 400 somora used to walk into.
        for (const m of parsed.messages) {
          for (const call of m.tool_calls ?? []) {
            try {
              JSON.parse(call.function.arguments);
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: `Expecting value: ${(err as Error).message}` } }));
              return;
            }
          }
        }
        requests.push({ messages: parsed.messages });
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (requests.length <= badRounds) {
          res.write(
            chunk({
              role: 'assistant',
              tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: 'write_files', arguments: firstRoundArgs } }],
            }),
          );
          res.write(chunk({}, finishReason));
          if (usage) {
            res.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, ...usage } })}\n\n`);
          }
        } else {
          res.write(chunk({ role: 'assistant', content: 'retried smaller' }));
          res.write(chunk({}, 'stop'));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const writeFiles = {
  name: 'write_files',
  toolset: 'file',
  description: 'writes files',
  inputSchema: { shape: {} },
  jsonSchema: { type: 'object', properties: {}, additionalProperties: true },
} as unknown as ToolDefinition;

const invoker: ToolInvoker = {
  list: () => [writeFiles],
  invoke: async (name: string) => {
    invoked.push(name);
    return { ok: true, data: { written: 1 } } as never;
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

async function run(port: number): Promise<NormalizedEvent[]> {
  const model = { id: 'm', contextWindow: 200_000, capabilities: ['text'] as const, maxTokens: 4_000 };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const input = {
    agent: 'a', session: 's', systemPrompt: 'SYS', userMessage: 'write the files',
    history: [] as NormalizedEvent[], metaStore: memStore(), resolvedModel, availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 }, idleTimeoutMs: 10_000, tools: invoker,
    agentLoopConfig: { maxRounds: 4, maxToolCalls: 10, toolCallTimeoutMs: 5_000 },
  } as unknown as TurnInput;
  const out: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) out.push(ev);
  return out;
}

test('a cut-off tool call is answered, not run, and never sent back as-is', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  invoked = [];
  finishReason = 'tool_calls';
  firstRoundArgs = CUT_OFF;
  badRounds = 1;
  usage = null;

  const events = await run(port);
  const kinds = events.map((e) => e.kind);

  assert.deepEqual(invoked, [], 'half a call is not executed');
  assert.ok(!kinds.includes('error'), `the turn survives: ${kinds.join(',')}`);
  const final = events.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined;
  assert.equal(final?.text, 'retried smaller', 'the model got its chance to retry');

  // The record keeps the fragment as evidence …
  const call = events.find((e) => e.kind === 'tool_call') as { input?: Record<string, unknown> } | undefined;
  assert.equal((call?.input as { _raw?: string })?._raw, CUT_OFF);

  // … but the second request carries valid JSON, or the backend in this
  // test would have answered 400 like the real one did.
  assert.equal(requests.length, 2, 'the second round went out at all');
  const assistant = requests[1]!.messages.find((m: any) => m.tool_calls);
  assert.equal(assistant.tool_calls[0].function.arguments, '{}');
  const toolMsg = requests[1]!.messages.find((m: any) => m.role === 'tool');
  assert.equal(toolMsg.tool_call_id, assistant.tool_calls[0].id, 'the pairing survives');
  assert.match(toolMsg.content, /arrived cut off after 64 characters/);
  assert.match(toolMsg.content, /Call it again with less in one go/);

  // And the client sees why, not a silent skip.
  const result = events.find((e) => e.kind === 'tool_result') as { error?: string } | undefined;
  assert.match(result?.error ?? '', /cut off after 64 characters/);
});

test('the output allowance is named when the round actually spent it', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  invoked = [];
  // The stop reason says 'tool_calls' — which is what vLLM writes even
  // when the real reason was the limit. The numbers are the evidence.
  finishReason = 'tool_calls';
  firstRoundArgs = CUT_OFF;
  badRounds = 1;
  usage = { completion_tokens: 4_000 }; // == the model's declared cap

  const events = await run(port);
  const result = events.find((e) => e.kind === 'tool_result') as { error?: string } | undefined;
  assert.match(result?.error ?? '', /used its whole output allowance \(4000 of 4000 tokens\)/);
  assert.deepEqual(invoked, []);
});

test('a merely malformed call is retried quietly first, then explained', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  invoked = [];
  finishReason = 'tool_calls';
  firstRoundArgs = MALFORMED;
  badRounds = 1;
  usage = null;

  const events = await run(port);
  // Round 1 was malformed, round 2 was the quiet retry that succeeded:
  // nothing about it reaches the model or the client.
  assert.equal(requests.length, 2, 'the same request went out again');
  assert.equal(events.filter((e) => e.kind === 'tool_result').length, 0, 'no tool result for a re-rolled round');
  const final = events.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined;
  assert.equal(final?.text, 'retried smaller');
});

test('a model that keeps sending invalid JSON is told what is wrong', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  invoked = [];
  finishReason = 'tool_calls';
  firstRoundArgs = MALFORMED;
  badRounds = 3; // more than the two quiet retries
  usage = null;

  const events = await run(port);
  const result = events.find((e) => e.kind === 'tool_result') as { error?: string } | undefined;
  assert.match(result?.error ?? '', /complete but its arguments are not valid JSON/);
  assert.match(result?.error ?? '', /use \{\}/);
  assert.doesNotMatch(result?.error ?? '', /cut off/, 'a typo is not a truncation');
  assert.deepEqual(invoked, [], 'still not executed');
});
