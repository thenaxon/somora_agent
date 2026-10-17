// The dreams switch in agent.yaml: deriving it from the old keys, the
// one-time rewrite at start (comments kept, backup, nothing twice,
// unusual layouts left alone), the Agent window's write, and the
// config-check note for old keys written by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { deriveDreams, loadPersona } from './loader.ts';
import { migrateDreamsSwitch, rewriteForDreams } from './dreams-migrate.ts';
import { setDreamsInText } from './dreams-store.ts';
import { oldDreamKeyNotes } from '../cli/config.ts';
import { parseYaml } from '../config/yaml.ts';

const home = process.env.SOMORA_HOME!;
function agent(name: string, yaml: string | null) {
  mkdirSync(join(home, 'agents', name), { recursive: true });
  writeFileSync(join(home, 'agents', name, 'AGENTS.md'), `# ${name}\n`);
  if (yaml !== null) writeFileSync(join(home, 'agents', name, 'agent.yaml'), yaml);
}
const read = (name: string) => readFileSync(join(home, 'agents', name, 'agent.yaml'), 'utf8');

test('deriveDreams: written switch, then rem.enabled, then builder, then dream tools off, else on', () => {
  assert.deepEqual(deriveDreams({ dreams: false, rem: { enabled: true } }), { dreams: false, source: 'dreams' });
  assert.deepEqual(deriveDreams({ rem: { enabled: false } }), { dreams: false, source: 'rem.enabled' });
  assert.deepEqual(deriveDreams({ kind: 'builder', rem: { enabled: true } }), { dreams: true, source: 'rem.enabled' });
  assert.deepEqual(deriveDreams({ kind: 'builder' }), { dreams: false, source: 'builder' });
  assert.deepEqual(deriveDreams({ tools: { deny: ['toolset:dream'] } }), { dreams: false, source: 'dream-tools-off' });
  assert.deepEqual(deriveDreams({}), { dreams: true, source: 'default' });
});

test('rewrite: rem.enabled becomes dreams, comments and the rest of the block stay', () => {
  const before = [
    '# operator notes',
    'model: opus   # main',
    'rem:',
    '  enabled: true',
    '  model: deep4flash        # worker',
    '  fallback: [glm, qwen]',
    '  idleMinutes: 30',
    '',
    '# tools below',
    'tools:',
    '  deny: [web_search]',
    '',
  ].join('\n');
  const r = rewriteForDreams(before)!;
  assert.equal(r.dreams, true);
  assert.equal(r.source, 'rem.enabled');
  assert.equal(r.text, [
    '# operator notes',
    'model: opus   # main',
    'dreams: true',
    'rem:',
    '  model: deep4flash        # worker',
    '  fallback: [glm, qwen]',
    '  idleMinutes: 30',
    '',
    '# tools below',
    'tools:',
    '  deny: [web_search]',
    '',
  ].join('\n'));
});

test('rewrite: a rem block left empty goes; participate_in_wiki goes too', () => {
  const r = rewriteForDreams('model: x\nrem:\n  enabled: false\n  participate_in_wiki: false\nthinking: low\n')!;
  assert.equal(r.text, 'model: x\ndreams: false\nthinking: low\n');
});

test('rewrite: no rem block — a builder gets false after kind, a chat agent true after model', () => {
  assert.equal(rewriteForDreams('kind: builder\nmodel: x\n')!.text, 'kind: builder\ndreams: false\nmodel: x\n');
  assert.equal(rewriteForDreams('model: x\nthinking: low\n')!.text, 'model: x\ndreams: true\nthinking: low\n');
  assert.equal(rewriteForDreams('model: x\ntools:\n  deny: ["toolset:dream"]\n')!.text, 'model: x\ndreams: false\ntools:\n  deny: ["toolset:dream"]\n');
  assert.equal(rewriteForDreams('# nothing set\n')!.text, '# nothing set\ndreams: true\n');
});

test('rewrite: a file with dreams is left alone; an unusual layout throws instead of guessing', () => {
  assert.equal(rewriteForDreams('model: x\ndreams: false\nrem:\n  enabled: true\n'), null);
  assert.throws(() => rewriteForDreams('model: x\nrem: {enabled: true, model: y}\n'), /left as it is/);
});

test('rewrite: CRLF files stay CRLF', () => {
  const r = rewriteForDreams('model: x\r\nrem:\r\n  enabled: true\r\n  model: y\r\n')!;
  assert.equal(r.text, 'model: x\r\ndreams: true\r\nrem:\r\n  model: y\r\n');
});

