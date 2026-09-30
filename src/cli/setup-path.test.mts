import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addToShellPath } from './setup.ts';

function home(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'somora-setup-test-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
  return dir;
}

test('already on PATH: nothing is touched', () => {
  const h = home({ '.bashrc': '# mine\n' });
  assert.deepEqual(addToShellPath(`${h}/.local/bin`, h, `/usr/bin:${h}/.local/bin`, '/bin/bash'), []);
  assert.equal(readFileSync(join(h, '.bashrc'), 'utf8'), '# mine\n');
  assert.equal(existsSync(join(h, '.profile')), false);
});

test('missing: one line in .profile and the existing shell files, written with $HOME', () => {
  const h = home({ '.bashrc': '# mine' });
  const changed = addToShellPath(`${h}/.local/bin`, h, '/usr/bin', '/bin/bash');
  assert.deepEqual(changed, [join(h, '.profile'), join(h, '.bashrc')]);
  assert.equal(readFileSync(join(h, '.bashrc'), 'utf8'), '# mine\n\nexport PATH="$HOME/.local/bin:$PATH"  # added by somora setup\n');
  assert.equal(existsSync(join(h, '.zshrc')), false, 'no zsh file for a bash user');
});

test('zsh user gets .zshrc; a second run adds nothing', () => {
  const h = home({});
  assert.deepEqual(addToShellPath(`${h}/.local/bin`, h, '/usr/bin', '/bin/zsh'), [join(h, '.profile'), join(h, '.zshrc')]);
  assert.deepEqual(addToShellPath(`${h}/.local/bin`, h, '/usr/bin', '/bin/zsh'), []);
});

test('a file that already mentions the folder is left alone', () => {
  const h = home({ '.profile': 'PATH="$HOME/.local/bin:$PATH"\n' });
  assert.deepEqual(addToShellPath(`${h}/.local/bin`, h, '/usr/bin', '/bin/bash'), []);
});
