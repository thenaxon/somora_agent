// Remote execution for the `exec` tool. Two paths:
//
// 1. Sync: thin wrapper around src/ssh/exec.ts:remoteExec — that
//    helper handles 256 KB output cap, timeout, cwd prefixing, plus
//    pty allocation when requested.
//
// 2. Background: self-sustaining process via nohup/setsid pattern.
//    The classical Linux "run this in the background and check on
//    it later" approach — wrap the command in nohup, redirect
//    stdout/stderr to files on the REMOTE host, capture PID into
//    another remote file, then disconnect. Subsequent process_*
//    actions open short-lived ssh connections to poll status
//    (`kill -0 PID` for liveness), tail logs (`tail -c -256k file`),
//    or send signals (`kill -TERM PID`). No long-lived ssh stream
//    to maintain — robust against network drops, cheap on resources.
//    See private/exec-design.md for the full story and DECISION-trail.

import { expandRemotePath, getConnection } from '../../ssh/index.ts';
import { remoteExec } from '../../ssh/index.ts';
import { resolveVisibleResourceFresh } from '../resources/visibility.ts';
import { logger } from '../../server/logger.ts';
import {
  ensureJobDir,
  newJobId,
  registerJob,
  type JobMeta,
} from './job-store.ts';
import { registerRemoteSlotRelease } from './concurrency.ts';
import type { LocalSyncResult } from './local.ts';

export interface RemoteSyncOptions {
  agent: string;
  /** Resource name (mac-studio, spiderman, ...). */
  target: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  /** Reserved for FUTURE — pty-on-remote needs ssh2 PTY allocation
   *  and shell setup. v1 ignores this when target!='local'. */
  pty?: boolean;
}

/**
 * Run a command on a configured SSH resource and return aggregated
 * stdout/stderr/exit. Reuses the existing ssh pool + remoteExec
 * helper unchanged. Resource is resolved fresh each call so newly-
 * added entries appear without a server restart (Bug-4 hot-reload).
 */
export async function remoteExecSync(opts: RemoteSyncOptions): Promise<LocalSyncResult> {
  const resource = await resolveVisibleResourceFresh(opts.agent, opts.target);
  if (!resource) {
    throw new Error(
      `exec: target '${opts.target}' is not a configured resource (or denied for this agent). ` +
        `Use resource_list to see available targets.`,
    );
  }
  if (resource.type !== 'ssh') {
    throw new Error(`exec: resource '${opts.target}' has unsupported type '${resource.type}'`);
  }
  const conn = await getConnection(opts.target, resource);
  // Expand `~`/relative cwd against the REMOTE home (same helper the
  // file tools use). The cd-prefix in remoteExec single-quotes the
  // path, which would defeat the remote shell's own tilde expansion.
  const cwd = opts.cwd ? await expandRemotePath(opts.target, resource, opts.cwd) : undefined;
  const result = await remoteExec(conn, opts.command, {
    ...(cwd ? { cwd } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.pty ? { pty: true } : {}),
  });
  logger.info({
    msg: 'exec.remote.sync_done',
    target: opts.target,
    host: resource.host,
    exit_code: result.code,
    ms: result.ms,
    truncated: result.truncated,
    command_head: opts.command.slice(0, 80),
  });
  return {
    exit_code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    ms: result.ms,
  };
}

/**
 * Background remote exec via the classical nohup-pattern. Wraps the
 * command so it survives the SSH connection dropping, captures PID
 * + output to files on the remote host, returns a job_id immediately.
 * Subsequent process_* actions open fresh short ssh connections to
 * poll/tail/kill.
 *
 * Output files live in the remote `/tmp` dir under
 * `somora-exec-<job_id>.{out,err,pid,exit}`. Cleanup is the user's
 * job — we don't auto-purge the remote tmp files (would need a
 * separate trigger). Disk impact per job is bounded only by what
 * the command itself produces.
 */
export interface RemoteBackgroundOptions {
  agent: string;
  target: string;
  command: string;
  cwd?: string;
  description?: string;
  releaseSlot?: () => void;
}

