// Local tmux command helpers. Each function builds + runs a single
// tmux command on the somora server's machine via the local exec
// helper. tmux sessions persist across separate calls — that's the
// whole point: spawn once with create, drive it via send/capture
// over many tool calls, kill when done.
//
// All `-t` targets are `=name`-prefixed: tmux otherwise falls back to
// PREFIX matching when the exact name doesn't exist, so a send/kill
// aimed at a vanished `build` could silently hit its sibling
// `build-deploy` (Juni-Audit 2026-06). `=` forces exact-match-or-error.
// Nuance (verified on tmux 3.5a): send-keys/capture-pane take a
// target-PANE — there `=name` alone fails to resolve; the session part
// must be delimited, so pane targets use `=name:` (exact session,
// default window.pane). kill-session takes a target-session where the
// bare `=name` form is correct.
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
 *     end. the bug report 2026-05-06: without this, a multi-line message
 *     into Claude Code got chunked into N separate submissions.
 *
 * Submit-gap (bug 10 from 2026-05-07): coding TUIs do paste-burst
 * detection. When the trailing CR arrives in the same input event tick
 * as preceding text, codex (and likely others) treat it as part of the
 * paste and suppress the submit. We insert a `sleep 0.1` between the
 * preceding keystrokes and the final Enter so it's seen as a real
 * submit. Skipped when there's no preceding content (bare "\n"
 * submits on its own).
 */
function buildSendKeysScript(name: string, keys: string, multilineSafe: boolean): string {
  // Strip a trailing \n before splitting so the last embedded newline
  // doesn't get emitted as M-Enter and then immediately followed by a
  // plain Enter — that double-keystroke leaves the input cursor in a
  // soft-newlined empty line and Codex (and likely other strict TUIs)
  // refuse to submit. the bug report 2026-05-07: `multiline_safe:true` with
  // trailing `\n` rendered the prompt but never submitted in codex.
  const endsWithNewline = keys.endsWith('\n');
  const body = endsWithNewline ? keys.slice(0, -1) : keys;
  const parts = body.split('\n');
  const cmds: string[] = [];
  parts.forEach((part, idx) => {
    if (part.length > 0) {
      // `--` ends tmux's flag-scan so a leading `-` in the literal text
      // (Markdown bullets `- Item`, command flags being typed) isn't
      // mistaken for a flag — the bug report 2026-05-06: `multiline_safe:true`
      // with `\n- Bullet A` failed with `command send-keys: invalid flag -`.
      cmds.push(`tmux send-keys -t ${shQuote(`=${name}:`)} -l -- ${shQuote(part)}`);
    }
    if (idx < parts.length - 1) {
      // Embedded newline (not the trailing one — that was stripped above).
      // multiline_safe → soft-newline (M-Enter).
      const keyName = multilineSafe ? 'M-Enter' : 'Enter';
      cmds.push(`tmux send-keys -t ${shQuote(`=${name}:`)} ${keyName}`);
    }
  });
  // Re-add the stripped trailing \n as a plain Enter so the message
  // submits — even in multiline_safe mode the trailing \n submits.
  // Coding TUIs (codex, claude-code, …) do paste-burst detection: if
  // literal text and the trailing CR arrive in the same input event
  // tick, the CR is treated as part of the paste and submit is
  // suppressed. A short gap between the preceding keystrokes and the
  // final Enter forces it to be seen as a real submit. ~50ms is enough
  // empirically; we use 100ms for headroom. Skip the gap when there's
  // no preceding content (bare "\n" submits fine on its own).
  // bug 10 (2026-05-07): trailing-\n submits never fired in
  // codex without this gap; verified live in codex 0.128.0.
  if (endsWithNewline) {
    if (cmds.length > 0) {
      cmds.push('sleep 0.1');
    }
    cmds.push(`tmux send-keys -t ${shQuote(`=${name}:`)} Enter`);
  }
  return cmds.join(' && ');
}

export interface TmuxLocalCreateOptions {
  name: string;
  cwd?: string;
  /** When false (default), the new session starts with somora-internal
   *  env vars (CLAUDE_CONFIG_DIR, SOMORA_CLAUDE_BIN) stripped via a
   *  shell wrapper, so a `claude` / `codex` invocation inside the pane
   *  behaves like in the user's normal terminal. Set true to inherit
   *  somora's full env — only useful when the agent intentionally
   *  wants the isolated claude-cli tree visible inside the session. */
  inheritAgentEnv?: boolean;
}

