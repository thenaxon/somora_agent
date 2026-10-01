import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildUserAgent, isDue, parseLatestVersion, resolveUpdateCheckReason, statusFrom, UpdateChecker } from './update-check.ts';

const dir = mkdtempSync(join(tmpdir(), 'somora-update-check-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const quiet = { info: () => {}, warn: () => {} };

test('env wins: DO_NOT_TRACK and CI switch the check off, config after them', () => {
  assert.equal(resolveUpdateCheckReason(true, {}), 'enabled');
  assert.equal(resolveUpdateCheckReason(true, { DO_NOT_TRACK: '1' }), 'do-not-track');
  assert.equal(resolveUpdateCheckReason(true, { DO_NOT_TRACK: '0' }), 'enabled');
  assert.equal(resolveUpdateCheckReason(true, { CI: 'true' }), 'automated-environment');
  assert.equal(resolveUpdateCheckReason(false, {}), 'config-disabled');
});

test('the User-Agent is the whole request', () => {
  assert.equal(buildUserAgent('2026.1001.2', 'server', { platform: 'linux', node: '22.23.2', arch: 'x64' }), 'somora/2026.1001.2 (linux; node/22.23.2; x64; server)');
});

test('answers are validated', () => {
  assert.deepEqual(parseLatestVersion({ version: '2026.1001.3', note: ' hi ' }), { version: '2026.1001.3', note: 'hi' });
  assert.deepEqual(parseLatestVersion({ version: '2026.1001.3', note: '' }), { version: '2026.1001.3' });
  assert.equal(parseLatestVersion({ version: 'latest' }), null);
  assert.equal(parseLatestVersion('nope'), null);
  assert.equal(parseLatestVersion({ version: '1.2.3', note: 'x'.repeat(900) })!.note!.length, 500);
});

test('due once a day after a success, after an hour following a failure', () => {
  const h = 60 * 60 * 1000;
  assert.equal(isDue({}), true);
  assert.equal(isDue({ lastCheckedAt: 1000, lastSuccessAt: 1000 }, 1000 + 23 * h), false);
  assert.equal(isDue({ lastCheckedAt: 1000, lastSuccessAt: 1000 }, 1000 + 25 * h), true);
  assert.equal(isDue({ lastCheckedAt: 1000 }, 1000 + 30 * 60 * 1000), false, 'failed half an hour ago');
  assert.equal(isDue({ lastCheckedAt: 1000 }, 1000 + 2 * h), true);
  assert.equal(isDue({ lastSuccessAt: 1000, lastCheckedAt: 1000 + 25 * h }, 1000 + 25.5 * h), false, 'failed after the daily success: wait the hour');
});

test('updateAvailable only when the published version is newer', () => {
  const base = { version: '2026.1001.2', configEnabled: true, endpoint: 'x', surface: 'cli' as const, env: {} };
  assert.equal(statusFrom({ ...base, state: { latestVersion: '2026.1001.3' } }).updateAvailable, true);
  assert.equal(statusFrom({ ...base, state: { latestVersion: '2026.1001.2' } }).updateAvailable, false);
  assert.equal(statusFrom({ ...base, state: { latestVersion: '2026.930.4' } }).updateAvailable, false);
  assert.equal(statusFrom({ ...base, state: {} }).updateAvailable, false);
});

test('one request: header only, answer kept in the state file, a failure keeps the last answer', async () => {
  const seen: Array<{ method: string; ua: string | undefined; len: string | undefined }> = [];
  let answer: string = JSON.stringify({ version: '2026.1001.9', note: 'update before Friday' });
  let status = 200;
  const srv = createServer((req, res) => {
    seen.push({ method: req.method ?? '', ua: req.headers['user-agent'], len: req.headers['content-length'] });
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(answer);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  const statePath = join(dir, 'update-check.json');
  const logs: string[] = [];
  const checker = new UpdateChecker({
    version: '2026.1001.2', endpoint: `http://127.0.0.1:${port}/api/latest-version`, statePath, configEnabled: true, surface: 'server',
    log: { info: (o) => logs.push(String(o.msg)), warn: (o) => logs.push(String(o.msg)) }, env: {},
  });
  try {
    const s = await checker.check(1_000_000);
    assert.deepEqual(seen, [{ method: 'GET', ua: buildUserAgent('2026.1001.2', 'server'), len: undefined }], 'no body, no identifier');
    assert.equal(s.updateAvailable, true);
    assert.equal(s.latestVersion, '2026.1001.9');
    assert.equal(s.note, 'update before Friday');
    assert.deepEqual(logs, ['update.available']);
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(onDisk.latestVersion, '2026.1001.9');
    assert.equal(onDisk.lastSuccessAt, 1_000_000);

    // not due again right away
    assert.equal(await checker.checkIfDue(1_000_000 + 1000), 'skipped');

    // a failure is logged, the last good answer stays
    status = 500; answer = 'boom'; logs.length = 0;
    const f = await checker.check(2_000_000);
    assert.equal(f.latestVersion, '2026.1001.9');
    assert.deepEqual(logs, ['update.check_failed']);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).lastError, 'HTTP 500');

    // a new checker reads the file back
    const again = new UpdateChecker({ version: '2026.1001.2', endpoint: 'http://127.0.0.1:1/', statePath, configEnabled: true, surface: 'cli', log: quiet, env: {} });
    assert.equal(again.status().latestVersion, '2026.1001.9');
    // disabled: nothing is sent, status says why
    const off = new UpdateChecker({ version: '2026.1001.2', endpoint: `http://127.0.0.1:${port}/`, statePath, configEnabled: true, surface: 'cli', log: quiet, env: { DO_NOT_TRACK: '1' } });
    assert.equal(off.status().reason, 'do-not-track');
  } finally {
    srv.close();
  }
});
