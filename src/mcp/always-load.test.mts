// Claude Code defers MCP tools behind its tool search, and a chat agent
// never once searched for ask_user (2026-10-26: three calls in all
// sessions, none from a chat agent). The tool child marks ask_user
// `_meta['anthropic/alwaysLoad']` so it stays in the model's list — and
// still lists it only in a turn a person started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSession, sessionMetaStore } from '../storage/sessions.ts';
import { TURN_ATTENDED_KEY } from '../server/ask-attended.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'al'), { recursive: true });
writeFileSync(join(home, 'agents', 'al', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'al', 'AGENTS.md'), '# al\n');

async function listed(session: string): Promise<Array<{ name: string; _meta?: Record<string, unknown> }>> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve('src/mcp/server.ts')],
    env: { ...(process.env as Record<string, string>), SOMORA_AGENT: 'al', SOMORA_SESSION: session },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
  } finally {
    await client.close();
  }
}

test('ask_user stays in the list when offered, and is not listed otherwise', async () => {
  const id = await createSession('al', 'always-load');
  await sessionMetaStore.update('al', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: true }));
  const on = await listed(id);
  const ask = on.find((t) => t.name === 'ask_user');
  assert.ok(ask, 'offered in a turn a person started');
  assert.equal(ask!._meta?.['anthropic/alwaysLoad'], true);
  const exec = on.find((t) => t.name === 'exec');
  assert.ok(exec && exec._meta?.['anthropic/alwaysLoad'] === undefined, 'the others stay deferred');
  await sessionMetaStore.update('al', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: false }));
  assert.ok(!(await listed(id)).some((t) => t.name === 'ask_user'), 'gating decides first');
});