export interface RemoteBackgroundResult {
  job_id: string;
  remote_pid: number;
  remote_out_file: string;
  remote_err_file: string;
}

export async function remoteExecBackground(
  opts: RemoteBackgroundOptions,
): Promise<RemoteBackgroundResult> {
  const resource = await resolveVisibleResourceFresh(opts.agent, opts.target);
  if (!resource) {
    throw new Error(
      `exec: target '${opts.target}' is not a configured resource (or denied for this agent).`,
    );
  }
  if (resource.type !== 'ssh') {
    throw new Error(`exec: resource '${opts.target}' has unsupported type '${resource.type}'`);
  }

  const job_id = newJobId();
  const remoteOutFile = `/tmp/somora-exec-${job_id}.out`;
  const remoteErrFile = `/tmp/somora-exec-${job_id}.err`;
  const remotePidFile = `/tmp/somora-exec-${job_id}.pid`;
  const remoteExitFile = `/tmp/somora-exec-${job_id}.exit`;

  // Build the wrap-and-launch script:
  //
  //   setsid nohup sh -c '<inner>' </dev/null >/dev/null 2>&1 &   (Linux)
  //   nohup sh -c '<inner>' </dev/null >/dev/null 2>&1 &          (fallback)
  //   echo $! > pidfile
  //
  // The OUTER `&` puts the chain in the background of the SSH-driven
  // shell. nohup ignores SIGHUP so the wrapped sh keeps running when
  // we close the SSH connection. `setsid` (used when the remote has
  // it — standard on Linux, absent on macOS) makes the inner sh a
  // session/process-group LEADER, so killRemoteJob's `kill -SIG -pid`
  // takes down the whole tree: sh + the (command) subshell +
  // grandchildren. Without it (macOS fallback) only the inner sh is
  // addressable and a kill leaves the workload running — the
  // pre-2026-07-21 behavior on all targets (Juni-Audit 2026-06).
  //
  // The inner sh script writes its OWN PID to pidfile via $$ (= more
  // reliable than $! which captures nohup's PID, not the long-lived
  // sh's), redirects its stdio to the log files, runs the command,
  // and writes the exit code to exitfile.
  //
  // We capture the inner PID via the second-to-last write — small
  // sleep gives the inner sh enough time to actually fork and write
  // its $$ before we read it.
  // Same `~`/relative-cwd expansion as the sync path — the single-
  // quoted cd prefix below would otherwise look for a literal `~` dir.
  const cwd = opts.cwd ? await expandRemotePath(opts.target, resource, opts.cwd) : undefined;
  // `|| exit 97` — a failed cd must ABORT the inner script. The old
  // `cd X && ` prefix only bound the cd to the pidfile-write; the
  // script then carried on and ran the command in $HOME while the
  // launcher reported failure — an untracked double-execution
  // (Juni-Audit 2026-06).
  const cwdPrefix = cwd ? `cd ${shellQuote(cwd)} || exit 97; ` : '';
  const innerScript =
    `${cwdPrefix}` +
    // Write our own PID first so the outer caller can grab it.
    `echo $$ > ${remotePidFile}; ` +
    // Run the command with stdio redirected to the log files. The
    // exec redirection persists for the rest of the script which is
    // exactly the command + exit write.
    `exec > ${remoteOutFile} 2> ${remoteErrFile} < /dev/null; ` +
    `(${opts.command}); ` +
    `echo $? > ${remoteExitFile}`;
  const quotedInner = `sh -c '${innerScript.replace(/'/g, `'\\''`)}' </dev/null >/dev/null 2>&1`;
  const launcher =
    `if command -v setsid >/dev/null 2>&1; then setsid nohup ${quotedInner} & ` +
    `else nohup ${quotedInner} & fi; ` +
    // Tiny sleep so inner sh has time to write its $$ before we read
    // pidfile. 100ms is enough on any machine that's responsive
    // enough to run somora at all.
    `sleep 0.1; ` +
    `cat ${remotePidFile}`;

  const conn = await getConnection(opts.target, resource);
  const launchResult = await remoteExec(conn, launcher, { timeoutMs: 10_000 });

  if (launchResult.code !== 0) {
    throw new Error(
      `exec: remote-background launcher failed on ${opts.target} (exit ${launchResult.code}): ` +
        `${launchResult.stderr.slice(0, 300)}`,
    );
  }
  const pidStr = launchResult.stdout.trim();
  const remote_pid = parseInt(pidStr, 10);
  if (!Number.isFinite(remote_pid) || remote_pid <= 0) {
    throw new Error(
      `exec: remote-background launcher returned non-numeric PID: ${JSON.stringify(pidStr)}`,
    );
  }

  // Persist meta locally — same shape as local-bg, with target=resource
  // and pid=remote_pid. Logs live on the REMOTE host; we don't
  // duplicate them locally. process({action:"log", ...}) will fetch
  // tails on demand via short-lived ssh exec calls.
  const meta: JobMeta = {
    job_id,
    agent: opts.agent,
    target: opts.target,
    command: opts.command,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    started_at: Date.now(),
    state: 'running',
    pid: remote_pid,
  };
  await ensureJobDir(opts.agent, job_id);
  await registerJob(meta);

  // Hand the slot-release callback to the in-process registry so
  // poll(detected-completion) and kill paths can free the slot.
  // Without this the cap counter would leak — remote jobs have no
  // local child.on('close') hook to drive automatic release.
  if (opts.releaseSlot) {
    registerRemoteSlotRelease(job_id, opts.releaseSlot);
  }

  logger.info({
    msg: 'exec.remote.background_started',
    job_id,
    agent: opts.agent,
    target: opts.target,
    remote_pid,
  });

  return {
    job_id,
    remote_pid,
    remote_out_file: remoteOutFile,
    remote_err_file: remoteErrFile,
  };
}

/**
 * Check whether a remote-background job is still running. Opens a
 * short-lived ssh connection, runs `kill -0 PID && cat exit-file`,
 * returns one of: still-running | ended-clean | ended-failed.
 *
 * Caller (process tool) uses this to update the job's meta.json
 * state from 'running' to 'done'/'failed' when the remote process
 * finishes.
 */
export interface RemotePollResult {
  alive: boolean;
  exit_code: number | null;
}

export async function pollRemoteJob(
  agent: string,
  target: string,
  remotePid: number,
  jobId: string,
): Promise<RemotePollResult> {
  const resource = await resolveVisibleResourceFresh(agent, target);
  if (!resource) {
    throw new Error(`exec.poll: target '${target}' no longer configured`);
  }
  if (resource.type !== 'ssh') {
    throw new Error(`exec.poll: target '${target}' has wrong type`);
  }
  const exitFile = `/tmp/somora-exec-${jobId}.exit`;
  // kill -0 returns 0 if the pid exists and we have permission to
  // signal it, non-zero otherwise (with stderr 'No such process'
  // when the pid is gone). We chain it with a probe of the exit
  // file so we can resolve "alive vs cleanly-ended-with-code-X" in
  // one round-trip.
  const conn = await getConnection(target, resource);
  const probe = `if kill -0 ${remotePid} 2>/dev/null; then echo ALIVE; else if [ -r ${exitFile} ]; then echo ENDED:$(cat ${exitFile}); else echo GONE; fi; fi`;
  const r = await remoteExec(conn, probe, { timeoutMs: 5_000 });
  const out = r.stdout.trim();
  if (out === 'ALIVE') {
    return { alive: true, exit_code: null };
  }
  if (out === 'GONE') {
    // Process not running and no exit-file — likely killed externally
    // or never wrote the exit marker (e.g. SIGKILL'd before reaching
    // the exit-write line). Treat as failed without exit code.
    return { alive: false, exit_code: null };
  }
  if (out.startsWith('ENDED:')) {
    const code = parseInt(out.slice('ENDED:'.length), 10);
    return { alive: false, exit_code: Number.isFinite(code) ? code : null };
  }
  // Something we didn't expect — log and treat as still running so
  // we don't false-finish a job. Next poll will retry.
  logger.warn({
    msg: 'exec.remote.poll_unrecognized',
    job_id: jobId,
    target,
    output: out.slice(0, 100),
  });
  return { alive: true, exit_code: null };
}

export interface RemoteLogTail {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Fetch the tails of a remote job's stdout + stderr files via a
 * short-lived ssh connection. `tail -c -<n>` returns the last <n>
 * bytes — same 256 KB cap as local logs.
 */
export async function tailRemoteJobLog(
  agent: string,
  target: string,
  jobId: string,
  maxBytesPerStream: number = 256 * 1024,
): Promise<RemoteLogTail> {
  const resource = await resolveVisibleResourceFresh(agent, target);
  if (!resource) {
    throw new Error(`exec.log: target '${target}' no longer configured`);
  }
  if (resource.type !== 'ssh') {
    throw new Error(`exec.log: target '${target}' has wrong type`);
  }
  const outFile = `/tmp/somora-exec-${jobId}.out`;
  const errFile = `/tmp/somora-exec-${jobId}.err`;
  const conn = await getConnection(target, resource);
  // Run both tails in parallel via a single shell so we save a
  // round-trip. Marker lines bracket each stream so we can split
  // the combined output even if one stream is empty.
  // `printf '\n'` before each END marker: when the log doesn't end in
  // a newline (live mid-line output, `printf` without \n), the marker
  // would glue onto the last line and the split-regex below — which
  // requires `\n---…END---` — silently matched nothing, so live
  // output read as "no output" (Juni-Audit 2026-06). The extra \n is
  // absorbed by the non-greedy capture when the log DID end cleanly.
  const cmd =
    `echo '---SOMORA_STDOUT_BEGIN---'; ` +
    `tail -c -${maxBytesPerStream} ${outFile} 2>/dev/null || true; ` +
    `printf '\\n---SOMORA_STDOUT_END---\\n'; ` +
    `echo '---SOMORA_STDERR_BEGIN---'; ` +
    `tail -c -${maxBytesPerStream} ${errFile} 2>/dev/null || true; ` +
    `printf '\\n---SOMORA_STDERR_END---\\n'`;
  const r = await remoteExec(conn, cmd, {
    timeoutMs: 10_000,
    maxOutputBytes: maxBytesPerStream * 2 + 1024,
  });
  const out = r.stdout;
  const stdoutMatch = /---SOMORA_STDOUT_BEGIN---\n([\s\S]*?)\n---SOMORA_STDOUT_END---/.exec(out);
  const stderrMatch = /---SOMORA_STDERR_BEGIN---\n([\s\S]*?)\n---SOMORA_STDERR_END---/.exec(out);
  return {
    stdout: stdoutMatch?.[1] ?? '',
    stderr: stderrMatch?.[1] ?? '',
    truncated: r.truncated,
  };
}

/**
 * Send a signal to a remote job's PID. Short-lived ssh exec.
 * `kill` returns 0 on success, non-zero if the PID is gone or
 * permission denied.
 */
export async function killRemoteJob(
  agent: string,
  target: string,
  remotePid: number,
  signal: string,
): Promise<{ delivered: boolean }> {
  const resource = await resolveVisibleResourceFresh(agent, target);
  if (!resource) {
    return { delivered: false };
  }
  if (resource.type !== 'ssh') {
    return { delivered: false };
  }
  const conn = await getConnection(target, resource);
  // Group kill first: on hosts with `setsid` (Linux) the launcher made
  // the inner sh a session/group leader, so `-PID` reaches the whole
  // tree (sh + workload subshell + grandchildren). The plain-PID kill
  // after it covers the no-setsid fallback (macOS) and pre-setsid
  // jobs — there it only reaches the wrapper sh, which is the best a
  // remote signal can do without a group.
  const r = await remoteExec(conn, `kill -${signal} -- -${remotePid} 2>/dev/null; kill -${signal} ${remotePid} 2>/dev/null; echo DONE`, {
    timeoutMs: 5_000,
  });
  return { delivered: r.stdout.trim().endsWith('DONE') };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
