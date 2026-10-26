// Catalog mode for the openai-compatible engine: the always-visible
// tools in full, tool_search + tool_call, the rest named at the end of
// the system prompt — and mode `all` sending exactly what it sent before.
//
// Run: npm test src/engine/openai-tool-catalog.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openAiCompatibleEngine } from './openai-compatible.ts';
import {
  buildSearchIndex,
  explainInvalidInput,
  planCatalog,
  renderListing,
  routeCall,
  runToolSearch,
  signature,
  stem,
  TOOL_CALL,
  TOOL_SEARCH,
} from './openai-tool-catalog.ts';
import { catalogMode } from '../tools/catalog.ts';
import type { SessionMeta, SessionMetaStore, TurnInput } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';

const def = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({
    name,
    toolset: 'x',
    description,
    inputSchema: {},
    jsonSchema: { type: 'object', properties, required, additionalProperties: false },
  }) as unknown as ToolDefinition;

const EXEC = def('exec', 'Run a shell command on the server.', { command: { type: 'string', description: 'The command.' } }, ['command']);
const FILE_READ = def('file_read', 'Read a file.', { path: { type: 'string', description: 'Path.' } }, ['path']);
const SENTINEL = def(
  'sentinel',
  'Install and manage triggers that wake an agent later — reminders at a time, or checks that watch for an event.',
  {
    action: { type: 'string', enum: ['create', 'dry_run', 'update', 'list', 'get', 'pause', 'resume', 'delete'], description: 'What to do.' },
    id: { type: 'string', description: 'Trigger id.' },
    source: { description: 'When it fires.', oneOf: [{ type: 'object', properties: { type: { const: 'time' } } }, { type: 'object', properties: { type: { const: 'check' } } }] },
  },
  ['action'],
);
const IMAGE_MODELS = def('image_models', 'List the image generation models you can use.');
const XAPI = def('mcp__xapi__search_posts_all', 'Search all posts on X by keyword.', { query: { type: 'string', description: 'Search text.' } }, ['query']);
const VIDEO = def('video_generate', 'Generate a video from a prompt.', { prompt: { type: 'string', description: 'What to show.' } }, ['prompt']);

const OFFERED = [EXEC, FILE_READ, SENTINEL, IMAGE_MODELS, XAPI, VIDEO];
const DIRECT = ['exec', 'file_read', 'memory_get'];
const SETTINGS = { mode: 'catalog' as const, listingMaxChars: 8000, defaultResults: 5, maxResults: 20 };

// ── units ────────────────────────────────────────────────────────────

test('stemming lets plural, -ing and -ed meet', () => {
  assert.equal(stem('images'), stem('image'));
  assert.equal(stem('scheduling'), stem('schedule'));
  assert.equal(stem('generated'), stem('generate'));
  assert.equal(stem('reminders'), stem('reminder'));
});

test('search finds by meaning words, ranks the name first, and says "no match" to nonsense', () => {
  const idx = buildSearchIndex([SENTINEL, IMAGE_MODELS, XAPI, VIDEO]);
  assert.equal(idx.search(['reminder trigger create'], 5)[0]?.name, 'sentinel');
  assert.equal(idx.search(['image models list'], 5)[0]?.name, 'image_models');
  assert.equal(idx.search(['search posts on x'], 5)[0]?.name, 'mcp__xapi__search_posts_all');
  assert.deepEqual(idx.search(['quantum banana teleport'], 5), [], 'nothing answerable, nothing returned');
  assert.equal(idx.search(['sentinel'], 5)[0]?.name, 'sentinel', 'an exact name is found as is');
  const hit = idx.search(['xapi'], 5)[0]!;
  assert.equal(hit.server, 'xapi');
  assert.match(hit.input, /query: string/);
});

test('the signature is compact: required plain, optional with ?, enums and unions short', () => {
  const sig = signature(SENTINEL.jsonSchema as never);
  assert.match(sig, /^\{ action: "create"\|"dry_run"\|"update"\|"list"\|"get"\|"pause"\|…; id\?: string; source\?: object \(type: "time"\|"check"\) \}$/);
  assert.equal(signature({ type: 'object', properties: {} }), '{}');
});

