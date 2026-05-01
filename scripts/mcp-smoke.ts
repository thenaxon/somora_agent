// MCP server smoke test. Spawns src/mcp/server.ts as a child via the
// Anthropic MCP SDK's stdio client and exercises the JSON-RPC handshake
// + a few tool calls. Mirrors what claude-cli will do at runtime.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SOMORA_HOME = join(tmpdir(), '.somora-mcp-smoke');
const REPO_ROOT = '/home/suspect/Projects/naxon/somora';

async function setup() {
  await rm(SOMORA_HOME, { recursive: true, force: true });
  const dir = join(SOMORA_HOME, 'agents', 'hans');
  await mkdir(join(dir, 'memory'), { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), '---\nname: hans\n---\n\nTest', 'utf8');
  await writeFile(join(dir, 'agent.yaml'), 'model: opus\n', 'utf8');
  await writeFile(
    join(dir, 'memory', 'auto.md'),
    `---\ndescription: Renes Auto\n---\n\nRene fährt einen Fiat 500.\n`,
    'utf8',
  );
  await writeFile(
    join(SOMORA_HOME, 'config.yaml'),
    `server:
  port: 18737
providers:
  anthropic:
    engine: claude-cli
    models:
      - id: claude-opus-4-7
        alias: opus
        contextWindow: 1000000
        capabilities: [text]
`,
    'utf8',
  );
}

async function run() {
  await setup();

  const transport = new StdioClientTransport({
    command: join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    args: [join(REPO_ROOT, 'src', 'mcp', 'server.ts')],
    env: {
      ...filterEnv(process.env),
      SOMORA_HOME,
      SOMORA_AGENT: 'hans',
    },
  });

  const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('✅ connected to MCP server');

  const list = await client.listTools();
  console.log('\ntools listed:', list.tools.map((t: any) => t.name).join(', '));

  // memory_search
  const searchRes = await client.callTool({
    name: 'memory_search',
    arguments: { query: 'italienisches Auto', minScore: 0 },
  }) as any;
  const searchData = JSON.parse(searchRes.content[0].text);
  console.log('\nmemory_search →', searchData.count, 'hits, top reference:', searchData.hits[0]?.reference);

  // memory_write
  const writeRes = await client.callTool({
    name: 'memory_write',
    arguments: {
      slug: 'flugschule',
      content: 'Rene macht den Privatpilotenschein in Linz.',
      frontmatter: { description: 'Flugschule', tags: ['pilot'] },
    },
  }) as any;
  console.log('\nmemory_write →', JSON.parse(writeRes.content[0].text));

  // Watcher debounce (1500ms) + write-stability (250ms) before flugschule
  // is in the index. Wait long enough that subsequent reads see the new note.
  await new Promise((r) => setTimeout(r, 2500));

  // memory_list
  const listRes = await client.callTool({ name: 'memory_list', arguments: {} }) as any;
  const listData = JSON.parse(listRes.content[0].text);
  console.log('\nmemory_list →', listData.count, 'notes:', listData.notes.map((n: any) => n.slug).join(', '));

  // memory_get via reference
  const getRes = await client.callTool({
    name: 'memory_get',
    arguments: { reference: 'memory/flugschule' },
  }) as any;
  if (getRes.isError) {
    console.log('\nmemory_get FAILED:', getRes.content[0].text);
  } else {
    console.log('\nmemory_get →', JSON.parse(getRes.content[0].text).source);
  }

  // memory_write with bad slug
  const badRes = await client.callTool({
    name: 'memory_write',
    arguments: { slug: 'Foo Bar', content: 'x' },
  }) as any;
  console.log('\nmemory_write bad-slug isError:', badRes.isError, '— text:', badRes.content[0].text.slice(0, 100));

  await client.close();
  console.log('\n✅ smoke ok');
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

run().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
