// Claude Code defers MCP tools behind its tool search, and a chat agent
// never once searched for ask_user (2026-10-26: three calls in all
// sessions, none from a chat agent; 1,908 ToolSearch calls overall). The
// tool child marks the tool catalog (src/tools/catalog.ts)
// `_meta['anthropic/alwaysLoad']` so those stay in the model's list —
// cut to what the turn offers — and it advertises the same JSON schema
// codex-cli and openai-compatible get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSession, sessionMetaStore } from '../storage/sessions.ts';
import { TURN_ATTENDED_KEY } from '../server/ask-attended.ts';
import { DEFAULT_ALWAYS_VISIBLE } from '../tools/catalog.ts';
import { registerAllTools, ToolRegistry } from '../tools/index.ts';
import { mcpAdvertisedSchema } from './tool-schema.ts';

const home = process.env.SOMORA_HOME!;
for (const [name, yaml] of [['al', 'model: x\n'], ['bo', 'kind: builder\nmodel: x\n']] as const) {
  mkdirSync(join(home, 'agents', name), { recursive: true });
  writeFileSync(join(home, 'agents', name, 'agent.yaml'), yaml);
  writeFileSync(join(home, 'agents', name, 'AGENTS.md'), `# ${name}\n`);
}

type Listed = { name: string; inputSchema: unknown; _meta?: Record<string, unknown> };

async function listed(agent: string, session: string, env: Record<string, string> = {}): Promise<Listed[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve('src/mcp/server.ts')],
    env: { ...(process.env as Record<string, string>), SOMORA_AGENT: agent, SOMORA_SESSION: session, ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools as Listed[];
  } finally {
    await client.close();
  }
}

const loaded = (tools: Listed[]): string[] => tools.filter((t) => t._meta?.['anthropic/alwaysLoad'] === true).map((t) => t.name).sort();

test('a chat agent: exactly the catalog tools it is offered stay loaded; ask_user only when offered', async () => {
  const id = await createSession('al', 'always-load');
  await sessionMetaStore.update('al', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: true }));
  const on = await listed('al', id);
  const offered = on.map((t) => t.name);
  assert.ok(offered.includes('ask_user'), 'offered in a turn a person started');
  assert.deepEqual(loaded(on), DEFAULT_ALWAYS_VISIBLE.filter((n) => offered.includes(n)).sort());
  assert.ok(on.some((t) => !t._meta), 'the rest stays deferred');
  await sessionMetaStore.update('al', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: false }));
  const off = await listed('al', id);
  assert.ok(!off.some((t) => t.name === 'ask_user'), 'gating decides first');
  assert.ok(!loaded(off).includes('ask_user'));
});

test('the engine hands the list over; the child still lists only what it offers', async () => {
  const id = await createSession('al', 'always-load-env');
  const tools = await listed('al', id, { SOMORA_ALWAYS_VISIBLE_TOOLS: JSON.stringify(['time_now', 'no_such_tool', 'ask_user']) });
  assert.deepEqual(loaded(tools), ['time_now'], 'ask_user is not offered here, no_such_tool does not exist');
});

test('a builder: its whole tool set is loaded', async () => {
  const id = await createSession('bo', 'always-load-builder');
  const tools = await listed('bo', id);
  assert.ok(tools.length > 0);
  assert.deepEqual(loaded(tools), tools.map((t) => t.name).sort());
});

test('every tool advertises its jsonSchema — the schema codex-cli and openai-compatible get — without top-level variants', async () => {
  const id = await createSession('al', 'always-load-schema');
  const reg = new ToolRegistry();
  registerAllTools(reg);
  for (const t of await listed('al', id)) {
    const def = reg.list().find((d) => d.name === t.name)!;
    if (def.forContext) continue; // context-shaped: compared in the guard test
    assert.deepEqual(t.inputSchema, JSON.parse(JSON.stringify(mcpAdvertisedSchema(def))), t.name);
    assert.ok(!('oneOf' in (t.inputSchema as object)), `${t.name}: no top-level oneOf for the Anthropic API`);
  }
});
