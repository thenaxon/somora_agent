// Remote `exec` helper — runs a command over an established ssh2
// Client and returns aggregated stdout/stderr/exit. Used today by
// resource_test (uptime probe); the future exec tool's remote path
// goes through here too.
//
// Output is byte-capped to prevent a runaway command from blowing
// memory; if the cap is hit we truncate and mark the result.

import type { Client } from 'ssh2';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
/** After the remote shell exited: how long to wait for the channel to
 *  close before concluding a background process holds it open. */
export const HELD_OPEN_GRACE_MS = 3_000;

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
    ? `cd ${shellQuoteCwd(opts.cwd)} && ${command}`
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
      let done = false;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let afterExitTimer: NodeJS.Timeout | undefined;

      // One way out, whichever comes first: the channel closes (normal
      // end), the deadline passes, or the command exited but a process
      // it left in the background still holds stdout/stderr open — the
      // channel would then stay open until that process ends.
      const finish = (how: 'closed' | 'timeout' | 'held-open', code: number | null, signal: string | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (afterExitTimer) clearTimeout(afterExitTimer);
        if (how !== 'closed') {
          try {
            if (how === 'timeout') stream.signal('KILL');
            stream.close();
          } catch {
            /* best-effort */
          }
        }
        const ms = Date.now() - start;
        const result: RemoteExecResult = {
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          code: how === 'timeout' ? null : code,
          signal: how === 'timeout' ? 'TIMEOUT' : signal,
          truncated,
          ms,
        };
        if (how === 'timeout') {
          result.stderr = `${result.stderr}\n[somora] command exceeded ${timeoutMs}ms — stopped and the channel closed after ${ms}ms. Processes it started in the background on the remote may still be running.`;
        } else if (how === 'held-open') {
          result.stderr =
            `${result.stderr}\n[somora] the command exited (code ${code ?? 'none'}), but a process it left in the background still held its output open — returned without waiting. ` +
            'That process keeps running. To detach cleanly: `nohup cmd </dev/null >/tmp/cmd.log 2>&1 &`, or use background: true.';
        }
        resolve(result);
      };

      const timer = setTimeout(() => finish('timeout', null, null), timeoutMs);

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
      // The remote shell reports its exit status before the channel
      // closes. Normally 'close' follows at once; if it does not within
      // a few seconds, something the command left in the background
      // still holds the output open, and waiting would block until it
      // ends (or the connection idles out).
      stream.on('exit', (code: number | null, signal?: string | null) => {
        exitCode = code;
        exitSignal = signal ?? null;
        afterExitTimer = setTimeout(() => finish('held-open', exitCode, exitSignal), HELD_OPEN_GRACE_MS);
      });
      stream.on('close', (code: number | null, signal: string | null) => {
        finish('closed', code ?? exitCode, signal ?? exitSignal);
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

/**
 * Quote a cwd for a `cd` prefix while keeping `~` functional. Tilde
 * expansion only happens when the word STARTS with an unquoted `~`,
 * so `cd '~/x'` looks for a literal directory named `~` — the same
 * trap as the local-spawn path (2026-06-10 ada feedback). Leave the
 * leading `~`/`~/` bare and quote only the rest.
 */
export function shellQuoteCwd(s: string): string {
  if (s === '~') return '~';
  if (s.startsWith('~/')) return `~/${shellQuote(s.slice(2))}`;
  return shellQuote(s);
}
