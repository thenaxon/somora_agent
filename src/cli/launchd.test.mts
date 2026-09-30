import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLaunchdPlist, launchdPathDirs, launchdPlistPath, nodeDirOnPath } from './launchd.ts';

test('plist: program, PATH, keep-alive on failure, log file', () => {
  const p = buildLaunchdPlist({
    binPath: '/opt/homebrew/lib/node_modules/somora/bin/somora.mjs',
    pathDirs: ['/opt/homebrew/bin', '/usr/bin'],
    home: '/Users/u',
    logPath: '/Users/u/.somora/logs/launchd.log',
  });
  assert.match(p, /<key>Label<\/key>\s*<string>ai\.somora\.server<\/string>/);
  assert.match(p, /<string>\/opt\/homebrew\/lib\/node_modules\/somora\/bin\/somora\.mjs<\/string>\s*<string>server<\/string>\s*<string>start<\/string>\s*<string>--foreground<\/string>/);
  assert.match(p, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(p, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/u\/\.somora\/logs\/launchd\.log<\/string>/);
});

test('plist: special characters in paths are escaped', () => {
  const p = buildLaunchdPlist({ binPath: '/Users/a&b/<x>/somora.mjs', pathDirs: ['/usr/bin'], home: '/Users/a&b', logPath: '/l' });
  assert.ok(p.includes('<string>/Users/a&amp;b/&lt;x&gt;/somora.mjs</string>'));
});

test('node directory: the one on PATH, not the versioned real path', () => {
  const dir = nodeDirOnPath('/nope:/opt/homebrew/bin:/usr/bin', (p) => p === '/opt/homebrew/bin/node' || p === '/usr/bin/node');
  assert.equal(dir, '/opt/homebrew/bin');
});

test('PATH for the service: node first, no duplicates', () => {
  assert.deepEqual(launchdPathDirs('/opt/homebrew/bin', '/opt/homebrew/bin', '/Users/u'), ['/opt/homebrew/bin', '/Users/u/.local/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  assert.equal(launchdPathDirs('/Users/u/.local/share/somora/node/bin', '/Users/u/.npm-global/bin', '/Users/u')[1], '/Users/u/.npm-global/bin');
});

test('plist location', () => {
  assert.equal(launchdPlistPath('/Users/u'), '/Users/u/Library/LaunchAgents/ai.somora.server.plist');
});
