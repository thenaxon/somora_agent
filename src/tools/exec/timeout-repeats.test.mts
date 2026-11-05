// A command that times out: what the builder is told, and the notice
// when the same command times out again in the session
// (timeout-repeats.ts, docs/tools.md "When a command times out").
//
// Run: npm test src/tools/exec/timeout-repeats.test.mts
import '../../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localExecSync, timeoutNote } from './local.ts';
import { recordExecTimeout, repeatTimeoutNotice } from './timeout-repeats.ts';
import { exec } from './tools.ts';
import type { ToolContext } from '../types.ts';

test('a command waiting for input gets EOF at once instead of the timeout', async () => {
  const t0 = Date.now();
  const r = await localExecSync({ command: 'read x; echo "got:[$x]"', timeoutMs: 5000 });
  assert.ok(Date.now() - t0 < 2000, 'returned without waiting');
  assert.equal(r.stdout.trim(), 'got:[]');
  assert.equal(r.timed_out, undefined);
});

test('a timeout says how long the command was silent and what to do', async () => {
  const silent = await localExecSync({ command: 'sleep 30', timeoutMs: 1500 });
  assert.equal(silent.timed_out, true);
  assert.match(silent.stderr, /killed: timeout after 1500ms; it printed nothing at all\./);
  assert.match(silent.stderr, /check the state before running it again/);
  assert.match(silent.stderr, /do not rerun it unchanged/);

  const talked = await localExecSync({ command: 'echo started; sleep 30', timeoutMs: 2500 });
  assert.equal(talked.timed_out, true);
  assert.match(talked.stderr, /no output for the last [23]s/);
  assert.equal(talked.stdout.trim(), 'started');

  assert.doesNotMatch(timeoutNote(60_000, 200, true), /no output|nothing/, 'a command still printing is not called silent');
});

test('the count is per session, folder and command; an edit in between does not reset it', async () => {
  const base = { agent: 'tester', session: 's1', cwd: '/w', ms: 600_000 };
  assert.equal((await recordExecTimeout({ ...base, command: 'pytest tests/test_a.py' })).count, 1);
  assert.equal((await recordExecTimeout({ ...base, command: '  pytest   tests/test_a.py ' })).count, 2, 'whitespace does not make it another command');
  assert.equal((await recordExecTimeout({ ...base, command: 'pytest tests/test_a.py -x' })).count, 1, 'a changed command starts over');
  assert.equal((await recordExecTimeout({ ...base, session: 's2', command: 'pytest tests/test_a.py' })).count, 1, 'another session');
  assert.equal((await recordExecTimeout({ ...base, cwd: '/v', command: 'pytest tests/test_a.py' })).count, 1, 'another folder');
  const third = await recordExecTimeout({ ...base, command: 'pytest tests/test_a.py' });
  assert.deepEqual(third, { count: 3, totalMs: 1_800_000 });
  assert.match(repeatTimeoutNotice(third.count, third.totalMs), /timed out 3 times in this session \(30 min in all\)/);
});

test('a count older than a day is forgotten', async () => {
  const base = { agent: 'tester', session: 'old', cwd: '/w', command: 'make test', ms: 1000 };
  await recordExecTimeout({ ...base, now: 1_000 });
  assert.equal((await recordExecTimeout({ ...base, now: 1_000 + 25 * 3600_000 })).count, 1);
});

test('exec: the second timeout of the same command carries the notice, the first does not', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'somora-timeout-'));
  const ctx = { agent: 'builderx', session: 'e2e-timeouts', config: { skills: { envScoping: false } } } as unknown as ToolContext;
  const input = { command: 'sleep 20', cwd, timeout_ms: 800, target: 'local', background: false } as Parameters<typeof exec.handler>[0];
  const first = (await exec.handler(input, ctx)) as unknown as Record<string, unknown>;
  assert.equal(first.timed_out, true);
  assert.equal(first.timeouts_in_session, undefined);
  assert.doesNotMatch(String(first.hint ?? ''), /timed out \d+ times/);
  const second = (await exec.handler(input, ctx)) as unknown as Record<string, unknown>;
  assert.equal(second.timeouts_in_session, 2);
  assert.match(String(second.hint), /^This exact command has now timed out 2 times in this session/);
  const other = (await exec.handler({ ...input, command: 'sleep 21' }, ctx)) as unknown as Record<string, unknown>;
  assert.equal(other.timeouts_in_session, undefined, 'another command has its own count');
});

test('parallel timeouts of one command are all counted', async () => {
  const base = { agent: 'tester', session: 'par', cwd: '/w', command: 'npm test', ms: 1000 };
  const counts = await Promise.all(Array.from({ length: 6 }, () => recordExecTimeout(base)));
  assert.deepEqual([...counts.map((c) => c.count)].sort(), [1, 2, 3, 4, 5, 6]);
});
