// Disk-tracked background-job store for the `exec` tool. Per-job
// directory under ~/.somora/agents/<agent>/exec-jobs/<job_id>/ with:
//
//   meta.json     — job metadata + state (running/done/failed/killed)
//   stdout.log    — full stdout, append-only
//   stderr.log    — full stderr, append-only
//   exit          — integer exit code, written when process ends
//
// Survives server restart: jobs are fully detached (own process
// group, log files as raw FDs, exit-code file) so a running job
// legitimately outlives somora/MCP restarts. recoverOrphanedJobs()
// at boot and probeLocalJob() on poll/list resolve the real state
// cross-process (exit file → real code; PID probe → running/gone).
//
// Note: stdout.log / stderr.log are unbounded on disk — we never
// truncate the source-of-truth. The 256 KB output cap applies only
// to in-memory reads (process.log tail, sync exec result). For
// huge log files the model is expected to use file_read with
// offset/limit to page through.

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

export type JobState = 'running' | 'done' | 'failed' | 'killed';

export interface JobMeta {
  job_id: string;
  agent: string;
  /** 'local' or a configured resource name. */
  target: string;
  command: string;
  cwd?: string;
  description?: string;
  started_at: number;
  state: JobState;
  /** Local PID — null for remote jobs (we don't track remote PIDs). */
  pid: number | null;
  ended_at?: number;
  exit_code?: number | null;
  error?: string;
}

export function jobsDir(agent: string): string {
  return join(SOMORA_HOME, 'agents', agent, 'exec-jobs');
}

export function jobDir(agent: string, jobId: string): string {
  return join(jobsDir(agent), jobId);
}

/**
 * Generate a process-wide-unique job id. Format: `job_<msTs>_<rand4>`.
 * 4-char random suffix on the millisecond timestamp gives ~17M
 * collision-resistance for same-ms jobs which is plenty (we have
 * single-digit concurrent jobs per agent realistically).
 */
export function newJobId(): string {
  const ms = Date.now();
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `job_${ms}_${rand}`;
}

