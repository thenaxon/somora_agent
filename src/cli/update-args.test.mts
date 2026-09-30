import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOW_SCRIPTS, allowScriptsArgs, compareVersions, parseUpdateArgs } from './update-args.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('update args: default is the release channel with reinit', () => {
  assert.deepEqual(parseUpdateArgs([]), { kind: 'opts', channel: 'release', version: undefined, reinit: true, force: false });
});

test('update args: a leading v is dropped from an explicit version', () => {
  const r = parseUpdateArgs(['v2026.930.1', '--no-reinit']);
  assert.deepEqual(r, { kind: 'opts', channel: 'release', version: '2026.930.1', reinit: false, force: false });
});

test('update args: a pre-release version is accepted', () => {
  const r = parseUpdateArgs(['2026.930.1-rc.1']);
  assert.equal(r.kind === 'opts' && r.version, '2026.930.1-rc.1');
});

test('update args: a four-part pre-npm version is refused with an explanation', () => {
  const r = parseUpdateArgs(['2026.09.29.12']);
  assert.equal(r.kind, 'error');
  assert.match(r.kind === 'error' ? r.message : '', /pre-npm version/);
});

test('update args: garbage, unknown flags, edge + version', () => {
  assert.equal(parseUpdateArgs(['latest']).kind, 'error');
  assert.equal(parseUpdateArgs(['--nope']).kind, 'error');
  assert.equal(parseUpdateArgs(['--edge', '2026.930.1']).kind, 'error');
  assert.equal(parseUpdateArgs(['--help']).kind, 'help');
});

test('compareVersions: numeric per part, not by string', () => {
  assert.ok(compareVersions('2026.1005.1', '2026.930.4') > 0);
  assert.ok(compareVersions('2026.930.10', '2026.930.9') > 0);
  assert.ok(compareVersions('2027.101.1', '2026.1231.9') > 0);
  assert.equal(compareVersions('2026.930.1', '2026.930.1'), 0);
});

test('compareVersions: a pre-release sorts below its release', () => {
  assert.ok(compareVersions('2026.930.1-rc.1', '2026.930.1') < 0);
  assert.ok(compareVersions('2026.930.2-rc.1', '2026.930.1') > 0);
});

test('allow-scripts list = every shipped dependency with an install script, and install.sh agrees', () => {
  const lock = JSON.parse(readFileSync(resolve(root, 'npm-shrinkwrap.json'), 'utf8')) as { packages: Record<string, { hasInstallScript?: boolean; dev?: boolean }> };
  const withScripts = [...new Set(Object.entries(lock.packages)
    .filter(([k, v]) => k && v.hasInstallScript && !v.dev)
    .map(([k]) => k.split('node_modules/').pop()!))].sort();
  assert.deepEqual([...ALLOW_SCRIPTS].sort(), withScripts);
  const sh = readFileSync(resolve(root, 'install.sh'), 'utf8').match(/^ALLOW_SCRIPTS="([^"]+)"/m)?.[1];
  assert.equal(sh, ALLOW_SCRIPTS.join(','));
});

test('the flag is only passed to an npm that knows it', () => {
  assert.deepEqual(allowScriptsArgs('undefined\n'), []);
  assert.equal(allowScriptsArgs('\n')[0], `--allow-scripts=${ALLOW_SCRIPTS.join(',')}`);
  assert.equal(allowScriptsArgs('node-pty\n').length, 1);
});