test('start-up migration: rewrites, keeps a backup and the mode, does nothing the second time', async () => {
  agent('m-on', 'model: x\nrem:\n  enabled: true\n  model: y\n');
  agent('m-off', 'model: x\nrem:\n  enabled: false\n  model: y\n');
  agent('m-builder', 'kind: builder\nmodel: x\n');
  agent('m-done', 'model: x\ndreams: true\n');
  agent('m-odd', 'model: x\nrem: {enabled: false, model: y}\n');
  agent('m-none', null);
  chmodSync(join(home, 'agents', 'm-on', 'agent.yaml'), 0o640);

  const first = await migrateDreamsSwitch(home);
  const by = Object.fromEntries(first.map((m) => [m.agent, m]));
  assert.equal(by['m-on']!.dreams, true);
  assert.equal(by['m-off']!.dreams, false);
  assert.equal(by['m-builder']!.dreams, false);
  assert.equal(by['m-done'], undefined, 'already switched: untouched');
  assert.equal(by['m-none'], undefined, 'no agent.yaml: nothing to rewrite');
  assert.match(by['m-odd']!.error ?? '', /left as it is/);
  assert.equal(by['m-odd']!.dreams, false, 'still reported with the value the loader derives');

  assert.equal(read('m-on'), 'model: x\ndreams: true\nrem:\n  model: y\n');
  assert.equal(read('m-odd'), 'model: x\nrem: {enabled: false, model: y}\n', 'left as it was');
  assert.equal(statSync(join(home, 'agents', 'm-on', 'agent.yaml')).mode & 0o777, 0o640);
  const backups = readdirSync(join(home, 'agents', 'm-on')).filter((f) => f.includes('.bak-') && f.endsWith('-dreams'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, 'agents', 'm-on', backups[0]!), 'utf8'), 'model: x\nrem:\n  enabled: true\n  model: y\n');

  const second = await migrateDreamsSwitch(home);
  assert.deepEqual(second.filter((m) => !m.error).map((m) => m.agent), [], 'a second start changes nothing');

  // The loader agrees with what was written, and with the file it could not touch.
  assert.equal((await loadPersona('m-on'))!.dreams, true);
  assert.equal((await loadPersona('m-off'))!.dreams, false);
  assert.equal((await loadPersona('m-odd'))!.dreams, false);
  assert.equal((await loadPersona('m-builder'))!.dreams, false);
  assert.equal((await loadPersona('m-none'))!.dreams, true, 'a new agent dreams');
});

test('a rem block without enabled or model still parses (the agent keeps its settings)', async () => {
  agent('m-rest', 'model: opus\ndreams: true\nrem:\n  idleMinutes: 5\n');
  const p = (await loadPersona('m-rest'))!;
  assert.equal(p.model, 'opus', 'the file was not thrown away as invalid');
  assert.equal(p.rem?.idleMinutes, 5);
});

test('the Agent window write: flips an existing switch, or migrates and sets', () => {
  assert.equal(setDreamsInText('model: x\ndreams: true   # note\n', false), 'model: x\ndreams: false   # note\n', 'the comment stays');
  assert.equal(setDreamsInText('model: x\nrem:\n  enabled: false\n  model: y\n', true), 'model: x\ndreams: true\nrem:\n  model: y\n');
  assert.equal(setDreamsInText('', false), 'dreams: false\n');
  const odd = setDreamsInText('rem: {enabled: false, model: y}', true);
  assert.equal((parseYaml(odd) as { dreams: boolean }).dreams, true, 'an unusual layout still gets a switch that wins');
});

test('the Agent window write: a hand-written quoted key is set in place, a broken file is refused', () => {
  // `"dreams": true` once got a second `dreams:` line appended: a
  // duplicate key, and agent.yaml then loaded as no settings at all.
  const quoted = setDreamsInText('model: x\n"dreams": true   # by hand\n', false);
  assert.equal(quoted, 'model: x\n"dreams": false   # by hand\n');
  assert.equal((parseYaml(quoted) as { model: string }).model, 'x');
  assert.throws(() => setDreamsInText('model: [x\n', true), /not valid YAML/);
});

test('config check names agent.yaml files with old keys', () => {
  agent('m-hand', 'model: x\nrem:\n  enabled: true\n  model: y\n');
  const notes = oldDreamKeyNotes(join(home, 'agents'));
  assert.ok(notes.some((n) => n.includes('agents/m-hand/agent.yaml') && n.includes('rem.enabled')));
  assert.ok(!notes.some((n) => n.includes('m-on/')), 'a migrated file is not named');
  assert.ok(existsSync(join(home, 'agents')));
});
