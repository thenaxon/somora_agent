// Local-process execution for the `exec` tool. Two paths:
//
// 1. localExecSync — spawn process, wait for exit, return aggregated
//    stdout/stderr (capped at 256 KB per stream), exit code, ms.
//    Mirrors the shape of remoteExec from src/ssh/exec.ts.
//
// 2. localExecBackground — spawn detached, register the job in the
//    disk-tracked job-store, stream stdout/stderr to log files,
//    return job_id immediately. Process keeps running after our
//    function returns. process_* tool actions interact with it via
//    the job-store + livePid registry.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../server/logger.ts';
import {
  clearLivePid,
  clearLiveStdin,
  completeJob,
  ensureJobDir,
  failJob,
  jobDir,
  registerJob,
  registerLivePid,
  registerLiveStdin,
  newJobId,
  type JobMeta,
} from './job-store.ts';

const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;
const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

export interface LocalSyncResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  ms: number;
}

export interface LocalSyncOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Allocate a pseudo-tty. v1 supports the option but treats it as a
   *  hint — node's child_process doesn't expose pty natively, so when
   *  pty:true we still use spawn with shell, callers get the same
   *  behavior. Real pty allocation is a FUTURE polish via node-pty. */
  pty?: boolean;
}

/**
 * Run a command locally, wait for it to finish, return the captured
 * output. Hard-blacklist check is the caller's responsibility (done
 * in tools.ts before this gets called). Output above the per-stream
 * cap is truncated; truncated:true tells the model to escalate to
 * file_write+file_read for the full content.
 */
export async function localExecSync(opts: LocalSyncOptions): Promise<LocalSyncResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;

  return new Promise<LocalSyncResult>((resolve) => {
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env,
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = DEFAULT_OUTPUT_CAP_BYTES - stdoutBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdoutChunks.push(slice);
      stdoutBytes += slice.length;
      if (chunk.length > remaining) truncated = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = DEFAULT_OUTPUT_CAP_BYTES - stderrBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
      if (chunk.length > remaining) truncated = true;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Give it 2s to clean up, then SIGKILL.
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const finalStderr = timedOut
        ? stderr + `\n[somora] killed: timeout after ${timeoutMs}ms`
        : stderr;
      resolve({
        exit_code: code,
        stdout,
        stderr: finalStderr,
        truncated,
        ms: Date.now() - start,
      });
      logger.info({
        msg: 'exec.local.sync_done',
        ms: Date.now() - start,
        exit_code: code,
        signal,
        timed_out: timedOut,
        truncated,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exit_code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `[somora] spawn error: ${err.message}`,
        truncated,
        ms: Date.now() - start,
      });
    });
  });
}

export interface LocalBackgroundOptions {
  agent: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  description?: string;
  pty?: boolean;
  /** Concurrency-slot release callback. Called exactly once when the
   *  job ends (any path: clean exit, error, or kill) so the cap
   *  counter doesn't leak. */
  releaseSlot?: () => void;
}

export interface LocalBackgroundResult {
  job_id: string;
  pid: number;
}

/**
 * Spawn a long-running process detached from the current call. The
 * job is registered in the job-store, output streams to disk-files,
 * and the model can interact via process_* actions later. Caller
 * gets the job_id back immediately.
 */
export async function localExecBackground(
  opts: LocalBackgroundOptions,
): Promise<LocalBackgroundResult> {
  const job_id = newJobId();
  const meta: JobMeta = {
    job_id,
    agent: opts.agent,
    target: 'local',
    command: opts.command,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    started_at: Date.now(),
    state: 'running',
    pid: 0, // filled in below
  };

  // Make sure the job dir exists so the log streams can attach.
  await ensureJobDir(opts.agent, job_id);
  const stdoutPath = join(jobDir(opts.agent, job_id), 'stdout.log');
  const stderrPath = join(jobDir(opts.agent, job_id), 'stderr.log');

  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const child = spawn(opts.command, {
    shell: true,
    cwd: opts.cwd,
    env,
    detached: false,
    // stdin pipe so process_write can stream into it later.
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (!child.pid) {
    throw new Error('exec.local.background: spawn returned no pid');
  }
  meta.pid = child.pid;
  await registerJob(meta);
  registerLivePid(job_id, child.pid);
  if (child.stdin) registerLiveStdin(job_id, child.stdin);

  // Stream stdout / stderr to disk. Each line goes to disk
  // immediately so the model can poll partial output via
  // process_log without waiting for completion.
  const outFile = createWriteStream(stdoutPath, { flags: 'a' });
  const errFile = createWriteStream(stderrPath, { flags: 'a' });
  child.stdout?.pipe(outFile);
  child.stderr?.pipe(errFile);

  child.on('close', (code, _signal) => {
    outFile.end();
    errFile.end();
    void completeJob(opts.agent, job_id, code).finally(() => {
      clearLivePid(job_id);
      clearLiveStdin(job_id);
      opts.releaseSlot?.();
    });
  });

  child.on('error', (err) => {
    void failJob(opts.agent, job_id, `spawn error: ${err.message}`).finally(() => {
      clearLivePid(job_id);
      clearLiveStdin(job_id);
      opts.releaseSlot?.();
    });
  });

  // Detach the child so the parent can exit without killing it.
  // (We don't actually unref because we still listen for close to
  // update job state; if the somora server exits the parent ref
  // dies anyway and recoverOrphanedJobs takes over on next start.)

  logger.info({
    msg: 'exec.local.background_started',
    job_id,
    agent: opts.agent,
    pid: child.pid,
    command_head: opts.command.slice(0, 80),
  });

  return { job_id, pid: child.pid };
}

/**
 * Send a signal to a running local job. Returns whether the signal
 * was actually delivered (process still alive) or the process was
 * already gone.
 */
export function killLocalJob(pid: number, signal: NodeJS.Signals): { delivered: boolean } {
  try {
    process.kill(pid, signal);
    return { delivered: true };
  } catch (err) {
    // ESRCH = no such process — already dead. Anything else is a
    // real error.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return { delivered: false };
    }
    throw err;
  }
}
