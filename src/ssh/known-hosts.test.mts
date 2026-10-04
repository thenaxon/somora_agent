// The "host key changed" message tells a person to remove the entry and
// reconnect. That has to work without a server restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = join(tmpdir(), `somora-known-hosts-${process.pid}`);
mkdirSync(home, { recursive: true });
process.env.SOMORA_HOME = home;
const file = join(home, 'known_hosts.json');
const { verifyHostKey, fingerprint } = await import('./known-hosts.ts');

const keyA = Buffer.from('host-key-a');
const keyB = Buffer.from('host-key-b');
const stored = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
/** A hand edit a moment later — mtime resolution is not the point here. */
const edit = (content: Record<string, string>, secondsAhead: number) => {
  writeFileSync(file, JSON.stringify(content));
  const t = new Date(Date.now() + secondsAhead * 1000);
  utimesSync(file, t, t);
};

test('first connection pins the key; the same key matches; another is refused', () => {
  assert.equal(verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyA }).ok, true);
  assert.equal(stored().nova, fingerprint(keyA));
  assert.equal(verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyA }).ok, true);
  const changed = verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyB });
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /remove the entry from .*known_hosts\.json and reconnect/);
});

test('removing the entry by hand counts on the next connection, without a restart', () => {
  edit({}, 5);
  const again = verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyB });
  assert.equal(again.ok, true, again.reason);
  assert.equal(stored().nova, fingerprint(keyB));
  assert.equal(verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyA }).ok, false, 'the old key is now the stranger');
});

test('an entry another resource got by hand is honoured, and own pins survive the re-read', () => {
  edit({ ...stored(), 'gpu-box': fingerprint(keyA) }, 10);
  assert.equal(verifyHostKey({ resourceName: 'gpu-box', hostKeyBuf: keyA }).ok, true);
  assert.equal(verifyHostKey({ resourceName: 'gpu-box', hostKeyBuf: keyB }).ok, false);
  assert.equal(verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyB }).ok, true);
});

test('a file that became unreadable is treated as empty, not as a crash', () => {
  writeFileSync(file, '{broken');
  const t = new Date(Date.now() + 20_000);
  utimesSync(file, t, t);
  assert.equal(verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyA }).ok, true);
});

test('a config-pinned hostKey decides alone', () => {
  assert.equal(verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyB, expected: fingerprint(keyB) }).ok, true);
  assert.equal(verifyHostKey({ resourceName: 'nova', hostKeyBuf: keyB, expected: fingerprint(keyA) }).ok, false);
});
