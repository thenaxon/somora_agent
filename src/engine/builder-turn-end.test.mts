// What a builder is told when it ends its turn, against a scripted
// backend: open task-list items (Hermes and DeepSeek-TUI hold a coding
// agent to its work at turn end) and an answer cut off by the output cap
// (OpenCode, DeepSeek-TUI and Hermes continue it). Builder only — a chat
// agent with the same script ends as before.
//
// Run: npm test src/engine/builder-turn-end.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';
import { mergeBuilderAcceptance, type AcceptanceItem } from '../server/builder-acceptance.ts';

type Reply = {
  text?: string;
  tool?: { name: string; args: object };
  finish?: string;
  completionTokens?: number;
};
type Script = (messages: Array<{ role: string; content?: unknown }>, n: number) => Reply;

let script: Script = () => ({ text: 'done' });
let requests: Array<Array<{ role: string; content?: unknown }>> = [];

function startBackend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> };
        requests.push(parsed.messages);
        const r = script(parsed.messages, requests.length);
        const chunk = (obj: object) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', ...obj })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (r.tool) {
          res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `c${requests.length}`, type: 'function', function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }, finish_reason: null }] }));
          res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
        } else {
          res.write(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: r.text ?? '' }, finish_reason: null }] }));
          res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: r.finish ?? 'stop' }] }));
        }
        res.write(chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: r.completionTokens ?? 20, total_tokens: 120 } }));
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function memStore(initial: Partial<SessionMeta> = {}): SessionMetaStore & { data: () => SessionMeta } {
  let data = { ...initial } as SessionMeta;
  return {
    data: () => data,
    async get() { return { ...data }; },
    async set(_a: string, _s: string, m: SessionMeta) { data = { ...m }; },
    async update(_a: string, _s: string, merge: (cur: SessionMeta) => SessionMeta) { data = merge({ ...data }); return data; },
  } as unknown as SessionMetaStore & { data: () => SessionMeta };
}

function tool(name: string): ToolDefinition {
  return {
    name,
    toolset: 'file',
    description: name,
    inputSchema: { shape: {} } as never,
    jsonSchema: { type: 'object', properties: {}, additionalProperties: true },
    async handler() { return { text: 'ok' }; },
  } as unknown as ToolDefinition;
}

async function run(
  port: number,
  opts: { kind: 'builder' | 'chat'; tools?: string[]; meta?: Partial<SessionMeta>; maxTokens?: number },
) {
  requests = [];
  const store = memStore(opts.meta);
  const names = opts.tools ?? ['todo_write', 'file_write', 'file_read'];
  const defs = names.map(tool);
  const invoker: ToolInvoker = {
    list: () => defs,
    invoke: async (name: string, args: unknown) => {
      // todo_write stores the list where the engine reads it.
      if (name === 'todo_write') await store.update('a', 's', (m) => ({ ...m, todos: (args as { todos: unknown }).todos }) as SessionMeta);
      // acceptance_write the same way, through the real merge rules.
      if (name === 'acceptance_write') {
        await store.update('a', 's', (m) => {
          const prev = Array.isArray((m as { acceptance?: unknown }).acceptance) ? ((m as { acceptance: AcceptanceItem[] }).acceptance) : [];
          return { ...m, acceptance: mergeBuilderAcceptance(prev, (args as { items: unknown[] }).items).items } as SessionMeta;
        });
      }
      return { ok: true, data: { text: 'ok' } } as never;
    },
  } as unknown as ToolInvoker;
  const model = { id: 'm', contextWindow: 200_000, capabilities: ['text'] as const, maxTokens: opts.maxTokens ?? 1_000 };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const input = {
    agent: 'a',
    agentKind: opts.kind,
    session: 's',
    systemPrompt: 'SYS',
    userMessage: 'build the thing',
    history: [] as NormalizedEvent[],
    metaStore: store,
    resolvedModel,
    availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 },
    idleTimeoutMs: 10_000,
    tools: invoker,
    agentLoopConfig: { maxRounds: 50, maxToolCallsPerTurn: 200, toolCallTimeoutMs: 5_000 },
  } as unknown as TurnInput;
  const events: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) events.push(ev);
  return { events, store };
}

/** Notices as they arrived: the newest message of a request (the history
 *  repeats every earlier one). */
const notices = (re: RegExp) =>
  requests.filter((msgs) => {
    const m = msgs.at(-1);
    return m?.role === 'user' && typeof m.content === 'string' && re.test(m.content);
  }).length;
const lastUserText = (msgs: Array<{ role: string; content?: unknown }>) => {
  const u = [...msgs].reverse().find((m) => m.role === 'user');
  return typeof u?.content === 'string' ? u.content : '';
};
const metaRows = (events: NormalizedEvent[], itemType: string) =>
  events.filter((e) => e.kind === 'engine_meta' && (e as { itemType?: string }).itemType === itemType);
