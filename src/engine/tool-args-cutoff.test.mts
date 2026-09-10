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

const requests: Array<{ messages: any[] }> = [];
let invoked: string[] = [];
let finishReason = 'tool_calls';

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
        if (requests.length === 1) {
          res.write(
            chunk({
              role: 'assistant',
              tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write_files', arguments: CUT_OFF } }],
            }),
          );
          res.write(chunk({}, finishReason));
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
  assert.match(toolMsg.content, /Call it again with complete arguments/);

  // And the client sees why, not a silent skip.
  const result = events.find((e) => e.kind === 'tool_result') as { error?: string } | undefined;
  assert.match(result?.error ?? '', /cut off after 64 characters/);
});

test('when the output limit cut it off, the model is told that', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  invoked = [];
  finishReason = 'length';

  const events = await run(port);
  const result = events.find((e) => e.kind === 'tool_result') as { error?: string } | undefined;
  assert.match(result?.error ?? '', /hit the output limit/);
  assert.deepEqual(invoked, []);
});
