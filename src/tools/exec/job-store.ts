// Disk-tracked background-job store for the `exec` tool. Per-job
// directory under ~/.somora/agents/<agent>/exec-jobs/<job_id>/ with:
//
//   meta.json     — job metadata + state (running/done/failed/killed)
//   stdout.log    — full stdout, append-only
//   stderr.log    — full stderr, append-only
//   exit          — integer exit code, written when process ends
//
// Survives server restart: recoverOrphanedJobs() runs at boot,
// finds any meta.json with state=running, marks them as failed
// with reason 'orphaned by server restart' (analogous to
// recoverOrphanRunningDreams in the dream subsystem).
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
  const tmp = `${path}.tmp`;
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
 * Server-start orphan recovery — analog to
 * recoverOrphanRunningDreams. Any job with state='running' was
 * orphaned by the previous server crash/shutdown; mark them failed
 * so the model sees them as terminal instead of "still running"
 * forever.
 *
 * Note about remote-background jobs: they use nohup/setsid so the
 * remote process MIGHT still be alive on the resource even after
 * somora restarted. We conservatively mark them as 'failed' here
 * anyway — somora has lost track of the in-process slot, the
 * stdin handle is gone, and re-attaching cleanly is fragile. The
 * remote process keeps running until completion and its log
 * files persist at /tmp/somora-exec-<job_id>.{out,err,exit} on
 * the resource for manual inspection. The model can probe state
 * via exec({command:"cat /tmp/somora-exec-<id>.exit", target:...})
 * if it cares. Local jobs are definitely dead since the parent
 * (somora) was killed.
 */
export async function recoverOrphanedJobs(agents: string[]): Promise<number> {
  let recovered = 0;
  for (const agent of agents) {
    const jobs = await listJobsForAgent(agent);
    for (const meta of jobs) {
      if (meta.state !== 'running') continue;
      meta.state = 'failed';
      meta.error = 'orphaned by server restart';
      meta.ended_at = Date.now();
      try {
        await writeMeta(agent, meta);
        recovered++;
      } catch (err) {
        logger.warn({
          msg: 'exec.job.recovery_write_failed',
          agent,
          job_id: meta.job_id,
          err: (err as Error).message,
        });
      }
    }
  }
  if (recovered > 0) {
    logger.info({ msg: 'exec.jobs_orphans_recovered', count: recovered, agents });
  }
  return recovered;
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
