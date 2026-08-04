// Regression tests for detached background jobs + cross-process
// liveness (2026-07-27 report: jobs died when the MCP tool-host
// recycled between turns, and poll kept reporting 'running' for
// long-dead PIDs).
//
// Run: npx tsx src/tools/exec/background-jobs.test.mts
//
// Covers:
//   1. In-process lifecycle: job completes, exit file written, logs land.
//   2. THE report scenario: spawner process exits immediately after
//      spawning (helper subprocess) — job must survive, keep writing
//      output, and finish; probeLocalJob resolves 'done' + exit code.
//   3. probeLocalJob dead-PID branch: running-meta with a gone PID and
//      no exit file → 'failed process gone', never 'running'.
//   4. probeLocalJob alive branch: running-meta with a live PID and no
//      exit file → stays 'running'.
//   5. recoverOrphanedJobs adopts live jobs instead of blanket-failing.

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const HOME = mkdtempSync(join(tmpdir(), 'somora-bgjobs-'));
process.env.SOMORA_HOME = HOME;

// Dynamic imports AFTER SOMORA_HOME is set (modules read it at load).
const { localExecBackground } = await import('./local.ts');
const { jobDir, probeLocalJob, readMeta, recoverOrphanedJobs, writeMeta } = await import(
  './job-store.ts'
);

const pexecFile = promisify(execFile);
const AGENT = 'testagent';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await delay(100);
  }
  return false;
}

// ── 1. In-process lifecycle ─────────────────────────────────────────
{
  const r = await localExecBackground({
    agent: AGENT,
    command: 'echo out-line; echo err-line >&2; exit 3',
  });
  const done = await waitFor(async () => {
    const m = await readMeta(AGENT, r.job_id);
    return m !== null && m.state !== 'running';
  }, 5000);
  const meta = await readMeta(AGENT, r.job_id);
  check('in-process job reaches terminal state', done, JSON.stringify(meta));
  check('exit code propagated (3 → failed)', meta?.state === 'failed' && meta.exit_code === 3);
  const exitFile = readFileSync(join(jobDir(AGENT, r.job_id), 'exit'), 'utf8').trim();
  check('exit file written by wrapper', exitFile === '3', exitFile);
  const stdout = readFileSync(join(jobDir(AGENT, r.job_id), 'stdout.log'), 'utf8');
  const stderr = readFileSync(join(jobDir(AGENT, r.job_id), 'stderr.log'), 'utf8');
  check('stdout landed in log file', stdout.includes('out-line'), stdout);
  check('stderr landed in log file', stderr.includes('err-line'), stderr);
}

// ── 2. Spawner dies, job survives (THE report scenario) ─────────────
{
  const helper = join(import.meta.dirname, 'background-detach.helper.mts');
  const marker = join(HOME, 'survivor-output.txt');
  // Job: keep writing AFTER the spawner is gone, then exit 0. The
  // writes double as the SIGPIPE probe — with inherited pipes (the
  // old bug) the first echo after spawner-death killed the job.
  const cmd = `for i in 1 2 3 4 5 6; do echo tick-$i >> '${marker}'; sleep 0.2; done`;
  const { stdout: helperOut } = await pexecFile('npx', ['tsx', helper, AGENT, cmd], {
    env: { ...process.env, SOMORA_HOME: HOME },
  });
  const jobId = helperOut.trim().split('\n').pop() ?? '';
  check('helper printed a job_id', jobId.startsWith('job_'), helperOut);
  // Helper has exited here (execFile resolved). Job must still be alive.
  const metaEarly = await readMeta(AGENT, jobId);
  check('meta exists after spawner death', metaEarly !== null);
  const probedEarly = metaEarly ? await probeLocalJob(AGENT, metaEarly) : null;
  check(
    'probe right after spawner death says running',
    probedEarly?.state === 'running',
    JSON.stringify(probedEarly),
  );
  // Wait for the job to finish on its own, then probe again — the
  // spawner's exit listener is gone, so ONLY the probe can resolve it.
  const finished = await waitFor(async () => {
    const m = await readMeta(AGENT, jobId);
    if (!m) return false;
    const p = await probeLocalJob(AGENT, m);
    return p.state !== 'running';
  }, 8000);
  const final = await readMeta(AGENT, jobId);
  check('orphaned job resolved to terminal state', finished, JSON.stringify(final));
  check('orphaned job completed clean (done, exit 0)', final?.state === 'done' && final.exit_code === 0, JSON.stringify(final));
  const ticks = readFileSync(marker, 'utf8').trim().split('\n');
  check(
    'job kept writing after spawner death (all 6 ticks)',
    ticks.length === 6 && ticks[5] === 'tick-6',
    JSON.stringify(ticks),
  );
}

// ── 3. Dead PID + no exit file → failed, never 'running' ────────────
{
  // Burn a PID: spawn a trivial process and wait for it to die.
  const { stdout } = await pexecFile('sh', ['-c', 'echo $$']);
  const deadPid = Number.parseInt(stdout.trim(), 10);
  const meta = {
    job_id: 'job_00000000_dead',
    agent: AGENT,
    target: 'local',
    command: 'sleep 999',
    started_at: Date.now() - 60_000,
    state: 'running' as const,
    pid: deadPid,
  };
  await writeMeta(AGENT, meta);
  const probed = await probeLocalJob(AGENT, meta);
  check('dead PID resolves to failed', probed.state === 'failed', JSON.stringify(probed));
  check(
    'dead PID failure names the cause',
    (probed.error ?? '').includes('process gone without exit record'),
    probed.error ?? '',
  );
}

// ── 4. Live PID + no exit file → stays running ──────────────────────
{
  const meta = {
    job_id: 'job_00000000_live',
    agent: AGENT,
    target: 'local',
    command: 'sleep 999',
    started_at: Date.now(),
    state: 'running' as const,
    pid: process.pid, // our own PID is definitely alive
  };
  await writeMeta(AGENT, meta);
  const probed = await probeLocalJob(AGENT, meta);
  check('live PID stays running', probed.state === 'running', JSON.stringify(probed));
}

// ── 5. Boot recovery adopts live jobs, resolves dead ones ───────────
{
  // State on disk now: job_00000000_live (running, live PID),
  // job_00000000_dead (already failed by test 3). Add one more dead.
  const meta = {
    job_id: 'job_00000000_dea2',
    agent: AGENT,
    target: 'local',
    command: 'sleep 999',
    started_at: Date.now() - 60_000,
    state: 'running' as const,
    pid: 999999999, // out of pid_max range on linux → definitely gone
  };
  await writeMeta(AGENT, meta);
  const resolved = await recoverOrphanedJobs([AGENT]);
  check('recovery resolved exactly the dead job', resolved === 1, String(resolved));
  const live = await readMeta(AGENT, 'job_00000000_live');
  check('recovery ADOPTED the live job (still running)', live?.state === 'running', JSON.stringify(live));
  const dead = await readMeta(AGENT, 'job_00000000_dea2');
  check('recovery failed the dead job', dead?.state === 'failed', JSON.stringify(dead));
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