test('the listing names every deferred tool, groups external servers, shrinks to fit', () => {
  const full = renderListing([SENTINEL, IMAGE_MODELS, XAPI], 8000);
  assert.match(full, /^## More tools, found on demand/);
  assert.match(full, /somora:\n- image_models — List the image generation models you can use\n- sentinel — /);
  assert.match(full, /xapi \(external MCP server\):\n- mcp__xapi__search_posts_all — Search all posts on X by keyword/);
  assert.equal(renderListing([SENTINEL, IMAGE_MODELS, XAPI], 8000), full, 'same input, same bytes');
  const names = renderListing([SENTINEL, IMAGE_MODELS, XAPI], 520);
  assert.ok(names.length <= 520 || /3 tools|tools — find them/.test(names));
  assert.match(renderListing([SENTINEL, IMAGE_MODELS, XAPI], 500), /tools — find them with tool_search|sentinel/);
});

test('plan: nothing deferred (mode all, or every tool direct) means no catalog', () => {
  assert.equal(planCatalog({ offered: OFFERED, direct: DIRECT, settings: { ...SETTINGS, mode: 'all' } }), null);
  assert.equal(planCatalog({ offered: OFFERED, direct: OFFERED.map((d) => d.name), settings: SETTINGS }), null);
  const plan = planCatalog({ offered: OFFERED, direct: DIRECT, settings: SETTINGS })!;
  assert.deepEqual(plan.direct.map((d) => d.name), ['exec', 'file_read'], 'memory_get is not offered, so not direct');
  assert.deepEqual(plan.deferred.map((d) => d.name), ['sentinel', 'image_models', 'mcp__xapi__search_posts_all', 'video_generate']);
});

test('routing: search, tool_call unwraps, a deferred name runs hydrated, an unoffered name is refused', () => {
  const plan = planCatalog({ offered: OFFERED, direct: DIRECT, settings: SETTINGS })!;
  const offered = new Set(OFFERED.map((d) => d.name));
  assert.deepEqual(routeCall(plan, offered, TOOL_SEARCH, {}), { kind: 'search' });
  assert.deepEqual(routeCall(plan, offered, TOOL_CALL, { name: 'sentinel', arguments: { action: 'list' } }), { kind: 'run', name: 'sentinel', args: { action: 'list' }, via: 'tool_call' });
  assert.deepEqual(routeCall(plan, offered, TOOL_CALL, { name: 'sentinel', arguments: '{"action":"list"}' }), { kind: 'run', name: 'sentinel', args: { action: 'list' }, via: 'tool_call' }, 'arguments as JSON text');
  assert.deepEqual(routeCall(plan, offered, TOOL_CALL, { name: 'exec', arguments: { command: 'ls' } }), { kind: 'run', name: 'exec', args: { command: 'ls' }, via: 'tool_call' }, 'a direct tool through tool_call just runs');
  assert.deepEqual(routeCall(plan, offered, 'sentinel', { action: 'list' }), { kind: 'run', name: 'sentinel', args: { action: 'list' }, via: 'hydrated' });
  assert.deepEqual(routeCall(plan, offered, 'exec', { command: 'ls' }), { kind: 'run', name: 'exec', args: { command: 'ls' } });
  const unknown = routeCall(plan, offered, TOOL_CALL, { name: 'sentinal', arguments: {} });
  assert.equal(unknown.kind, 'reject');
  assert.match((unknown as { error: string }).error, /no tool 'sentinal'.*Did you mean: sentinel/);
  const gated = routeCall(plan, offered, 'secret_tool', {});
  assert.equal(gated.kind, 'reject', 'a tool the turn does not offer never runs');
  assert.equal(routeCall(null, offered, 'secret_tool', {}).kind, 'reject', 'in mode all too');
  assert.equal(routeCall(plan, offered, TOOL_CALL, { name: 'tool_search' }).kind, 'reject');
});

test('tool_search: queries, names for full descriptions, gated names not found', () => {
  const plan = planCatalog({ offered: OFFERED, direct: DIRECT, settings: SETTINGS })!;
  const r = runToolSearch(plan, OFFERED, { queries: ['video generate'] });
  assert.ok(r.ok);
  assert.equal((r.data as { matches: Array<{ name: string }> }).matches[0]!.name, 'video_generate');
  const none = runToolSearch(plan, OFFERED, { queries: ['zzz qqq'] }) as { ok: true; data: { matches: unknown[]; sources: Array<{ source: string }> } };
  assert.deepEqual(none.data.matches, []);
  assert.deepEqual(none.data.sources.map((s) => s.source).sort(), ['somora', 'xapi']);
  const full = runToolSearch(plan, OFFERED, { names: ['sentinel', 'secret_tool'] }) as { ok: true; data: { tools: Array<{ name: string; input: { properties: Record<string, unknown> } }>; not_found: Array<{ name: string }> } };
  assert.ok(full.data.tools[0]!.input.properties.action, 'full schema with field texts');
  assert.deepEqual(full.data.not_found.map((n) => n.name), ['secret_tool']);
  assert.equal(runToolSearch(plan, OFFERED, {}).ok, false);
  assert.ok(runToolSearch(plan, OFFERED, { query: 'image models' }).ok, 'a single query string is accepted');
});

test('a refused input names the closest real fields', () => {
  const msg = explainInvalidInput('invalid input for sentinel: (root): Unrecognized key: "acton"', SENTINEL);
  assert.match(msg, /'acton' → action/);
});

test('mode: a model setting wins over its engine, builders and other engines stay all', () => {
  const catalog = { alwaysVisible: [], engines: { 'openai-compatible': { mode: 'catalog' as const } }, models: { weak: { mode: 'all' as const } } };
  assert.equal(catalogMode({ engine: 'openai-compatible', modelRefs: ['p/strong'], catalog }), 'catalog');
  assert.equal(catalogMode({ engine: 'openai-compatible', modelRefs: ['p/weak', 'weak'], catalog }), 'all');
  assert.equal(catalogMode({ engine: 'openai-compatible', kind: 'builder', modelRefs: ['p/strong'], catalog }), 'all');
  assert.equal(catalogMode({ engine: 'codex-cli', modelRefs: [], catalog }), 'all');
  assert.equal(catalogMode({ engine: 'openai-compatible', modelRefs: [] }), 'catalog', 'default');
});

// ── through the engine with a scripted backend ─────────────────────────

type Step = { call?: { name: string; args: unknown } } | { text: string };
let script: Step[] = [];
const requests: Array<{ tools?: unknown[]; messages: Array<{ role: string; content: unknown }> }> = [];
let invoked: Array<{ name: string; args: unknown }> = [];

function backend(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> };
        requests.push({ ...(parsed.tools ? { tools: parsed.tools } : {}), messages: parsed.messages });
        const step = script.shift() ?? { text: 'done' };
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if ('call' in step && step.call && parsed.tools) {
          res.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }));
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: 'text' in step ? step.text : 'final' }));
          res.write(chunk({}, 'stop'));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

