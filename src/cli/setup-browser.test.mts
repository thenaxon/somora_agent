// The setup assistant's browser step: which install command it offers.
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromiumInstallCommand } from './setup.ts';

const has = (...cmds: string[]) => (c: string) => cmds.includes(c);

test('Debian gets apt, Fedora dnf, Arch pacman', () => {
  assert.deepEqual(chromiumInstallCommand('linux', 'ID=debian\n', has('apt-get')), ['sudo', 'apt-get', 'install', '-y', 'chromium']);
  assert.deepEqual(chromiumInstallCommand('linux', 'ID=fedora\n', has('dnf')), ['sudo', 'dnf', 'install', '-y', 'chromium']);
  assert.deepEqual(chromiumInstallCommand('linux', 'ID=arch\n', has('pacman')), ['sudo', 'pacman', '-S', '--needed', '--noconfirm', 'chromium']);
});

test('Ubuntu gets no command: its Chromium is a snap', () => {
  assert.equal(chromiumInstallCommand('linux', 'NAME="Ubuntu"\nID=ubuntu\n', has('apt-get')), null);
  assert.equal(chromiumInstallCommand('linux', 'ID="ubuntu"\n', has('apt-get')), null);
});

test('macOS with Homebrew gets Chrome, without it nothing', () => {
  assert.deepEqual(chromiumInstallCommand('darwin', '', has('brew')), ['brew', 'install', '--cask', 'google-chrome']);
  assert.equal(chromiumInstallCommand('darwin', '', has()), null);
  assert.equal(chromiumInstallCommand('linux', 'ID=alpine\n', has()), null);
});

test('Xvfb comes from the system package manager, only on Linux', async () => {
  const { xvfbInstallCommand } = await import('./setup.ts');
  assert.deepEqual(xvfbInstallCommand('linux', has('apt-get')), ['sudo', 'apt-get', 'install', '-y', 'xvfb']);
  assert.deepEqual(xvfbInstallCommand('linux', has('dnf')), ['sudo', 'dnf', 'install', '-y', 'xorg-x11-server-Xvfb']);
  assert.deepEqual(xvfbInstallCommand('linux', has('pacman')), ['sudo', 'pacman', '-S', '--needed', '--noconfirm', 'xorg-server-xvfb']);
  assert.equal(xvfbInstallCommand('darwin', has('brew')), null);
});