export interface TmuxResult {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

async function runTmux(
  command: string,
  timeoutMs: number = 10_000,
  stripSomoraInternalEnv: boolean = false,
): Promise<TmuxResult> {
  const r = await localExecSync({ command, timeoutMs, stripSomoraInternalEnv });
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
  let cmd: string;
  if (opts.inheritAgentEnv) {
    // Inherit somora-internal vars EXPLICITLY via `-e KEY=VALUE`. The
    // tmux server's own env (which it captured at first-spawn time)
    // may or may not still contain them; `-e` makes the result
    // deterministic regardless of when the server was started. Only
    // forward each var when the somora process has it — `-e KEY=` on
    // an undefined value would set empty-string, which is worse than
    // not setting it (still trips "is var set?" checks).
    const explicit: string[] = [];
    if (process.env.CLAUDE_CONFIG_DIR) {
      explicit.push(`-e ${shQuote(`CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}`)}`);
    }
    if (process.env.SOMORA_CLAUDE_BIN) {
      explicit.push(`-e ${shQuote(`SOMORA_CLAUDE_BIN=${process.env.SOMORA_CLAUDE_BIN}`)}`);
    }
    const eFlags = explicit.length > 0 ? ' ' + explicit.join(' ') : '';
    cmd = `tmux new-session -d -s ${shQuote(opts.name)}${cwdFlag}${eFlags}`;
  } else {
    // Default behavior: strip somora-internal claude-isolation env vars
    // so a `claude` / `codex` started inside the pane sees the user's
    // normal login state instead of somora's isolated tree. This needs
    // a session-wrapper because tmux inherits env from the long-lived
    // tmux server process, not from the `tmux new-session` caller —
    // `-e VAR=` would set the var to empty-string (still "set"), so we
    // use `unset` + `exec` to truly remove it before user's shell takes
    // over. Confirmed via env-dump probe 2026-05-17.
    const wrapper = `unset CLAUDE_CONFIG_DIR SOMORA_CLAUDE_BIN; exec "\${SHELL:-/bin/bash}"`;
    cmd = `tmux new-session -d -s ${shQuote(opts.name)}${cwdFlag} ${shQuote(wrapper)}`;
  }
  // Also strip on the spawn-env path in case this call boots a fresh
  // tmux server (whose subsequent sessions would otherwise inherit
  // the dirty env too). Cheap belt-and-braces.
  logger.info({
    msg: 'tmux.local.create',
    name: opts.name,
    cwd: opts.cwd,
    inheritAgentEnv: opts.inheritAgentEnv === true,
  });
  return runTmux(cmd, 10_000, !opts.inheritAgentEnv);
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

/** Send one or more tmux key events by symbolic name (Escape, C-c, F1, …).
 *  Caller is expected to have validated `key` against KEY_TOKEN_RE — see
 *  validateTmuxKey() in tools.ts. We pass the tokens through to tmux's
 *  native key parser without `-l`, so it recognizes them as key events
 *  (not literal text). This is the reliable way to deliver control bytes
 *  to a TUI: encoding raw \x1b in JSON is brittle (LLMs often emit it as
 *  literal `\x1b` chars instead of the proper `` escape, ending up
 *  typed as text in the input field). the tmux-control-keys bug
 *  2026-05-07. */
export async function tmuxLocalSendKey(name: string, key: string): Promise<TmuxResult> {
  const tokens = key.trim().split(/\s+/);
  const cmd = `tmux send-keys -t ${shQuote(`=${name}:`)} ${tokens.join(' ')}`;
  logger.info({ msg: 'tmux.local.send_key', name, key });
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
  const cmd = `tmux capture-pane -t ${shQuote(`=${opts.name}:`)} -p${ansiFlag} -S -${lines}`;
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
  const cmd = `tmux kill-session -t ${shQuote(`=${name}`)}`;
  logger.info({ msg: 'tmux.local.kill', name });
  return runTmux(cmd);
}
