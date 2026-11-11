// `--help` after a command shows help and never runs it.
import assert from 'node:assert/strict';
import { helpAction } from './help-args.ts';

// commands without their own usage: the general usage, nothing runs
for (const argv of [['init', '--help'], ['server', 'stop', '--help'], ['server', 'restart', '-h'], ['server', 'start', '--foreground', '--help'], ['tui', '--help']]) {
  assert.deepEqual(helpAction(argv[0], argv.slice(1)), { kind: 'usage' }, argv.join(' '));
}
// commands with their own usage get a bare --help, whatever came before it
for (const argv of [['lsp', 'install', 'typescript', '--help'], ['team', 'init', '-h'], ['key', 'rotate', '--help'], ['agent', 'rename', 'a', 'b', '--help'], ['update', '--help']]) {
  assert.deepEqual(helpAction(argv[0], argv.slice(1)), { kind: 'module-help', args: ['--help'] }, argv.join(' '));
}
// the bundled CLIs get their arguments as typed
for (const cmd of ['claude', 'auth', 'codex', 'grok']) {
  assert.deepEqual(helpAction(cmd, ['exec', '--help']), { kind: 'run' }, cmd);
}
// without --help everything runs
assert.deepEqual(helpAction('init', []), { kind: 'run' });
assert.deepEqual(helpAction('server', ['start', '--foreground']), { kind: 'run' });

console.log('help-args.test: ok');