export async function ensureJobDir(agent: string, jobId: string): Promise<string> {
  const dir = jobDir(agent, jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  // Per-call unique tmp so a `completeJob` and a `markJobKilled` racing
  // on the same job meta.json don't share `<path>.tmp` and ENOENT each
  // other. Audit 2026-05-16.
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function writeMeta(agent: string, meta: JobMeta): Promise<void> {
  const dir = await ensureJobDir(agent, meta.job_id);
  await writeJsonAtomic(join(dir, 'meta.json'), meta);
}

export async function readMeta(agent: string, jobId: string): Promise<JobMeta | null> {
  try {
    const raw = await readFile(join(jobDir(agent, jobId), 'meta.json'), 'utf8');
    return JSON.parse(raw) as JobMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Register a freshly-spawned background job. Caller should kick off
 * the actual process AFTER this returns so the meta exists on disk
 * before any output streams in.
 */
export async function registerJob(meta: JobMeta): Promise<void> {
  await writeMeta(meta.agent, meta);
  logger.info({
    msg: 'exec.job.registered',
    job_id: meta.job_id,
    agent: meta.agent,
    target: meta.target,
    command_head: meta.command.slice(0, 80),
  });
}

/**
 * Mark a job as done with the captured exit code. Idempotent —
 * second call is a no-op.
 */
export async function completeJob(
  agent: string,
  jobId: string,
  exitCode: number | null,
): Promise<void> {
  const meta = await readMeta(agent, jobId);
  if (!meta) return;
  if (meta.state !== 'running') return;
  meta.state = exitCode === 0 ? 'done' : 'failed';
  meta.exit_code = exitCode;
  meta.ended_at = Date.now();
  await writeMeta(agent, meta);
  logger.info({
    msg: 'exec.job.completed',
    job_id: jobId,
    agent,
    state: meta.state,
    exit_code: exitCode,
    ms: meta.ended_at - meta.started_at,
  });
}

/**
 * Mark a job as failed with an error message. Use for spawn failures
 * or uncaught exceptions in the streaming path.
 */
export async function failJob(
  agent: string,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  const meta = await readMeta(agent, jobId);
  if (!meta) return;
  if (meta.state !== 'running') return;
  meta.state = 'failed';
  meta.error = errorMessage;
  meta.ended_at = Date.now();
  await writeMeta(agent, meta);
  logger.warn({
    msg: 'exec.job.failed',
    job_id: jobId,
    agent,
    err: errorMessage,
  });
}

/**
 * Mark a job as killed (via process_kill action). The actual kill
 * signaling happens in local.ts; this just updates state.
 */
export async function markJobKilled(
  agent: string,
  jobId: string,
  signal: string,
): Promise<void> {
  const meta = await readMeta(agent, jobId);
  if (!meta) return;
  if (meta.state !== 'running') return;
  meta.state = 'killed';
  meta.error = `killed with ${signal}`;
  meta.ended_at = Date.now();
  await writeMeta(agent, meta);
  logger.info({ msg: 'exec.job.killed', job_id: jobId, agent, signal });
}

/**
 * List all jobs for an agent, newest first by started_at.
 */
export async function listJobsForAgent(agent: string): Promise<JobMeta[]> {
  const dir = jobsDir(agent);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: JobMeta[] = [];
  for (const e of entries) {
    if (!e.startsWith('job_')) continue;
    const meta = await readMeta(agent, e);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => b.started_at - a.started_at);
  return out;
}

/**
 * Read a tail of stdout/stderr for a job. Returns the LAST
 * `maxBytesPerStream` bytes of each (default 256 KB), with a
 * truncated:true flag when the file was bigger.
 */
export async function readJobLog(
  agent: string,
  jobId: string,
  opts: { maxBytesPerStream?: number } = {},
): Promise<{
  job_id: string;
  stdout_tail: string;
  stderr_tail: string;
  total_stdout_bytes: number;
  total_stderr_bytes: number;
  truncated: boolean;
} | null> {
  const meta = await readMeta(agent, jobId);
  if (!meta) return null;
  const cap = opts.maxBytesPerStream ?? 256 * 1024;

  const tailOf = async (name: 'stdout.log' | 'stderr.log'): Promise<{ tail: string; total: number; truncated: boolean }> => {
    const path = join(jobDir(agent, jobId), name);
    try {
      const st = await stat(path);
      const total = st.size;
      // For small files: read whole. For big: read last `cap` bytes.
      // node has no easy "read last N bytes" — we just read the whole
      // and slice. For multi-MB log files this is wasteful but jobs
      // that produce that much output are rare; if it becomes a
      // problem we can switch to fs.read with offset.
      const buf = await readFile(path);
      if (buf.length <= cap) {
        return { tail: buf.toString('utf8'), total, truncated: false };
      }
      const tail = buf.subarray(buf.length - cap).toString('utf8');
      return { tail, total, truncated: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { tail: '', total: 0, truncated: false };
      }
      throw err;
    }
  };

  const [stdout, stderr] = await Promise.all([tailOf('stdout.log'), tailOf('stderr.log')]);
  return {
    job_id: jobId,
    stdout_tail: stdout.tail,
    stderr_tail: stderr.tail,
    total_stdout_bytes: stdout.total,
    total_stderr_bytes: stderr.total,
    truncated: stdout.truncated || stderr.truncated,
  };
}

/**
 * Resolve the REAL state of a local background job whose meta says
 * 'running'. Local jobs are fully detached (own process group, log
 * files as raw FDs, exit-code file written by the wrapper shell), so
 * they survive somora/MCP restarts — which also means the in-process
 * 'exit' listener that normally updates meta may be long gone. This
 * probe is the cross-process source of truth:
 *
 *   1. <jobdir>/exit exists      → wrapper finished; complete with
 *                                  that code (even if a recycled PID
 *                                  happens to be alive).
 *   2. no exit file, PID alive   → still running, meta untouched.
 *   3. no exit file, PID gone    → died without a trace (SIGKILL,
 *                                  OOM, host reboot); mark failed.
 *
 * Called from process poll/list and from boot recovery — NEVER trust
 * a bare meta.state==='running' for a local job without this probe
 * (2026-07-27 report: poll said running for a PID that was gone).
 *
 * Returns the fresh meta (re-read after any state change).
 */
export async function probeLocalJob(agent: string, meta: JobMeta): Promise<JobMeta> {
  if (meta.state !== 'running' || meta.target !== 'local' || meta.pid == null) {
    return meta;
  }
  let exitCode: number | null = null;
  let hasExitFile = false;
  try {
    const raw = await readFile(join(jobDir(agent, meta.job_id), 'exit'), 'utf8');
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(n)) {
      exitCode = n;
      hasExitFile = true;
    }
  } catch {
    // no exit file (yet) — fall through to the PID probe
  }
  if (!hasExitFile) {
    let alive = false;
    try {
      process.kill(meta.pid, 0);
      alive = true;
    } catch {
      // ESRCH/EPERM → treat as gone
    }
    if (alive) return meta;
    await failJob(
      agent,
      meta.job_id,
      'process gone without exit record (external kill, OOM, or host reboot)',
    );
  } else {
    await completeJob(agent, meta.job_id, exitCode);
  }
  clearLivePid(meta.job_id);
  clearLiveStdin(meta.job_id);
  return (await readMeta(agent, meta.job_id)) ?? meta;
}

/**
 * Server-start recovery — analog to recoverOrphanRunningDreams, but
 * since 2026-08 background jobs are fully detached and legitimately
 * SURVIVE restarts. So instead of blanket-failing every running job:
 *
 *   - local jobs: probeLocalJob resolves the truth (exit file →
 *     done/failed with real code; PID alive → adopted, stays running
 *     and killable via meta.pid; PID gone → failed). An adopted job
 *     has no live stdin handle — process_write reports that.
 *   - remote jobs: left as 'running'; they use nohup/setsid on the
 *     resource and the next process poll actively probes them via
 *     ssh (kill -0 + exit-file), which is too slow for boot.
 *
 * Concurrency note: in-memory slot counters reset on restart —
 * per-agent cap enforcement therefore counts running jobs from DISK
 * (post-probe) at spawn time, see tools.ts background path.
 */
export async function recoverOrphanedJobs(agents: string[]): Promise<number> {
  let adopted = 0;
  let resolved = 0;
  for (const agent of agents) {
    const jobs = await listJobsForAgent(agent);
    for (const meta of jobs) {
      if (meta.state !== 'running') continue;
      if (meta.target !== 'local') continue;
      try {
        const fresh = await probeLocalJob(agent, meta);
        if (fresh.state === 'running') adopted++;
        else resolved++;
      } catch (err) {
        logger.warn({
          msg: 'exec.job.recovery_probe_failed',
          agent,
          job_id: meta.job_id,
          err: (err as Error).message,
        });
      }
    }
  }
  if (adopted > 0 || resolved > 0) {
    logger.info({
      msg: 'exec.jobs_recovered_at_boot',
      adopted_still_running: adopted,
      resolved_terminal: resolved,
      agents,
    });
  }
  return resolved;
}

/**
 * In-memory tracker for live PIDs of running jobs — needed for
 * process_kill since we can't easily look up the spawned-process
 * handle from disk after the fact. Populated by local.ts when a
 * background job spawns; cleared on completion. Survives only the
 * current server-process lifetime.
 */
const livePids = new Map<string, number>();

export function registerLivePid(jobId: string, pid: number): void {
  livePids.set(jobId, pid);
}

export function getLivePid(jobId: string): number | undefined {
  return livePids.get(jobId);
}

export function clearLivePid(jobId: string): void {
  livePids.delete(jobId);
}

/** Live writable handles for stdin (background process_write). */
const liveStdins = new Map<string, NodeJS.WritableStream>();

export function registerLiveStdin(jobId: string, stream: NodeJS.WritableStream): void {
  liveStdins.set(jobId, stream);
}

export function getLiveStdin(jobId: string): NodeJS.WritableStream | undefined {
  return liveStdins.get(jobId);
}

export function clearLiveStdin(jobId: string): void {
  liveStdins.delete(jobId);
}
