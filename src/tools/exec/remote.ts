// Remote execution for the `exec` tool. Sync-only in v1; background
// remote-exec needs a long-lived ssh stream lifecycle that's
// non-trivial (stay-alive, capture pid for kill, stream stdout to
// local disk file across reconnects). Marked as FUTURE — see
// private/exec-design.md "loose-end #1". When attempted, we throw
// a clear error so the model can fall back to sync.
//
// Sync remote exec is a thin wrapper around src/ssh/exec.ts:remoteExec
// — that helper already handles 256 KB output cap, timeout, cwd
// prefixing. This file just resolves the resource and surfaces the
// result in the same shape as localExecSync.

import { getConnection } from '../../ssh/index.ts';
import { remoteExec } from '../../ssh/index.ts';
import { resolveVisibleResourceFresh } from '../resources/visibility.ts';
import { logger } from '../../server/logger.ts';
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
  const result = await remoteExec(conn, opts.command, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
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
 * Background remote exec is intentionally not implemented in v1.
 * Throwing here keeps the tool handler simple and gives the model a
 * clear hint about the supported alternative.
 */
export function remoteExecBackgroundUnsupported(): never {
  throw new Error(
    'exec: background:true is not supported on remote targets in v1. ' +
      'Run sync (omit background) or open a tmux session on the target ' +
      'and use tmux_* tools (Phase 5b) for long-running commands.',
  );
}
