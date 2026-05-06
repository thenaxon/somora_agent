// Remote `exec` helper — runs a command over an established ssh2
// Client and returns aggregated stdout/stderr/exit. Used today by
// resource_test (uptime probe); the future exec tool's remote path
// goes through here too.
//
// Output is byte-capped to prevent a runaway command from blowing
// memory; if the cap is hit we truncate and mark the result.

import type { Client } from 'ssh2';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  truncated: boolean;
  ms: number;
}

export interface RemoteExecOptions {
  /** Hard timeout in ms — exit-via-killing if exceeded. Default 60_000. */
  timeoutMs?: number;
  /** Max bytes of stdout+stderr to retain. Default 256 KB. */
  maxOutputBytes?: number;
  /** Optional cwd via `cd <dir> && <cmd>`. ssh2 has no exec.cwd, so we
   *  prefix; assumes a sh-compatible remote shell (bash/zsh/dash). */
  cwd?: string;
  /** Allocate a pseudo-terminal on the remote so TUI tools and tools
   *  that check isatty() (vim, htop, claude, codex, anything with
   *  color/cursor handling) work correctly. ssh2 supports this
   *  natively as the second arg to client.exec. Default false —
   *  unnecessary overhead for non-TUI commands plus combines stdout
   *  and stderr into one stream when on. */
  pty?: boolean;
}

export async function remoteExec(
  client: Client,
  command: string,
  opts: RemoteExecOptions = {},
): Promise<RemoteExecResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const start = Date.now();
  const wrapped = opts.cwd
    ? `cd ${shellQuote(opts.cwd)} && ${command}`
    : command;

  // ssh2's exec accepts a second arg for stream config, including
  // pty allocation. When pty is true, a default pty is allocated;
  // we could pass detailed term/rows/cols if we cared but the
  // default xterm 80x24 is fine for most TUI tools.
  const execOpts = opts.pty ? { pty: true as const } : undefined;

  return new Promise<RemoteExecResult>((resolve, reject) => {
    const onChannel = (
      err: Error | undefined,
      stream: import('ssh2').ClientChannel,
    ): void => {
      if (err) {
        reject(err);
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          stream.signal('KILL');
          stream.end();
        } catch {
          /* best-effort */
        }
      }, timeoutMs);

      const onData = (data: Buffer, sink: Buffer[]): void => {
        if (truncated) return;
        if (totalBytes + data.byteLength > cap) {
          const remaining = cap - totalBytes;
          if (remaining > 0) sink.push(data.subarray(0, remaining));
          totalBytes = cap;
          truncated = true;
        } else {
          sink.push(data);
          totalBytes += data.byteLength;
        }
      };

      stream.on('data', (d: Buffer) => onData(d, stdoutChunks));
      // With pty:true, ssh2 doesn't expose a separate stderr stream
      // (the pty merges stdout+stderr into one TTY stream — same
      // behaviour you'd see at a real terminal). When pty is off we
      // get the usual two-stream split.
      if (stream.stderr) {
        stream.stderr.on('data', (d: Buffer) => onData(d, stderrChunks));
      }
      stream.on('close', (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        const result: RemoteExecResult = {
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          code: timedOut ? null : code,
          signal: timedOut ? 'TIMEOUT' : signal,
          truncated,
          ms: Date.now() - start,
        };
        if (timedOut) {
          result.stderr = `${result.stderr}\n[somora] command exceeded ${timeoutMs}ms — killed`;
        }
        resolve(result);
      });
    };
    if (execOpts) {
      client.exec(wrapped, execOpts, onChannel);
    } else {
      client.exec(wrapped, onChannel);
    }
  });
}

/** Single-quote a value for sh — escape any embedded single quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
