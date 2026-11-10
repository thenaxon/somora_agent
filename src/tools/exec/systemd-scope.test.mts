// Background jobs and agent tmux servers get their own systemd scope
// only under a systemd service (Fable review 2026-11-10 Nr. 7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeArgv, scopeUnitName, setScopesAvailableForTest } from './systemd-scope.ts';

test('unit names are what systemd accepts and never clash', () => {
  const a = scopeUnitName('tmux', 'my session/../x');
  assert.match(a, /^somora-tmux-[A-Za-z0-9_-]+\.scope$/);
  assert.notEqual(a, scopeUnitName('tmux', 'my session/../x'));
});

test('no scope prefix without systemd, the full prefix with it', () => {
  setScopesAvailableForTest(false);
  assert.deepEqual(scopeArgv('u.scope'), []);
  setScopesAvailableForTest(true);
  assert.deepEqual(scopeArgv('u.scope'), ['systemd-run', '--user', '--scope', '--quiet', '--collect', '--unit=u.scope', '--']);
  setScopesAvailableForTest(undefined);
});
