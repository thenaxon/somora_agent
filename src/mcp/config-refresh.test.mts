// The tool child of a claude-cli / codex-cli / grok-cli turn reads
// config.yaml again when it changed, so a change made during the turn
// reaches the next tool call (2026-11-14 report: the decision model's
// `image` capability was removed and the config reloaded, and
// decision_evaluate in the same turn still sent the image).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = process.env.SOMORA_HOME!;
const agent = 'cfg-refresh';
mkdirSync(join(home, 'agents', agent), { recursive: true });
writeFileSync(join(home, 'agents', agent, 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', agent, 'AGENTS.md'), `# ${agent}\n`);

const configPath = join(home, 'config.yaml');
function writeConfig(capabilities: string, mtimeSec: number): void {
  writeFileSync(
    configPath,
    'providers:\n  p:\n    engine: openai-compatible\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: sk-test-ABCDEFGHIJKLMNOP\n    models:\n      - id: x\n        contextWindow: 1000\n' +
      `decisions:\n  model: clef\n  models:\n    - name: clef\n      baseUrl: http://127.0.0.1:1\n      model: clef\n      capabilities: ${capabilities}\n`,
  );
  // Distinct mtimes: the child re-reads the file when its mtime moved.
  utimesSync(configPath, mtimeSec, mtimeSec);
}

test('a config change during the turn reaches the next tool call in the child', async () => {
  const now = Math.floor(Date.now() / 1000);
  writeConfig('[text, image]', now - 100);
  // Not an image: refused before anything is sent, so no server needed.
  const notImage = join(mkdtempSync(join(tmpdir(), 'somora-cfgref-')), 'notes.txt');
  writeFileSync(notImage, 'hello');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', resolve('src/mcp/server.ts')],
    env: { ...(process.env as Record<string, string>), SOMORA_AGENT: agent, SOMORA_SESSION: 'main' },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  const call = async () => {
    const r = await client.callTool({
      name: 'decision_evaluate',
      arguments: { state: 's', questions: { q: { type: 'boolean', instructions: 'red?' } }, images: [notImage] },
    });
    const text = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? '').join('');
    return JSON.parse(text) as { status: string; reason?: string };
  };
  try {
    const before = await call();
    assert.equal(before.reason, 'unsupported-input', 'the model reads images: the file itself is refused');
    writeConfig('[text]', now);
    const after = await call();
    assert.equal(after.reason, 'images-unsupported', 'the removed image capability applies to the next call');
  } finally {
    await client.close();
  }
});
