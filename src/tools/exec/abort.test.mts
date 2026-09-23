// A stopped turn kills its running command. Run: npm test src/tools/exec/abort.test.mts
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { killRunningLocalExecs, localExecSync } from './local.ts';

const alive = (marker: string) => execSync(`pgrep -f "^sleep ${marker}$" || true`).toString().trim();

// abort signal → the process group dies, the result says so
{
  const ac = new AbortController();
  const t0 = Date.now();
  const p = localExecSync({ command: 'sleep 87.5', timeoutMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 400);
  const r = await p;
  assert.ok(Date.now() - t0 < 5000, 'returned promptly after abort');
  assert.match(r.stderr, /killed: the turn was stopped/);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive('87.5'), '', 'sleep is gone');
}
// an already-aborted signal never starts a long wait
{
  const ac = new AbortController(); ac.abort();
  const r = await localExecSync({ command: 'sleep 88.5', timeoutMs: 60_000, signal: ac.signal });
  assert.match(r.stderr, /killed: the turn was stopped/);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive('88.5'), '');
}
// the process-wide kill used by the MCP child's shutdown
{
  const p = localExecSync({ command: 'sleep 89.5', timeoutMs: 60_000 });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(killRunningLocalExecs(), 1);
  const r = await p;
  assert.match(r.stderr, /killed: the turn was stopped/);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(alive('89.5'), '');
}
console.log('exec abort.test: ok');
