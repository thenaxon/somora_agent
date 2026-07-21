// Local-process execution for the `exec` tool. Two paths:
//
// 1. localExecSync — spawn process, wait for exit, return aggregated
//    stdout/stderr (capped at 256 KB per stream), exit code, ms.
//    Mirrors the shape of remoteExec from src/ssh/exec.ts. When
//    pty:true, routes through node-pty for real pseudo-terminal
//    allocation so isatty()-checking tools (vim, htop, claude --
//    skip-permissions, codex, color/cursor handling, progress bars)
//    work correctly. With pty on, stdout and stderr merge into one
//    stream — same behavior as a real terminal and as our
//    remote-pty path via ssh2.
//
// 2. localExecBackground — spawn detached, register the job in the
//    disk-tracked job-store, stream stdout/stderr to log files,
//    return job_id immediately. Process keeps running after our
//    function returns. process_* tool actions interact with it via
//    the job-store + livePid registry. Background ignores pty:true
//    — TUI tools in the background make no sense (no one's watching);
//    use tmux for "long-running interactive on local" instead.

import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import { createWriteStream, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { logger } from '../../server/logger.ts';
import { extendedPath } from '../../skills/path-helpers.ts';
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

/**
 * Build the env for a spawned subprocess. Always extends PATH with
 * known user-install dirs (linuxbrew, homebrew, ~/.local/bin, …) so
 * that brew/cargo/go binaries are reachable even when somora runs as
 * a systemd user-service with the minimal default PATH. Caller-
 * supplied env entries override on conflict (incl. PATH if explicitly
 * provided).
 *
 * `stripSomoraInternal` removes somora-internal vars that the server
 * sets on its own process.env for its own subsystems but which leak
 * into user-facing tmux/exec children otherwise. Specifically:
 *   - CLAUDE_CONFIG_DIR — redirects `claude` away from ~/.claude
 *   - SOMORA_CLAUDE_BIN — forces a specific claude binary
 * Both cause user-confusion when an agent opens a tmux shell or runs
 * `exec` and the spawned `claude` then doesn't see the user's normal
 * login state. Defaults to false to preserve backwards compatibility
 * for internal callers (dream, engine spawn, MCP children). Tool
 * dispatchers (exec, tmux) pass true unless the agent explicitly opts
 * into env-inheritance.
 */
function buildSpawnEnv(
  callerEnv?: Record<string, string>,
  opts?: { stripSomoraInternal?: boolean },
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, PATH: extendedPath() };
  if (opts?.stripSomoraInternal) {
    delete base.CLAUDE_CONFIG_DIR;
    delete base.SOMORA_CLAUDE_BIN;
  }
  if (callerEnv) Object.assign(base, callerEnv);
  return base;
}

const DEFAULT_OUTPUT_CAP_BYTES = 256 * 1024;
const DEFAULT_SYNC_TIMEOUT_MS = 60_000;

/**
 * Resolve a caller-supplied cwd for local spawn. Node's spawn does NOT
 * expand `~` and resolves relative paths against the somora server's
 * own process cwd — and a nonexistent cwd surfaces as the wildly
 * misleading `spawn /bin/sh ENOENT` (the chdir fails, not the shell;
 * 2026-06-10 hans feedback). The tool schema promises
 * "relative-to-target-home", so make that true: expand `~`, resolve
 * relative against the home dir, and verify the directory exists so
 * the error names the actual problem.
 */
export function resolveLocalCwd(
  cwd: string,
): { ok: true; cwd: string } | { ok: false; error: string } {
  let resolved = cwd;
  if (cwd === '~') resolved = homedir();
  else if (cwd.startsWith('~/')) resolved = join(homedir(), cwd.slice(2));
  else if (!isAbsolute(cwd)) resolved = join(homedir(), cwd);
  let isDir = false;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch {
    /* missing → isDir stays false */
  }
  if (!isDir) {
    return {
      ok: false,
      error:
        `[somora] cwd error: '${cwd}'` +
        (resolved !== cwd ? ` (resolved to '${resolved}')` : '') +
        ` is not an existing directory on the somora server. Pass an absolute path, ` +
        `'~/...', or a path relative to the server user's home.`,
    };
  }
  return { ok: true, cwd: resolved };
}

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
  /** Allocate a pseudo-terminal via node-pty. Tools that check
   *  isatty() (vim, htop, claude --skip-permissions, codex, color
   *  output, progress bars) work correctly with pty:true. With pty
   *  on, stdout and stderr merge into a single stream (= same
   *  behavior as a real terminal). */
  pty?: boolean;
  /** Strip somora-internal env vars (CLAUDE_CONFIG_DIR, SOMORA_CLAUDE_BIN)
   *  before spawning. Tool dispatchers set this true so user-facing
   *  `exec`/`tmux` children behave like a normal terminal would.
   *  See buildSpawnEnv() for the rationale. Default false. */
  stripSomoraInternalEnv?: boolean;
}

/**
 * Run a command locally, wait for it to finish, return the captured
 * output. Hard-blacklist check is the caller's responsibility (done
 * in tools.ts before this gets called). Output above the per-stream
 * cap is truncated; truncated:true tells the model to escalate to
 * file_write+file_read for the full content.
 *
 * When pty:true, dispatches to the node-pty path. Otherwise uses
 * child_process.spawn for plain pipe-based capture (faster startup,
 * separate stdout/stderr streams).
 */