const finalText = (events: NormalizedEvent[]) =>
  (events.filter((e) => e.kind === 'assistant_message').at(-1) as { text?: string } | undefined)?.text;

const twoOpen = { todos: [{ content: 'write the parser', status: 'completed' }, { content: 'wire the route', status: 'in_progress' }, { content: 'test the route', status: 'pending' }] };
const allDone = { todos: [{ content: 'write the parser', status: 'completed' }, { content: 'wire the route', status: 'completed' }, { content: 'test the route', status: 'completed' }] };

/** Plan, stop with two items open; after the notice, finish them and report. */
const worksAfterNotice: Script = (msgs, n) => {
  if (n === 1) return { tool: { name: 'todo_write', args: twoOpen } };
  if (/Your task list still has/.test(lastUserText(msgs)) && n <= 3) return { tool: { name: 'todo_write', args: allDone } };
  return { text: n === 2 ? 'I think that is it.' : 'Report: all three done and tested.' };
};

test('a builder ending with open items is told to continue, and finishes', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = worksAfterNotice;
  const { events } = await run(port, { kind: 'builder' });
  assert.equal(notices(/^\[somora\] Your task list still has 2 open item\(s\)/), 1, 'one notice');
  const notice = requests.flatMap((m) => m).find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('open item'));
  assert.match(String(notice?.content), /"wire the route", "test the route"/);
  assert.match(String(notice?.content), /do not shrink the task/);
  // The cut-short answer is in the history the model saw, before the notice.
  const afterNotice = requests[2]!;
  assert.equal(afterNotice.at(-2)?.role, 'assistant');
  assert.equal(afterNotice.at(-2)?.content, 'I think that is it.');
  assert.equal(metaRows(events, 'open_tasks_notice').length, 1);
  assert.match(String((metaRows(events, 'open_tasks_notice')[0] as { payload?: { text?: string } }).payload?.text), /2 open item/);
  assert.equal(requests.length, 4);
  assert.match(String(finalText(events)), /Report: all three done/);
});

test('a builder that ends again right after the notice is let go', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = (_m, n) => (n === 1 ? { tool: { name: 'todo_write', args: twoOpen } } : { text: n === 2 ? 'done?' : 'Blocked: the route needs a key I do not have.' });
  const { events } = await run(port, { kind: 'builder' });
  assert.equal(notices(/Your task list still has/), 1);
  assert.equal(requests.length, 3, 'no second notice for its considered answer');
  const end = events.find((e) => e.kind === 'turn_end') as { forced_final?: string } | undefined;
  assert.equal(end?.forced_final, undefined);
});

test('at most two open-task notices per turn', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  // Ends, gets a notice, does one more step, ends again — three times.
  script = (msgs, n) => {
    if (n === 1) return { tool: { name: 'todo_write', args: twoOpen } };
    if (/Your task list still has/.test(lastUserText(msgs))) return { tool: { name: 'file_read', args: { n } } };
    return { text: `stop ${n}` };
  };
  await run(port, { kind: 'builder' });
  assert.equal(notices(/Your task list still has/), 2);
});

test('a chat agent with the same script ends as before', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = worksAfterNotice;
  const { events } = await run(port, { kind: 'chat' });
  assert.equal(notices(/Your task list still has/), 0);
  assert.equal(requests.length, 2);
  assert.equal(metaRows(events, 'open_tasks_notice').length, 0);
});

test('no notice in the plan phase (no file_write, no file_patch)', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = worksAfterNotice;
  await run(port, { kind: 'builder', tools: ['todo_write', 'file_read', 'plan_write'] });
  assert.equal(notices(/Your task list still has/), 0);
});

test('no notice when this turn did not work the list (a question about the state)', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = (_m, n) => (n === 1 ? { tool: { name: 'file_read', args: {} } } : { text: 'Two items are still open.' });
  await run(port, { kind: 'builder', meta: twoOpen as Partial<SessionMeta> });
  assert.equal(notices(/Your task list still has/), 0);
});

test('a builder answer cut by the output cap is continued and joined', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  // The router said "stop"; only the token count shows the cut.
  script = (_m, n) => (n === 1 ? { text: 'Report: the parser is done and the ro', completionTokens: 1_000 } : { text: 'ute is wired.' });
  const { events } = await run(port, { kind: 'builder' });
  assert.equal(notices(/^\[somora\] Your last response was cut off by the output limit/), 1);
  assert.equal(requests[1]!.at(-2)?.content, 'Report: the parser is done and the ro');
  assert.equal(finalText(events), 'Report: the parser is done and the route is wired.');
  const msg = events.filter((e) => e.kind === 'assistant_message').at(-1) as { final?: string } | undefined;
  assert.equal(msg?.final ?? finalText(events), 'Report: the parser is done and the route is wired.');
  assert.equal(metaRows(events, 'answer_cut_off').length, 1);
});

