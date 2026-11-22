import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Mock the process boundary: never contact the developer's running Herdr.
test('Herdr display follows the Somora agent without changing lifecycle identity', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    HERDR_ENV: '1', HERDR_BIN_PATH: '/fake/herdr', HERDR_PANE_ID: 'test-pane', HERDR_SOCKET_PATH: '/fake/socket',
  });
  const calls: string[][] = [];
  t.mock.method(childProcess, 'execFile', (_bin: string, args: string[], _options: unknown, callback: (err: Error | null) => void) => {
    calls.push(args);
    // Metadata failure must remain best-effort and must not prevent release.
    queueMicrotask(() => callback(args.includes('--clear-display-agent') ? new Error('unavailable') : null));
  });
  syncBuiltinESMExports();
  t.after(() => {
    process.env = savedEnv;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { reportHerdr, releaseHerdr } = await import('./herdr.ts');
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const expectedDisplay = (name: string) => [
    'pane', 'report-metadata', 'test-pane', '--source', 'somora-tui', '--agent', 'somora',
    '--applies-to-source', 'somora-tui', '--display-agent', `${name} · Somora`,
  ];

  reportHerdr('somi', 'main', 'idle', 'somi:main');
  await settle();
  assert.deepEqual(calls[1], expectedDisplay('somi'));
  const firstReport = calls[0];
  assert.ok(firstReport);
  assert.deepEqual(firstReport.slice(0, 9), [
    'pane', 'report-agent', 'test-pane', '--source', 'somora-tui', '--agent', 'somora', '--state', 'idle',
  ]);
  assert.ok(firstReport.includes('["somi","main"]'));
  reportHerdr('somi', 'main', 'idle', 'somi:main');
  await settle();
  assert.equal(calls.length, 2, 'identical reports are deduplicated');

  reportHerdr('ada', 'other', 'blocked', 'ada:other');
  await settle();
  assert.deepEqual(calls[3], expectedDisplay('ada'));
  t.mock.timers.tick(30_000);
  await settle();
  assert.deepEqual(calls.splice(4), [calls[2], expectedDisplay('ada')], 'idle refresh restores display after handoff');

  // Release waits for in-flight display writes before clearing them.
  reportHerdr('somi', 'main', 'working', 'somi:main');
  await releaseHerdr();
  assert.deepEqual(calls[5], expectedDisplay('somi'));
  assert.deepEqual(calls[6], [
    'pane', 'report-metadata', 'test-pane', '--source', 'somora-tui', '--agent', 'somora',
    '--applies-to-source', 'somora-tui', '--clear-display-agent',
  ]);
  assert.deepEqual(calls[7], ['pane', 'release-agent', 'test-pane', '--source', 'somora-tui', '--agent', 'somora']);
  reportHerdr('ignored', 'main', 'idle', 'ignored');
  await releaseHerdr();
  assert.equal(calls.length, 8);
});
