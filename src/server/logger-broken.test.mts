// When the log worker dies (full disk), later log lines must not turn
// into uncaught exceptions: that looped endlessly at ~80 % CPU on
// 2026-11-10. Runs in a child process because the worker is killed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const loggerUrl = new URL('./logger.ts', import.meta.url).href;

test('a dead log worker sends lines to stderr once noticed, without uncaught exceptions', () => {
  const home = mkdtempSync(join(tmpdir(), 'somora-logger-broken-'));
  const script = `
    import pino from 'pino';
    const { logger, fileLogStopped } = await import(${JSON.stringify(loggerUrl)});
    let uncaught = 0;
    process.on('uncaughtException', () => { uncaught++; });
    const stream = logger[pino.symbols.streamSym];
    await new Promise((r) => (stream.ready ? r() : stream.once('ready', r)));
    await stream.worker.terminate();
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 20; i++) logger.info({ msg: 'after.death', i });
    await new Promise((r) => setTimeout(r, 300));
    console.log(JSON.stringify({ uncaught, stopped: fileLogStopped() }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, SOMORA_HOME: home, SOMORA_LOG_TTY: '0', SOMORA_LOG_LEVEL: 'info', NODE_TEST_CONTEXT: '' },
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    timeout: 30_000,
  });
  rmSync(home, { recursive: true, force: true });
  const last = r.stdout.trim().split('\n').pop() ?? '';
  const out = JSON.parse(last);
  assert.equal(out.uncaught, 0, r.stderr);
  assert.equal(out.stopped, true);
  assert.equal((r.stderr.match(/server log stopped/g) ?? []).length, 1, r.stderr);
  assert.ok(r.stderr.includes('"msg":"after.death"'), r.stderr);
});
