// The proxy child that serves one external MCP server to Claude and Grok
// applies the same tool rules as the main server — including an exception
// inside a built-in family (`deny: [toolset:file]`, `allow: [file_read]`),
// which this child once read as the old "only these" form and so served
// no external tool at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'mcp'), { recursive: true });
const tool = (raw: string) => ({ rawName: raw, fullName: `mcp__acme__${raw}`, description: raw, inputSchema: { type: 'object', properties: {} } });
writeFileSync(join(home, 'mcp', 'catalog.json'), JSON.stringify({ version: 1, updatedAt: Date.now(), servers: { acme: { state: 'connected', tools: [tool('x'), tool('y')] } } }));

const AGENTS: Record<string, { yaml: string; expect: string[] }> = {
  'px-plain': { yaml: '', expect: ['x', 'y'] },
  'px-exception': { yaml: 'tools:\n  deny: ["toolset:file"]\n  allow: ["file_read"]\n', expect: ['x', 'y'] },
  'px-server-off': { yaml: 'tools:\n  deny: ["mcp__acme__*"]\n  allow: ["mcp__acme__y"]\n', expect: ['y'] },
  'px-only-these': { yaml: 'tools:\n  allow: ["file_read"]\n', expect: [] },
  'px-everything-off': { yaml: 'tools:\n  deny: ["*"]\n  allow: ["mcp__acme__x"]\n', expect: ['x'] },
};
for (const [name, a] of Object.entries(AGENTS)) {
  mkdirSync(join(home, 'agents', name), { recursive: true });
  writeFileSync(join(home, 'agents', name, 'agent.yaml'), `model: x\n${a.yaml}`);
  writeFileSync(join(home, 'agents', name, 'AGENTS.md'), `# ${name}\n`);
}

async function served(agent: string, extraEnv: Record<string, string> = {}): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve('src/mcp/server.ts')],
    env: { ...(process.env as Record<string, string>), SOMORA_AGENT: agent, SOMORA_MCP_PROXY_SERVER: 'acme', ...extraEnv },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

for (const [name, a] of Object.entries(AGENTS)) {
  test(`proxy child serves ${JSON.stringify(a.expect)} to ${name}`, async () => {
    assert.deepEqual(await served(name), a.expect);
  });
}

// The session's own deny list reaches the proxy too (review 2026-10-26):
// claude-cli and grok-cli passed no session, so a sub-agent's or an
// outside task's `mcp__…` deny entries hid nothing.
test("a sub-agent session's deny list hides the external tool, through the engine's spawn settings", async () => {
  writeFileSync(
    join(home, 'config.yaml'),
    'providers:\n  p:\n    engine: openai-compatible\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: sk-test-ABCDEFGHIJKLMNOP\n    models:\n      - id: x\n        contextWindow: 1000\nsubagents:\n  tools:\n    deny: ["mcp__acme__x"]\n',
  );
  const { createSession, sessionMetaStore } = await import('../storage/sessions.ts');
  const { somoraMcpProxySpawn } = await import('./config.ts');
  const sid = await createSession('px-plain', 'sub-task');
  await sessionMetaStore.update('px-plain', sid, (m) => ({ ...m, spawn: { kind: 'sub', parentAgent: 'px-plain', parentSession: 'main' } }));
  const spawn = somoraMcpProxySpawn({ server: 'acme', agent: 'px-plain', session: sid });
  assert.equal(spawn.env.SOMORA_SESSION, sid, 'the session goes to the proxy');
  assert.deepEqual(await served('px-plain', { SOMORA_SESSION: sid }), ['y']);
  assert.deepEqual(await served('px-plain'), ['x', 'y'], 'the agent itself still has both');
});