const invoker: ToolInvoker = {
  list: () => OFFERED,
  invoke: async (name: string, args: unknown) => {
    invoked.push({ name, args });
    if (name === 'sentinel' && args && typeof args === 'object' && 'acton' in args) {
      return { ok: false, error: 'invalid input for sentinel: (root): Unrecognized key: "acton"' } as never;
    }
    return { ok: true, data: { ran: name } } as never;
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

async function run(port: number, opts: { mode?: 'all' | 'catalog'; direct?: string[] } = {}): Promise<NormalizedEvent[]> {
  const model = { id: 'm', contextWindow: 200_000, capabilities: ['text'] as const, maxTokens: 4_000 };
  const provider = { engine: 'openai-compatible' as const, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x', models: [model] };
  const resolvedModel = { providerName: 'fake', provider, modelId: 'm', model } as unknown as TurnInput['resolvedModel'];
  const input = {
    agent: 'a', session: 's', systemPrompt: 'SYS', userMessage: 'go',
    history: [] as NormalizedEvent[], metaStore: memStore(), resolvedModel, availableModels: [resolvedModel],
    compactionConfig: { triggerRatio: 0.8, safetyCushionPairs: 4 }, idleTimeoutMs: 10_000, tools: invoker,
    agentLoopConfig: { maxRounds: 10, maxToolCallsPerTurn: 20, toolCallTimeoutMs: 5_000 },
    alwaysVisibleTools: () => opts.direct ?? DIRECT,
    ...(opts.mode ? { toolCatalogSettings: () => ({ ...SETTINGS, mode: opts.mode! }) } : {}),
  } as unknown as TurnInput;
  const out: NormalizedEvent[] = [];
  for await (const ev of openAiCompatibleEngine.runTurn(input)) out.push(ev);
  return out;
}

const toolNames = (r: { tools?: unknown[] }) => (r.tools ?? []).map((t) => (t as { function: { name: string } }).function.name);

test('mode all sends every schema and the plain system prompt, as before', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  script = [{ text: 'hi' }];
  for (const opts of [{}, { mode: 'all' as const }]) {
    requests.length = 0;
    script = [{ text: 'hi' }];
    await run(port, opts);
    assert.deepEqual(
      requests[0]!.tools,
      OFFERED.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.jsonSchema } })),
      'byte for byte the old tools array',
    );
    assert.equal(requests[0]!.messages[0]!.content, 'SYS');
  }
});