export async function localExecSync(opts: LocalSyncOptions): Promise<LocalSyncResult> {
  if (opts.cwd) {
    const r = resolveLocalCwd(opts.cwd);
    if (!r.ok) {
      return { exit_code: null, stdout: '', stderr: r.error, truncated: false, ms: 0 };
    }
    opts = { ...opts, cwd: r.cwd };
  }
  if (opts.pty) {
    return localExecSyncPty(opts);
  }
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const env = buildSpawnEnv(opts.env, {
    stripSomoraInternal: opts.stripSomoraInternalEnv === true,
  });

  return new Promise<LocalSyncResult>((resolve) => {
    // `detached: true` puts the child in its own process group so
    // `process.kill(-pid, signal)` can take down the whole tree —
    // shell + grandchildren. Without it a `shell: true` invocation
    // leaves grandchildren (like a trapped `sleep`) holding the
    // stdout pipe open, so the `close` event never fires and the
    // promise stalls until the grandchild exits naturally. Audit
    // 2026-05-16: `sh -c 'trap "" TERM; sleep 30'` with timeout=2s
    // sat for the full 30s pre-fix.
    const child = spawn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env,
      detached: true,
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
    const killGroup = (signal: NodeJS.Signals) => {
      // Negative pid → process group (set up by `detached: true`).
      // Falls back to the leader if the group kill rejects.
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Give it 2s to clean up, then SIGKILL. `child.killed` flips true
      // as soon as the signal is *sent*, not when the process actually
      // dies — so checking it skips the escalation for any command that
      // traps/ignores SIGTERM. Use `exitCode === null` (process still
      // running) instead. Audit 2026-05-16.
      setTimeout(() => {
        if (child.exitCode === null) {
          killGroup('SIGKILL');
        }
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

/**
 * PTY variant of localExecSync via node-pty. Allocates a pseudo-tty
 * so the spawned process sees `isatty(stdin/stdout) === true` plus
 * a TERM env var — required for vim, htop, color output, progress
 * bars, claude --skip-permissions, codex etc.
 *
 * node-pty merges stdout and stderr into a single stream (the same
 * limitation as on a real terminal) so we collect everything into
 * `stdout` and leave `stderr` empty. Matches the remote-pty path's
 * shape exactly.
 *
 * To run a shell command (with operators, redirects, etc.) we wrap
 * it in `sh -c '...'` — node-pty otherwise just exec's the
 * argv[0] directly.
 */
async function localExecSyncPty(opts: LocalSyncOptions): Promise<LocalSyncResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const env = buildSpawnEnv(opts.env, {
    stripSomoraInternal: opts.stripSomoraInternalEnv === true,
  });

  return new Promise<LocalSyncResult>((resolve) => {
    let term;
    try {
      term = pty.spawn('sh', ['-c', opts.command], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: opts.cwd,
        env: env as { [key: string]: string },
      });
    } catch (err) {
      resolve({
        exit_code: null,
        stdout: '',
        stderr: `[somora] pty spawn error: ${(err as Error).message}`,
        truncated: false,
        ms: Date.now() - start,
      });
      return;
    }

    let outBytes = 0;
    let truncated = false;
    const outChunks: Buffer[] = [];

    term.onData((data: string) => {
      const buf = Buffer.from(data, 'utf8');
      const remaining = DEFAULT_OUTPUT_CAP_BYTES - outBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      outChunks.push(slice);
      outBytes += slice.length;
      if (buf.length > remaining) truncated = true;
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        term.kill('SIGTERM');
        // 2s grace then SIGKILL.
        setTimeout(() => {
          try {
            term.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 2000);
      } catch {
        /* already dead */
      }
    }, timeoutMs);

    term.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      const out = Buffer.concat(outChunks).toString('utf8');
      const stderrTail = timedOut ? `[somora] killed: timeout after ${timeoutMs}ms` : '';
      resolve({
        exit_code: exitCode,
        stdout: out,
        stderr: stderrTail,
        truncated,
        ms: Date.now() - start,
      });
      logger.info({
        msg: 'exec.local.sync_pty_done',
        ms: Date.now() - start,
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        truncated,
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
  /** Same semantics as LocalSyncOptions.stripSomoraInternalEnv. */
  stripSomoraInternalEnv?: boolean;
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
  if (opts.cwd) {
    const r = resolveLocalCwd(opts.cwd);
    if (!r.ok) throw new Error(r.error);
    opts = { ...opts, cwd: r.cwd };
  }
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

  const env = buildSpawnEnv(opts.env, {
    stripSomoraInternal: opts.stripSomoraInternalEnv === true,
  });
  // `detached: true` makes the wrapper shell a process-group leader —
  // same rationale as the sync path above: process({action:"kill"})
  // signals the GROUP (-pid), so shell + grandchildren die together.
  // With detached:false the kill only ever reached the wrapper sh; the
  // actual workload survived reparented to init and the job was
  // falsely marked killed (Juni-Audit 2026-06). Pipes still connect
  // normally with detached:true, so process_write/log keep working.
  const child = spawn(opts.command, {
    shell: true,
    cwd: opts.cwd,
    env,
    detached: true,
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
 *
 * Signals the process GROUP first (background jobs spawn detached:true,
 * so the wrapper shell is the group leader and `-pid` reaches shell +
 * grandchildren). Falls back to the single pid for jobs started by a
 * pre-group somora version that survived a server restart.
 */
export function killLocalJob(pid: number, signal: NodeJS.Signals): { delivered: boolean } {
  try {
    process.kill(-pid, signal);
    return { delivered: true };
  } catch {
    // No such group (ESRCH) or not permitted — try the single pid
    // before declaring the job gone.
    try {
      process.kill(pid, signal);
      return { delivered: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return { delivered: false };
      }
      throw err;
    }
  }
}
