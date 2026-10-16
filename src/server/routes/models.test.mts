// POST /agents/:agent/tools/:name on its own Hono app: the agent's tool
// locks hold here as in a chat turn — a tool, a family or a builder-only
// tool turned off answers 403 and never runs; an allowed tool runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { ConfigSchema } from '../../config/types.ts';
import { ToolRegistry } from '../../tools/registry.ts';
import type { ToolDefinition, Toolset } from '../../tools/types.ts';
import { setConfig } from '../server-state.ts';
import { registerModelRoutes } from './models.ts';

const home = process.env.SOMORA_HOME!;
function agent(name: string, yaml: string) {
  mkdirSync(join(home, 'agents', name), { recursive: true });
  writeFileSync(join(home, 'agents', name, 'agent.yaml'), yaml);
  writeFileSync(join(home, 'agents', name, 'AGENTS.md'), `# ${name}\n`);
}
agent('ada', 'model: x\ntools:\n  deny: [secret_tool, "toolset:dream"]\n');
agent('bo', 'model: x\n');
setConfig(ConfigSchema.parse({ providers: {} }));

const ran: string[] = [];
const fake = (name: string, toolset: Toolset): ToolDefinition => ({
  name,
  description: name,
  toolset,
  inputSchema: z.object({}).passthrough(),
  jsonSchema: { type: 'object' },
  handler: async () => {
    ran.push(name);
    return { done: name };
  },
});
const tools = new ToolRegistry();
tools.registerMany([fake('secret_tool', 'memory'), fake('dream_list', 'dream'), fake('time_now', 'time'), fake('todo_write', 'builder')]);

const app = new Hono();
registerModelRoutes(app, { tools } as Parameters<typeof registerModelRoutes>[1]);
const call = async (who: string, tool: string) => {
  const r = await app.request(`/agents/${who}/tools/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

test('a tool the agent has turned off answers 403 and does not run', async () => {
  ran.length = 0;
  const r = await call('ada', 'secret_tool');
  assert.equal(r.status, 403);
  assert.equal(r.body.ok, false);
  assert.match(String(r.body.error), /turned off for agent 'ada'/);
  assert.deepEqual(ran, []);
});

test('a family turned off covers its tools', async () => {
  ran.length = 0;
  assert.equal((await call('ada', 'dream_list')).status, 403);
  assert.deepEqual(ran, []);
});

test('a chat agent does not get builder-only tools here either', async () => {
  assert.equal((await call('bo', 'todo_write')).status, 403);
});

test('an allowed tool runs; another agent without the lock runs the locked one', async () => {
  ran.length = 0;
  const own = await call('ada', 'time_now');
  assert.equal(own.status, 200);
  assert.equal(own.body.ok, true);
  assert.equal((await call('bo', 'secret_tool')).status, 200);
  assert.deepEqual(ran, ['time_now', 'secret_tool']);
});

test('unknown agent 404, unknown tool still the registry\'s own answer', async () => {
  assert.equal((await call('nobody', 'time_now')).status, 404);
  const r = await call('ada', 'time_nwo');
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /unknown tool/);
});
