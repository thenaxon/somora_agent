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

async function served(agent: string): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve('src/mcp/server.ts')],
    env: { ...(process.env as Record<string, string>), SOMORA_AGENT: agent, SOMORA_MCP_PROXY_SERVER: 'acme' },
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
