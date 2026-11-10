// somora's Grok home keeps xAI account connectors (tasks) out of agents,
// also in a Grok home written before that rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGatewayBlock } from './grok-home.ts';

const dir = mkdtempSync(join(tmpdir(), 'grok-home-'));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

const OLD = `# Written by somora — Grok as an engine for somora agents.
[cli]
auto_update = false
use_leader = false

[marketplace]
default_skills_installs_purged = true

[[marketplace.sources]]
name = "xAI Official"
git = "https://github.com/xai-org/plugin-marketplace.git"
`;

test('a Grok home from before gets the table at the end, the rest stays byte for byte', () => {
  const p = file('old.toml', OLD);
  assert.equal(ensureGatewayBlock(p), 'added');
  const text = readFileSync(p, 'utf8');
  assert.ok(text.startsWith(OLD), 'nothing before it changed');
  assert.match(text, /\n\[disabled_mcp_tools\]\n__managed_gateway_connectors = \["tasks","cursor"\]\n$/);
  assert.equal(ensureGatewayBlock(p), 'present', 'a second run changes nothing');
  assert.equal(readFileSync(p, 'utf8'), text);
});

test('an existing table without the key gets the key, other keys stay', () => {
  const p = file('table.toml', `[disabled_mcp_tools]\nlinear = ["delete_issue"]\n\n[cli]\nauto_update = false\n`);
  assert.equal(ensureGatewayBlock(p), 'key-added');
  assert.equal(
    readFileSync(p, 'utf8'),
    `[disabled_mcp_tools]\n__managed_gateway_connectors = ["tasks","cursor"]\nlinear = ["delete_issue"]\n\n[cli]\nauto_update = false\n`,
  );
});

test('a key with other names keeps them and gets the missing ones', () => {
  const p = file('own.toml', `[disabled_mcp_tools]\n__managed_gateway_connectors = ["gmail"]\n`);
  assert.equal(ensureGatewayBlock(p), 'merged');
  assert.equal(readFileSync(p, 'utf8'), `[disabled_mcp_tools]\n__managed_gateway_connectors = ["gmail","tasks","cursor"]\n`);
});

test('a Grok home of the last release (tasks only) gets cursor; a connector found at run time is added', () => {
  const p = file('release.toml', `[cli]\nuse_leader = false\n\n[disabled_mcp_tools]\n__managed_gateway_connectors = ["tasks"]\n`);
  assert.equal(ensureGatewayBlock(p), 'merged');
  assert.match(readFileSync(p, 'utf8'), /__managed_gateway_connectors = \["tasks","cursor"\]/);
  assert.equal(ensureGatewayBlock(p, ['linear-gw']), 'merged');
  assert.match(readFileSync(p, 'utf8'), /__managed_gateway_connectors = \["tasks","cursor","linear-gw"\]/);
  assert.equal(ensureGatewayBlock(p, ['linear-gw']), 'present');
});

test('a list over several lines or in single quotes is merged whole, the file stays valid TOML', () => {
  const p = file('multi.toml', `[disabled_mcp_tools]\n__managed_gateway_connectors = [\n  'gmail',\n  "tasks",\n]\nlinear = ["delete_issue"]\n`);
  assert.equal(ensureGatewayBlock(p), 'merged');
  assert.equal(readFileSync(p, 'utf8'), `[disabled_mcp_tools]\n__managed_gateway_connectors = ["gmail","tasks","cursor"]\nlinear = ["delete_issue"]\n`);
});

test('a value it cannot read is left alone, not broken', () => {
  const body = `[disabled_mcp_tools]\n__managed_gateway_connectors = [\n  "gmail",\n[cli]\nuse_leader = false\n`;
  const p = file('broken.toml', body);
  assert.equal(ensureGatewayBlock(p), 'left');
  assert.equal(readFileSync(p, 'utf8'), body);
});
