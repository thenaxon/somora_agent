// The grok-cli adapter's pieces that decide safety and separation:
// which tools Grok may use, where the prompt goes, how a missing binary
// reads, and that somora's Grok home keeps the login in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentProfile, describeSpawnFailure, GROK_TOOL_GUIDANCE, mcpStatuses } from './grok-cli.ts';
import { grokAuthExpiry, grokChildEnv, somoraGrokHome, syncGrokHome } from './grok-home.ts';

test('the agent profile allows only the two meta-tools that reach somora', () => {
  const p = buildAgentProfile('You are ada.');
  assert.deepEqual(p.tools, ['search_tool', 'use_tool'], "Grok's own terminal, file and web tools are off");
  assert.equal(p.promptMode, 'full', "somora's prompt replaces Grok's coding template");
  assert.equal(p.agentsMd, false);
  assert.equal(p.discoverSkills, false);
  assert.ok(String(p.promptBody).startsWith('You are ada.'));
  assert.ok(String(p.promptBody).endsWith(GROK_TOOL_GUIDANCE), 'the tool naming is explained once');
  assert.match(GROK_TOOL_GUIDANCE, /somora__memory_search/);
});

test('a missing binary says what to do, without words that read as an outage', () => {
  const missing = describeSpawnFailure('/opt/grok', Object.assign(new Error('spawn /opt/grok ENOENT'), { code: 'ENOENT' }));
  assert.match(missing, /^grok binary not found \(\/opt\/grok\)\. Install the Grok Build CLI/);
  assert.doesNotMatch(missing, /timed out|timeout|connection/i, 'a local install problem must not mark the model unavailable');
  assert.match(describeSpawnFailure('/opt/grok', Object.assign(new Error('x'), { code: 'EACCES' })), /not executable/);
});

test('MCP readiness is read from the wrapped extension answer', () => {
  const wrapped = { result: { servers: [{ name: 'somora', session: { status: 'initializing' } }, { name: 'somora-web', session: { status: 'ready' } }] } };
  assert.deepEqual([...mcpStatuses(wrapped)], [['somora', 'initializing'], ['somora-web', 'ready']]);
  assert.deepEqual([...mcpStatuses({ servers: [{ name: 'somora', session: { status: 'ready' } }] })], [['somora', 'ready']]);
  assert.equal(mcpStatuses(undefined).size, 0);
});

test("somora's Grok home: own config, memory off, and the newer login wins both ways", () => {
  const root = mkdtempSync(join(tmpdir(), 'somora-grok-home-'));
  const userHome = join(root, 'user-grok');
  mkdirSync(userHome, { recursive: true });
  const saved = { GROK_HOME: process.env.GROK_HOME, SOMORA_HOME: process.env.SOMORA_HOME };
  process.env.GROK_HOME = userHome;
  process.env.SOMORA_HOME = join(root, 'somora');
  const auth = (iso: string) => JSON.stringify({ 'https://auth.x.ai::client': { key: 'k', refresh_token: 'r', expires_at: iso } });
  try {
    assert.equal(syncGrokHome().action, 'missing');
    const config = readFileSync(join(somoraGrokHome(), 'config.toml'), 'utf8');
    assert.match(config, /auto_update = false/);
    assert.match(config, /use_leader = false/);
    const env = grokChildEnv();
    assert.equal(env.GROK_HOME, somoraGrokHome());
    assert.equal(env.GROK_MEMORY, '0');

    // The person logs in: somora pulls the login.
    writeFileSync(join(userHome, 'auth.json'), auth('2026-10-08T16:00:00Z'));
    assert.equal(syncGrokHome().action, 'pulled');
    assert.equal(statSync(join(somoraGrokHome(), 'auth.json')).mode & 0o777, 0o600);
    assert.equal(syncGrokHome().action, 'noop');

    // somora's copy refreshed later: pushed back, so the person's own
    // Grok does not hold a rotated-away refresh token.
    writeFileSync(join(somoraGrokHome(), 'auth.json'), auth('2026-10-08T22:00:00Z'));
    assert.equal(syncGrokHome().action, 'pushed');
    assert.equal(grokAuthExpiry(join(userHome, 'auth.json')), Date.parse('2026-10-08T22:00:00Z'));

    // Same expiry, a newer file on the person's side (a fresh login).
    writeFileSync(join(userHome, 'auth.json'), auth('2026-10-08T22:00:00Z').replace('"k"', '"k2"'));
    const later = new Date(Date.now() + 5000);
    utimesSync(join(userHome, 'auth.json'), later, later);
    assert.equal(syncGrokHome().action, 'pulled');
    assert.match(readFileSync(join(somoraGrokHome(), 'auth.json'), 'utf8'), /"k2"/);
  } finally {
    if (saved.GROK_HOME === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = saved.GROK_HOME;
    if (saved.SOMORA_HOME === undefined) delete process.env.SOMORA_HOME; else process.env.SOMORA_HOME = saved.SOMORA_HOME;
  }
});