test('finish_reason "length" alone also counts as a cut', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = (_m, n) => (n === 1 ? { text: 'part one', finish: 'length' } : { text: ', part two' });
  const { events } = await run(port, { kind: 'builder' });
  assert.equal(finalText(events), 'part one, part two');
});

test('at most two continues; a chat agent is not continued', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = (_m, n) => ({ text: `p${n} `, completionTokens: 1_000 });
  await run(port, { kind: 'builder' });
  assert.equal(notices(/cut off by the output limit/), 2);
  assert.equal(requests.length, 3);

  const chat = await run(port, { kind: 'chat' });
  assert.equal(notices(/cut off by the output limit/), 0);
  assert.equal(requests.length, 1);
  assert.equal(finalText(chat.events)?.trim(), 'p1');
});

test('an answer well under the cap is not continued', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = () => ({ text: 'Report: done.', completionTokens: 400 });
  await run(port, { kind: 'builder' });
  assert.equal(requests.length, 1);
});

// ── the acceptance list (builder_dispatch orders) ───────────────────

const accTools = ['todo_write', 'acceptance_write', 'file_write', 'file_read'];
const twoReqs = { items: [{ id: 'A01', requirement: 'rejected never shows completed', status: 'passed', evidence: 'gate.test: rejected → failed' }, { id: 'A02', requirement: 'compare by content', status: 'open' }] };

test('a required list with an open item: told to check it, and the report ends with the list', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = (msgs, n) => {
    if (n === 1) return { tool: { name: 'acceptance_write', args: twoReqs } };
    if (/acceptance list still has/.test(lastUserText(msgs)) && n === 3) {
      return { tool: { name: 'acceptance_write', args: { items: [twoReqs.items[0], { id: 'A02', status: 'failed', evidence: '90 vs 100 judged as agreement' }] } } };
    }
    return { text: n === 2 ? 'Done.' : 'Report: A01 passed, A02 failed.' };
  };
  const { events } = await run(port, { kind: 'builder', tools: accTools, meta: { acceptanceRequired: true } as Partial<SessionMeta> });
  assert.equal(notices(/Your acceptance list still has 1 open item\(s\): A02/), 1);
  // The last reply (`final`, what the orderer reads) is the report plus the list.
  const last = events.filter((e) => e.kind === 'assistant_message').at(-1) as { final?: string } | undefined;
  const text = String(last?.final);
  assert.match(text, /^Report: A01 passed, A02 failed\./);
  assert.match(text, /## Acceptance list \(from the session\)/);
  assert.match(text, /\| A02 \| compare by content \| failed \| 90 vs 100 judged as agreement \|/);
  const row = metaRows(events, 'open_tasks_notice')[0] as { payload?: { acceptanceOpen?: number } } | undefined;
  assert.equal(row?.payload?.acceptanceOpen, 1);
});

test('a required list that was never written: told to write it', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = (msgs, n) => {
    if (/requires an acceptance list and there is none/.test(lastUserText(msgs))) return { tool: { name: 'acceptance_write', args: { items: [{ id: 'A01', requirement: 'r', status: 'not_run', evidence: 'no browser here' }] } } };
    return { text: `answer ${n}` };
  };
  const { events } = await run(port, { kind: 'builder', tools: accTools, meta: { acceptanceRequired: true } as Partial<SessionMeta> });
  assert.equal(notices(/requires an acceptance list and there is none/), 1);
  assert.match(String(finalText(events)), /\| A01 \| r \| not_run \| no browser here \|/);
});

test('without the requirement and without a write this turn: no notice, no table', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = () => ({ text: 'The status is as before.' });
  const stale = mergeBuilderAcceptance([], twoReqs.items).items;
  const { events } = await run(port, { kind: 'builder', tools: accTools, meta: { acceptance: stale } as Partial<SessionMeta> });
  assert.equal(requests.length, 1);
  assert.equal(finalText(events), 'The status is as before.');
});

test('a chat agent is never held to a list, and its answer is never extended', async (t) => {
  const { server, port } = await startBackend();
  t.after(() => server.close());
  script = () => ({ text: 'plain answer' });
  const stale = mergeBuilderAcceptance([], twoReqs.items).items;
  const { events } = await run(port, { kind: 'chat', meta: { acceptance: stale, acceptanceRequired: true } as Partial<SessionMeta> });
  assert.equal(requests.length, 1);
  assert.equal(finalText(events), 'plain answer');
});