test('catalog mode: fixed tools array, listing in the system prompt, real names on record, gating holds', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  invoked = [];
  script = [
    { call: { name: TOOL_SEARCH, args: { queries: ['reminder trigger'] } } },
    { call: { name: TOOL_CALL, args: { name: 'sentinel', arguments: { action: 'list' } } } },
    { call: { name: 'image_models', args: {} } },
    { call: { name: 'secret_tool', args: {} } },
    { call: { name: TOOL_CALL, args: { name: 'sentinel', arguments: { acton: 'list' } } } },
    { text: 'all done' },
  ];
  const events = await run(port, { mode: 'catalog' });

  assert.deepEqual(toolNames(requests[0]!), ['exec', 'file_read', TOOL_SEARCH, TOOL_CALL]);
  const sys = requests[0]!.messages[0]!.content as string;
  assert.ok(sys.startsWith('SYS\n\n## More tools, found on demand'), sys.slice(0, 60));
  assert.match(sys, /- sentinel — /);
  assert.match(sys, /xapi \(external MCP server\):/);
  for (const r of requests) {
    assert.equal(JSON.stringify(r.tools), JSON.stringify(requests[0]!.tools), 'same tools bytes every round');
    assert.equal(r.messages[0]!.content, sys, 'same system prompt bytes every round');
  }

  assert.deepEqual(invoked.map((i) => i.name), ['sentinel', 'image_models', 'sentinel'], 'secret_tool never ran');
  const calls = events.filter((e) => e.kind === 'tool_call') as Array<{ tool: string; input: unknown; via?: string }>;
  assert.deepEqual(calls.map((c) => [c.tool, c.via ?? null]), [
    [TOOL_SEARCH, null],
    ['sentinel', 'tool_call'],
    ['image_models', 'hydrated'],
    ['secret_tool', null],
    ['sentinel', 'tool_call'],
  ]);
  assert.deepEqual(calls[1]!.input, { action: 'list' }, 'the real arguments on record');
  const results = events.filter((e) => e.kind === 'tool_result') as Array<{ output: unknown; error?: string }>;
  assert.equal((results[0]!.output as { matches: Array<{ name: string }> }).matches[0]!.name, 'sentinel');
  assert.match(results[3]!.error ?? '', /no tool 'secret_tool'/);
  assert.match(results[4]!.error ?? '', /'acton' → action/, 'field-level help');
  const final = events.find((e) => e.kind === 'assistant_message') as { text?: string };
  assert.equal(final.text, 'all done');
});

test('catalog mode: two turns with the same tools send the same prefix', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  script = [{ text: 'one' }];
  await run(port, { mode: 'catalog' });
  script = [{ text: 'two' }];
  await run(port, { mode: 'catalog' });
  assert.equal(JSON.stringify(requests[0]!.tools), JSON.stringify(requests[1]!.tools));
  assert.equal(requests[0]!.messages[0]!.content, requests[1]!.messages[0]!.content);
});

test('catalog mode with every tool direct (a builder) sends what mode all sends', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  script = [{ text: 'hi' }];
  await run(port, { mode: 'catalog', direct: OFFERED.map((d) => d.name) });
  assert.deepEqual(toolNames(requests[0]!), OFFERED.map((d) => d.name));
  assert.equal(requests[0]!.messages[0]!.content, 'SYS');
});

test('the third identical failing tool_call ends the tool use with a forced answer', async (t) => {
  const { server, port } = await backend();
  t.after(() => server.close());
  requests.length = 0;
  invoked = [];
  const bad = { call: { name: TOOL_CALL, args: { name: 'nope', arguments: {} } } };
  script = [bad, bad, bad, { text: 'gave up cleanly' }];
  const events = await run(port, { mode: 'catalog' });
  assert.equal(requests.length, 4, 'three failing rounds, then the forced answer');
  assert.equal(requests[3]!.tools, undefined, 'the forced answer is asked without tools');
  const final = events.find((e) => e.kind === 'assistant_message') as { text?: string };
  assert.equal(final.text, 'gave up cleanly');
  assert.deepEqual(invoked, []);
});
