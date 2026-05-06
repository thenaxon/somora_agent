// Local tmux command helpers. Each function builds + runs a single
// tmux command on the somora server's machine via the local exec
// helper. tmux sessions persist across separate calls — that's the
// whole point: spawn once with create, drive it via send/capture
// over many tool calls, kill when done.
//
// Why tmux + not direct shell: the agent often wants to interact
// with a long-running TUI tool (claude --dangerously-skip-permissions,
// codex, vim, REPL) over many turns. tmux gives us a persistent
// terminal session whose state survives between our tool calls;
// without it we'd need a long-lived child process and a way to
// re-attach which is exactly what tmux already solves.

import { localExecSync } from '../exec/local.ts';
import { logger } from '../../server/logger.ts';

const DEFAULT_CAPTURE_LINES = 200;

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the multi-step send-keys command sequence for a possibly
 * multi-line keys string. tmux's `send-keys -l` flag treats its
 * argument as literal characters; a separate keypress arg
 * (`Enter`, `M-Enter`, …) sends a real key event. We split the
 * input on \n and chain a literal + key for each segment so
 * special characters (quotes, dollar signs, etc) don't get mis-
 * interpreted by tmux's key lexer.
 *
 * `multilineSafe` controls how embedded \n are sent:
 *   - false (default): every \n becomes a plain Enter — what shells
 *     expect to actually run a command.
 *   - true: every \n EXCEPT the trailing one becomes M-Enter
 *     (Esc+CR, the soft-newline convention in modern coding TUIs:
 *     Claude Code, codex, IPython, fish, jupyter, Slack-style input
 *     boxes). The TUI treats it as a real linebreak inside its
 *     input field instead of submitting. A trailing \n still becomes
 *     a plain Enter, so a multi-line message still submits at the
 *     end. Hans's bug 2026-05-06: without this, a multi-line message
 *     into Claude Code got chunked into N separate submissions.
 */
function buildSendKeysScript(name: string, keys: string, multilineSafe: boolean): string {
  const parts = keys.split('\n');
  const cmds: string[] = [];
  parts.forEach((part, idx) => {
    if (part.length > 0) {
      cmds.push(`tmux send-keys -t ${shQuote(name)} -l ${shQuote(part)}`);
    }
    if (idx < parts.length - 1) {
      // Non-final newline. multiline_safe → soft-newline (M-Enter).
      const keyName = multilineSafe ? 'M-Enter' : 'Enter';
      cmds.push(`tmux send-keys -t ${shQuote(name)} ${keyName}`);
    }
  });
  // If the original input ended with \n we already split it so the
  // last part is an empty string and the loop above skipped the
  // final Enter. Re-add it as a plain Enter — even in multiline_safe
  // mode the trailing \n still submits.
  if (keys.endsWith('\n')) {
    cmds.push(`tmux send-keys -t ${shQuote(name)} Enter`);
  }
  return cmds.join(' && ');
}

export interface TmuxLocalCreateOptions {
  name: string;
  cwd?: string;
}

export interface TmuxResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

async function runTmux(command: string, timeoutMs: number = 10_000): Promise<TmuxResult> {
  const r = await localExecSync({ command, timeoutMs });
  return {
    ok: r.exit_code === 0,
    exit_code: r.exit_code,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

export async function tmuxLocalCreate(opts: TmuxLocalCreateOptions): Promise<TmuxResult> {
  // -d = detached (no attach), -s = session name. -A would attach if
  // exists; we want explicit failure on duplicate so the model knows
  // the session is already there and can decide (use existing or pick
  // a different name).
  const cwdFlag = opts.cwd ? ` -c ${shQuote(opts.cwd)}` : '';
  const cmd = `tmux new-session -d -s ${shQuote(opts.name)}${cwdFlag}`;
  logger.info({ msg: 'tmux.local.create', name: opts.name, cwd: opts.cwd });
  return runTmux(cmd);
}

export async function tmuxLocalSend(
  name: string,
  keys: string,
  multilineSafe = false,
): Promise<TmuxResult> {
  const cmd = buildSendKeysScript(name, keys, multilineSafe);
  if (!cmd) {
    return { ok: true, exit_code: 0, stdout: '', stderr: '' };
  }
  logger.info({ msg: 'tmux.local.send', name, keys_len: keys.length, multilineSafe });
  return runTmux(cmd);
}

export interface TmuxLocalCaptureOptions {
  name: string;
  /** How many lines from the end of the pane history to grab. tmux's
   *  capture-pane -S -<N> "start N lines back from the bottom".
   *  Default 200 — enough to grab the typical scrollback after a
   *  multi-step interaction without being huge. */
  lines?: number;
  /** When true, pass `-e` to capture-pane so ANSI escape sequences
   *  (colors, dim/bold attributes, cursor moves) are preserved in
   *  the output. Used for distinguishing dim auto-suggestion text
   *  from real input in coding TUIs. Default false (escapes
   *  stripped, easier to match against). */
  includeAnsi?: boolean;
}

export async function tmuxLocalCapture(opts: TmuxLocalCaptureOptions): Promise<TmuxResult> {
  const lines = opts.lines ?? DEFAULT_CAPTURE_LINES;
  // -p = print to stdout. -S -<N> = start N lines back. -E = stop at
  // current visible bottom (default). -e adds ANSI escape sequences.
  const ansiFlag = opts.includeAnsi ? ' -e' : '';
  const cmd = `tmux capture-pane -t ${shQuote(opts.name)} -p${ansiFlag} -S -${lines}`;
  return runTmux(cmd);
}

export async function tmuxLocalList(): Promise<{
  ok: boolean;
  sessions: Array<{ name: string; created_at: number; windows: number }>;
}> {
  // Custom format so we don't have to parse the human-readable
  // output. Pipe-separated fields = simple split.
  const cmd = `tmux list-sessions -F '#{session_name}|#{session_created}|#{session_windows}' 2>/dev/null || true`;
  const r = await runTmux(cmd);
  // No sessions = tmux exits non-zero with "no server running" on
  // stderr; we mask that with `|| true` above and treat empty
  // stdout as "no sessions".
  if (!r.stdout.trim()) {
    return { ok: true, sessions: [] };
  }
  const sessions = r.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [name, created, windows] = line.split('|');
      return {
        name: name ?? '',
        created_at: parseInt(created ?? '0', 10) * 1000,
        windows: parseInt(windows ?? '0', 10),
      };
    })
    .filter((s) => s.name.length > 0);
  return { ok: true, sessions };
}

export async function tmuxLocalKill(name: string): Promise<TmuxResult> {
  const cmd = `tmux kill-session -t ${shQuote(name)}`;
  logger.info({ msg: 'tmux.local.kill', name });
  return runTmux(cmd);
}
