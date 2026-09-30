import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

const made: string[] = [];
process.on('exit', () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
import { join } from 'node:path';

import { BASE_CONFIG, commit, configuredAliases, getIn, openYaml, render, setIn, upsertProvider } from './config-edit.ts';
import { CLAUDE_PRESET, CODEX_PRESET } from './presets.ts';

function tmpFile(name: string, text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'somora-setup-test-'));
  made.push(dir);
  const p = join(dir, name);
  if (text !== undefined) writeFileSync(p, text);
  return p;
}

test('a fresh config gets providers in block style and loads', () => {
  const p = tmpFile('config.yaml');
  const f = openYaml(p, BASE_CONFIG);
  const added = upsertProvider(f, { ...CLAUDE_PRESET, models: CLAUDE_PRESET.models.slice(0, 2) });
  assert.deepEqual(added, ['fable', 'opus']);
  const r = commit(f, 'config');
  assert.equal(r.changed, true);
  assert.equal(r.backup, null);
  const text = readFileSync(p, 'utf8');
  assert.match(text, /providers:\n  anthropic:\n    engine: claude-cli\n    models:\n      - id: claude-fable-5-1\n        alias: fable/);
  assert.match(text, /capabilities: \[ ?text, image, pdf, reasoning ?\]/);
  assert.match(text, /^# somora server config/);
});

test('an existing config keeps its comments, its models and an odd indentation', () => {
  const original = `# my notes
  server:
    port: 18737   # keep me
  providers:
    # the big one
    anthropic:
      engine: claude-cli
      models:
        - id: claude-opus-5
          alias: grosser          # my own nickname
          contextWindow: 1000000
          capabilities: [text, image]
`;
  const p = tmpFile('config.yaml', original);
  const f = openYaml(p);
  const added = upsertProvider(f, CLAUDE_PRESET);
  assert.deepEqual(added, ['fable', 'sonnet', 'haiku'], 'the model already there is not added again');
  upsertProvider(f, { ...CODEX_PRESET, models: [CODEX_PRESET.models[0]!] });
  setIn(f, ['wiki', 'enabled'], true);
  setIn(f, ['server', 'host'], '0.0.0.0');
  const r = commit(f, 'config', new Date('2026-09-30T10:11:12Z'));
  assert.ok(r.backup?.endsWith('config.yaml.bak-setup-20260930-101112'));
  assert.equal(readFileSync(r.backup!, 'utf8'), original);
  const text = readFileSync(p, 'utf8');
  for (const keep of ['# my notes', '# keep me', '# the big one', '# my own nickname', 'alias: grosser']) {
    assert.ok(text.includes(keep), `lost: ${keep}\n${text}`);
  }
  assert.deepEqual(configuredAliases(f).map((a) => a.alias), ['grosser', 'fable', 'sonnet', 'haiku', 'astra']);
  assert.equal(getIn(f, ['server', 'host']), '0.0.0.0');
  assert.match(text, /\n\n *wiki:\n/, 'a new section gets a blank line above it');
  assert.match(text, /levels: \{ ?off: low, high: xhigh ?\}/);
});

test('a result the server would refuse is not written', () => {
  const original = `server:\n  port: 18737\nproviders:\n  a:\n    engine: claude-cli\n    models:\n      - id: claude-opus-5\n        alias: opus\n        contextWindow: 1000000\n        capabilities: [text]\n`;
  const p = tmpFile('config.yaml', original);
  const f = openYaml(p);
  // same alias under a second provider → assertUniqueAliases refuses
  upsertProvider(f, { key: 'b', engine: 'claude-cli', models: [CLAUDE_PRESET.models[1]!] });
  assert.throws(() => commit(f, 'config'), /would not load/);
  assert.equal(readFileSync(p, 'utf8'), original);
  assert.deepEqual(readdirSync(join(p, '..')), ['config.yaml'], 'no backup, no temp file left behind');
});

test('no change, no write, no backup', () => {
  const p = tmpFile('agent.yaml', 'model: opus\n# fallback: sonnet\n');
  const f = openYaml(p);
  assert.deepEqual(commit(f, 'plain'), { changed: false, backup: null });
});

test('agent.yaml: rem block is added below the existing keys, comments stay', () => {
  const p = tmpFile('agent.yaml', '# operator config\nmodel: opus\n# thinking: medium\n');
  const f = openYaml(p);
  setIn(f, ['rem'], { enabled: true, model: 'haiku', idleMinutes: 30 });
  setIn(f, ['fallback'], ['sonnet']);
  assert.equal(commit(f, 'plain').changed, true);
  const text = render(f);
  assert.ok(text.startsWith('# operator config\nmodel: opus\n'));
  assert.match(text, /rem:\n  enabled: true\n  model: haiku\n  idleMinutes: 30/);
  assert.equal(getIn(f, ['rem', 'enabled']), true, 'a value set as an object is readable key by key');
});
