// A codex app-server that never answers `initialize` is ended, not left
// running (Fable review 2026-11-10 Nr. 6c).
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerClient } from './codex-app-server-client.ts';

test('no handshake: start() rejects and the process is gone', async () => {
  const marker = `codex-start-test-${process.pid}-${Date.now()}`;
  // A "server" that reads stdin and never writes: initialize times out.
  const err = await CodexAppServerClient.start({
    command: process.execPath,
    args: ['-e', `process.title=${JSON.stringify(marker)}; process.stdin.resume(); setInterval(() => {}, 1000)`],
    env: process.env,
    onNotification: () => {},
    onServerRequest: async () => ({}),
    initTimeoutMs: 300,
  }).catch((e: Error) => e);
  assert.ok(err instanceof Error, 'start rejects');
  const { execSync } = await import('node:child_process');
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    await new Promise((r) => setTimeout(r, 100));
    // [c] keeps pgrep from matching its own command line.
    alive = execSync(`pgrep -f '[c]${marker.slice(1)}' || true`).toString().trim().length > 0;
  }
  assert.equal(alive, false, 'the child was ended');
});
