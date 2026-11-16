// Loading the rules: herdr's shipped manifests all compile, somora's
// additions are appended, a file of one's own in
// <SOMORA_HOME>/tmux-detection wins, a broken one is skipped with a
// warning and the shipped rules stay in force.
// Own SOMORA_HOME: this file writes override rules that other test files
// running at the same time must not see.
import '../../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectAgentState, detectionWarnings, explainAgentState, knownAgents, loadedManifest, overrideDir, reloadManifests, resolveAgent } from './manifests.ts';

test('every shipped manifest compiles; the agents somora drives are there', () => {
  reloadManifests();
  assert.deepEqual(detectionWarnings(), []);
  const ids = knownAgents().map((a) => a.id);
  for (const id of ['claude', 'codex', 'opencode', 'pi', 'grok', 'gemini']) assert.ok(ids.includes(id), id);
  const source = JSON.parse(readFileSync(new URL('./manifests/SOURCE.json', import.meta.url), 'utf8')) as { agents: Array<{ id: string; rules: number }> };
  assert.equal(knownAgents().filter((a) => a.source === 'bundled').length, source.agents.length);
});

test("somora's names and herdr's aliases resolve to the agent", () => {
  assert.equal(resolveAgent('claude-code'), 'claude');
  assert.equal(resolveAgent('claude'), 'claude');
  assert.equal(resolveAgent('codex'), 'codex');
  assert.equal(resolveAgent('nonsense'), null);
  assert.equal(detectAgentState('nonsense', { screen: 'x' }), null);
});

test("somora's additions are appended to herdr's rules, herdr's file untouched", () => {
  const codex = loadedManifest('codex')!;
  const ids = codex.compiled.rules.map((r) => r.rule.id);
  assert.ok(ids.includes('somora_daemon_settings_dialog'));
  const herdr = JSON.parse(readFileSync(new URL('./manifests/codex.json', import.meta.url), 'utf8')) as { rules: Array<{ id: string }> };
  assert.equal(herdr.rules.some((r) => r.id.startsWith('somora_')), false);
  const extra = JSON.parse(readFileSync(new URL('./somora-rules/codex.json', import.meta.url), 'utf8')) as { rules: unknown[] };
  assert.equal(ids.length, herdr.rules.length + extra.rules.length);
});

test('a file of one\'s own wins, can add an agent, and a broken one is skipped with a warning', () => {
  const dir = overrideDir();
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'pi.json'), JSON.stringify({ id: 'pi', version: 'mine', rules: [{ id: 'mine', state: 'blocked', contains: ['halt'] }] }));
    writeFileSync(join(dir, 'newagent.json'), JSON.stringify({ id: 'newagent', rules: [{ id: 'busy', state: 'working', contains: ['busy'] }] }));
    writeFileSync(join(dir, 'codex.json'), '{ not json');
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ id: 'opencode', rules: [{ id: 'bad', state: 'idle', regex: ['('] }] }));
    reloadManifests();
    const pi = explainAgentState('pi', { screen: 'please halt' })!;
    assert.equal(pi.state, 'blocked');
    assert.equal(pi.source, 'override');
    assert.equal(pi.version, 'mine');
    assert.equal(detectAgentState('newagent', { screen: 'busy now' })?.state, 'working');
    // Broken files: warned about, shipped rules in force.
    const w = detectionWarnings().join('\n');
    assert.match(w, /codex\.json/);
    assert.match(w, /opencode\.json.*regex/);
    assert.equal(loadedManifest('codex')?.source, 'bundled');
    assert.equal(loadedManifest('opencode')?.source, 'bundled');
    // A file whose id is not its name is refused.
    writeFileSync(join(dir, 'grok.json'), JSON.stringify({ id: 'other', rules: [{ id: 'r', state: 'idle', contains: ['x'] }] }));
    reloadManifests();
    assert.match(detectionWarnings().join('\n'), /does not match the file name/);
    assert.equal(loadedManifest('grok')?.source, 'bundled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    reloadManifests();
  }
  assert.equal(loadedManifest('pi')?.source, 'bundled');
});

test("Codex's worktree question after /new is blocked (somora rule)", () => {
  const screen = [
    '  Where should the new conversation run?',
    '',
    '› 1. Use current Git worktree',
    '  2. Create new Git worktree',
    '',
    '  enter select · esc back',
  ].join('\n');
  const d = detectAgentState('codex', { screen, title: 'demo' });
  assert.equal(d?.state, 'blocked');
  assert.equal(d?.rule?.id, 'somora_new_conversation_dialog');
});
