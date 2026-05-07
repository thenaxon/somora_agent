// `tmux` tool — Phase 5b. Single tool with action enum so the model
// can drive long-lived terminal sessions on local or on a configured
// SSH resource.
//
// Use-case: spawn an interactive TUI tool (claude --dangerously-skip-
// permissions, codex, vim, REPL) once, then drive it across many
// agent turns. Persistent state survives between tool calls because
// tmux's session keeps the underlying process alive.
//
// vs `exec`: exec is for one-shot commands (sync) or detached
// background jobs. tmux is when you NEED an actual terminal session
// you can come back to later. Two distinct use-cases, both valid.

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import type { ToolDefinition } from '../types.ts';
import {
  tmuxLocalCapture,
  tmuxLocalCreate,
  tmuxLocalKill,
  tmuxLocalList,
  tmuxLocalSend,
  tmuxLocalSendKey,
} from './local.ts';
import {
  tmuxRemoteCapture,
  tmuxRemoteCreate,
  tmuxRemoteKill,
  tmuxRemoteList,
  tmuxRemoteSend,
  tmuxRemoteSendKey,
} from './remote.ts';

// One or more tmux key tokens separated by whitespace. Each token is
// `[A-Za-z0-9_-]+` — covers tmux's full key-name vocabulary (Escape,
// Enter, BSpace, Tab, F1..F12, Up/Down/…, modifier-prefixed like C-c,
// M-Enter, S-Tab, C-M-Enter) and excludes shell metacharacters so the
// validated value is safe to interpolate into the shell command.
const KEY_TOKEN_RE = /^[A-Za-z0-9_-]+(\s+[A-Za-z0-9_-]+)*$/;

const POLL_INTERVAL_MS = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 600_000; // 10 min — same ceiling as longTaskMax
const DEFAULT_IDLE_STABLE_MS = 500;

const TmuxInput = z
  .object({
    action: z
      .enum(['create', 'send', 'capture', 'list', 'kill'])
      .describe(
        'create (new session) | send (keys to existing session) | capture (read pane content) | ' +
          'list (sessions on target) | kill (remove session).',
      ),
    target: z
      .string()
      .min(1)
      .default('local')
      .describe(
        '"local" (default) = the somora server\'s machine. Otherwise a configured resource ' +
          'name from resource_list. tmux must be installed on the target — Standard on most ' +
          'macOS/Linux boxes; install via `brew install tmux` / `apt install tmux` if missing.',
      ),
    name: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Session name. Required for create/send/capture/kill. Convention: meaningful slug ' +
          '(e.g. "claude-bugfix-auth", "codex-experiment-1") so list output is readable. ' +
          'Allowed: alphanumerics + dash + underscore; tmux rejects most other characters.',
      ),
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe(
        'create only — initial working directory for the session\'s shell. Useful when the ' +
          'TUI tool you spawn cares about cwd (claude/codex usually do).',
      ),
    keys: z
      .string()
      .optional()
      .describe(
        'send only — text to type into the session. By default, newlines (\\n) are sent as ' +
          'Enter keypresses (CR), which is what shells expect — append \\n to actually run a ' +
          'shell command. For interactive TUIs (claude --dangerously-skip-permissions, codex, ' +
          'IPython, jupyter input boxes, etc.) where Enter SUBMITS the message, set ' +
          '`multiline_safe: true` so embedded \\n becomes a soft-newline instead of a submit. ' +
          'For control / function / modifier keys (Escape, Ctrl-C, Ctrl-U, F1, arrow keys, …) ' +
          'use the `key` field instead — JSON-encoding raw control bytes is brittle.',
      ),
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(
        KEY_TOKEN_RE,
        'key: only [A-Za-z0-9_-] tokens, optionally space-separated (e.g. "Escape", "C-c", "F1", "C-x C-c")',
      )
      .optional()
      .describe(
        'send only — one or more tmux key names, space-separated. Use this for keys that are ' +
          'hard to type as text: Escape, C-c, C-u, C-d, BSpace, Tab, F1..F12, Up/Down/Left/Right, ' +
          'Home/End/PgUp/PgDn, modifier-prefixed (C- = Ctrl, M- = Meta/Alt, S- = Shift; ' +
          'combinable: C-M-Enter). tmux delivers them as real key events, not text bytes — ' +
          'reliable across TUIs (codex/claude-code/etc) for "interrupt running task" (Escape), ' +
          '"abort" (C-c), "clear input line" (C-u). Mutually exclusive with `keys` — pass one ' +
          'or the other per call. Multi-key example: `key: "C-x C-c"` sends Ctrl-X then Ctrl-C.',
      ),
    multiline_safe: z
      .boolean()
      .default(false)
      .describe(
        'send only — when true, embedded \\n in `keys` is sent as M-Enter (Esc+CR / Alt+Enter) ' +
          'instead of a literal Enter. M-Enter is the soft-newline convention in modern input ' +
          'TUIs (Claude Code, codex, IPython, fish, Slack-style input boxes etc.) — the message ' +
          'gets a real linebreak without being submitted. The LAST character of `keys` is still ' +
          'sent as Enter when it\'s a \\n, so a trailing newline still submits. Default false ' +
          '(plain Enter for shell use). Use this when a single send carries a multi-line ' +
          'message into a TUI that auto-submits on Enter.',
      ),
    wait_pattern: z
      .string()
      .min(1)
      .optional()
      .describe(
        'capture only — string to wait for in the pane content. Capture polls every 200ms ' +
          'until matched OR wait_timeout_ms elapses. Without wait_pattern, capture returns the ' +
          'current pane content immediately. The match semantic is controlled by `wait_mode` — ' +
          'see that field; the right choice depends on whether you\'re driving a Shell or a ' +
          'TUI session.',
      ),
    wait_mode: z
      .enum(['auto', 'present', 'idle'])
      .default('auto')
      .describe(
        'capture only — how `wait_pattern` matches. `auto` (default): smart for SHELL sessions ' +
          '— matches when pattern occurrences GROW past baseline (the typed command itself often ' +
          'echoes the pattern, growth = real new output) OR when the buffer ends with a shell ' +
          'prompt sigil ($/#/>) and the pattern is present (= command finished, output rendered). ' +
          '`present`: matches as soon as pattern appears anywhere in pane content — for TUI ' +
          'sessions (Claude Code, codex, vim, htop, fzf) where the pattern is part of a static ' +
          'rendered panel and the buffer never gets a shell prompt. `idle`: matches when ' +
          'pattern is in pane AND content has been stable (no changes) for `idle_stable_ms` — ' +
          'good for "wait until the TUI stops typing/redrawing".',
      ),
    idle_stable_ms: z
      .number()
      .int()
      .min(100)
      .max(10_000)
      .default(DEFAULT_IDLE_STABLE_MS)
      .describe(
        `capture only, wait_mode=idle — how many ms of unchanged content count as "stable". ` +
          `Default ${DEFAULT_IDLE_STABLE_MS}ms. Lower = match faster but might catch a brief ` +
          `pause mid-render; higher = waits longer for true idle.`,
      ),
    wait_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(MAX_WAIT_TIMEOUT_MS)
      .default(DEFAULT_WAIT_TIMEOUT_MS)
      .describe(
        `capture only — max wait when wait_pattern is set. Default ${DEFAULT_WAIT_TIMEOUT_MS}ms ` +
          `(${DEFAULT_WAIT_TIMEOUT_MS / 1000}s); max ${MAX_WAIT_TIMEOUT_MS}ms ` +
          `(${MAX_WAIT_TIMEOUT_MS / 60_000} min) for slow tools. If the pattern doesn't appear ` +
          `in time, capture returns matched_pattern=false and the content as-is.`,
      ),
    include_ansi: z
      .boolean()
      .default(false)
      .describe(
        'capture only — when true, `content` returns the raw pane bytes including ANSI escape ' +
          'sequences (colors, cursor moves, dim/bold styling). Default false (escapes stripped — ' +
          'plain text easier to match against). Use `include_ansi:true` when you need to ' +
          'distinguish DIM/grayed-out text (e.g. auto-suggestions in Claude Code/codex prompt ' +
          'lines) from real user-typed input. SAFETY: never auto-Enter on a buffer containing ' +
          'pending input you didn\'t type yourself — it could be an auto-suggestion the TUI ' +
          'rendered, and submitting it could trigger destructive actions ("delete project", ' +
          '"clear all"). When in doubt, ask the user before submitting.',
      ),
    lines: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(200)
      .describe(
        'capture only — how many lines from the END of the pane scrollback to return. Default ' +
          '200 — covers a typical multi-step interaction without flooding. Bump higher if you ' +
          'need to see further back.',
      ),
  })
  .strict();

interface CreateResult {
  action: 'create';
  ok: boolean;
  target: string;
  name: string;
  hint?: string;
  error?: string;
}
interface SendResult {
  action: 'send';
  ok: boolean;
  target: string;
  name: string;
  ms: number;
  error?: string;
}
interface CaptureResult {
  action: 'capture';
  ok: boolean;
  target: string;
  name: string;
  content: string;
  matched_pattern: boolean;
  /** Only present when wait_pattern was provided. */
  wait_pattern?: string;
  ms: number;
  error?: string;
}
interface ListResult {
  action: 'list';
  ok: boolean;
  target: string;
  count: number;
  sessions: Array<{ name: string; created_at: number; windows: number }>;
}
interface KillResult {
  action: 'kill';
  ok: boolean;
  target: string;
  name: string;
  was_running: boolean;
}

type TmuxResult = CreateResult | SendResult | CaptureResult | ListResult | KillResult;

/**
 * Count how many times `needle` appears in `haystack`. Used by the
 * wait_pattern logic to detect "more occurrences than at baseline"
 * = new output appeared.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const next = haystack.indexOf(needle, idx);
    if (next === -1) break;
    count++;
    idx = next + needle.length;
  }
  return count;
}

/**
 * Heuristic: does the captured pane content end with a shell that's
 * idle and waiting for input? True when the last non-blank line ends
 * in a typical prompt sigil (`$`, `#`, or `>`) followed only by
 * whitespace. False when the last non-blank line contains the tail
 * of running output. Used together with `pattern-in-content` to
 * detect "command finished and produced its output already".
 *
 * Survives common prompts: `bash$ `, `user@host:~$`, `root#`,
 * `>` (psql/sqlite), `❯` won't match (intentionally — fish/starship
 * prompt with unicode chevron is ambiguous; users on those shells
 * can fall back to count-based by sending a marker that's NOT in
 * the typed command).
 */
function hasReadyPromptAtEnd(content: string): boolean {
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    return /[\$#>]\s*$/.test(ln);
  }
  return false;
}

function requireName(input: z.infer<typeof TmuxInput>, action: string): string {
  if (!input.name) {
    throw new Error(`tmux: action='${action}' requires the name field`);
  }
  return input.name;
}

async function runCapture(
  target: string,
  agent: string,
  name: string,
  lines: number,
  includeAnsi: boolean,
): Promise<{ ok: boolean; content: string; error?: string }> {
  if (target === 'local') {
    const r = await tmuxLocalCapture({ name, lines, includeAnsi });
    return r.ok
      ? { ok: true, content: r.stdout }
      : { ok: false, content: r.stdout, error: r.stderr.trim() || `exit ${r.exit_code}` };
  }
  const r = await tmuxRemoteCapture(agent, target, name, lines, includeAnsi);
  return r.ok
    ? { ok: true, content: r.stdout }
    : { ok: false, content: r.stdout, error: r.stderr.trim() || `exit ${r.exit_code}` };
}

export const tmux: ToolDefinition<z.infer<typeof TmuxInput>, TmuxResult> = {
  name: 'tmux',
  toolset: 'exec',
  description:
    'Drive a long-lived terminal (tmux) session on local (the somora server) or on a configured ' +
    'SSH resource. Use when you need to spawn an interactive tool (claude in skip-permissions ' +
    'mode, codex, vim, a REPL) and drive it across MULTIPLE agent turns — the session and its ' +
    'process state survive between your tool calls. ' +
    '\n\n' +
    'Typical flow: action:"create" once → many action:"send"/"capture" pairs over many turns → ' +
    'action:"kill" when done. action:"list" shows all sessions on the target. ' +
    '\n\n' +
    'Use exec INSTEAD when: you want to run a one-shot command (sync) or a detached background ' +
    'job (background:true) that runs to completion without further interaction. tmux is ' +
    'overkill for those — and forgotten tmux sessions accumulate. ' +
    '\n\n' +
    'capture supports wait_pattern with three modes (wait_mode field): "auto" (default, smart ' +
    'for shell sessions), "present" (matches as soon as pattern appears anywhere — for TUIs), ' +
    '"idle" (matches when pattern present AND content stable for idle_stable_ms). Without ' +
    'wait_pattern, capture returns the current pane content immediately. ' +
    '\n\n' +
    'Two opt-in flags help with TUIs that auto-submit on Enter or that draw auto-suggestions: ' +
    'send `multiline_safe:true` keeps embedded \\n as soft-newlines (M-Enter) instead of ' +
    'submits; capture `include_ansi:true` returns raw bytes with ANSI escapes so dim/grayed-out ' +
    'text (= auto-suggestions) is distinguishable from real input. ' +
    '\n\n' +
    'send has two input forms (mutually exclusive): `keys` for text/printable input (with ' +
    '`multiline_safe` for TUI-aware newline handling), or `key` for control/function/modifier ' +
    'keys by symbolic name (Escape, C-c, C-u, F1, Up, …). Use `key` to interrupt a running TUI ' +
    'task ("Escape" / "C-c") or to clear the input line ("C-u") — JSON-encoding raw control ' +
    'bytes in `keys` is unreliable. ' +
    '\n\n' +
    'SAFETY for TUI sessions: never blindly press Enter on a buffer that already shows pending ' +
    'input you didn\'t type — modern coding TUIs (Claude Code, codex) display auto-suggestions ' +
    'in the input field that look identical to real user-typed text in stripped output. ' +
    'Submitting a suggestion you didn\'t type can trigger destructive actions ("delete project", ' +
    '"clear all"). When in doubt, capture with include_ansi:true to see styling, or ask the user.',
  inputSchema: TmuxInput,
  jsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'send', 'capture', 'list', 'kill'],
      },
      target: { type: 'string', description: '"local" or resource name.', default: 'local' },
      name: { type: 'string', description: 'Session name. Required for create/send/capture/kill.' },
      cwd: { type: 'string' },
      keys: { type: 'string' },
      key: {
        type: 'string',
        description:
          'send only — symbolic tmux key name(s) for control/function keys. Mutually ' +
          'exclusive with `keys`. Examples: "Escape", "C-c", "C-u", "F1", "Up", "C-x C-c".',
      },
      multiline_safe: { type: 'boolean', default: false },
      wait_pattern: { type: 'string' },
      wait_mode: { type: 'string', enum: ['auto', 'present', 'idle'], default: 'auto' },
      idle_stable_ms: {
        type: 'integer',
        minimum: 100,
        maximum: 10_000,
        default: DEFAULT_IDLE_STABLE_MS,
      },
      wait_timeout_ms: {
        type: 'integer',
        minimum: 100,
        maximum: MAX_WAIT_TIMEOUT_MS,
        default: DEFAULT_WAIT_TIMEOUT_MS,
      },
      include_ansi: { type: 'boolean', default: false },
      lines: { type: 'integer', minimum: 1, maximum: 10_000, default: 200 },
    },
    required: ['action'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 30_000,
  // capture with wait_pattern can legitimately block — bump the
  // engine-level race to wait_timeout_ms + 2s buffer. Other actions
  // are quick (single ssh exec or local spawn).
  timeoutFromInput: (input) => {
    if (input.action === 'capture' && input.wait_pattern && input.wait_timeout_ms) {
      return input.wait_timeout_ms + 2_000;
    }
    return undefined;
  },
  maxTimeoutMs: MAX_WAIT_TIMEOUT_MS + 2_000,
  async handler(input, ctx): Promise<TmuxResult> {
    const target = input.target ?? 'local';

    if (input.action === 'create') {
      const name = requireName(input, 'create');
      const r =
        target === 'local'
          ? await tmuxLocalCreate({ name, ...(input.cwd ? { cwd: input.cwd } : {}) })
          : await tmuxRemoteCreate(ctx.agent, target, name, input.cwd);
      if (!r.ok) {
        return {
          action: 'create',
          ok: false,
          target,
          name,
          error: r.stderr.trim() || `exit ${r.exit_code}`,
        };
      }
      return {
        action: 'create',
        ok: true,
        target,
        name,
        hint:
          `Session ready. Use tmux({action:"send", target:"${target}", name:"${name}", ` +
          `keys:"<text>\\n"}) to type into it, or tmux({..., key:"Escape"}) for control ` +
          `keys (Escape, C-c, C-u, F1, …). tmux({action:"capture", ...}) to read, ` +
          `tmux({action:"kill", ...}) when done.`,
      };
    }

    if (input.action === 'send') {
      const name = requireName(input, 'send');
      const hasKeys = input.keys !== undefined;
      const hasKey = input.key !== undefined;
      if (hasKeys && hasKey) {
        throw new Error(
          'tmux send: pass either `keys` (text) or `key` (control/function key name), not both',
        );
      }
      if (!hasKeys && !hasKey) {
        throw new Error('tmux send: requires `keys` (text) or `key` (control/function key name)');
      }
      const start = Date.now();
      const r = hasKey
        ? target === 'local'
          ? await tmuxLocalSendKey(name, input.key as string)
          : await tmuxRemoteSendKey(ctx.agent, target, name, input.key as string)
        : target === 'local'
          ? await tmuxLocalSend(name, input.keys as string, input.multiline_safe ?? false)
          : await tmuxRemoteSend(
              ctx.agent,
              target,
              name,
              input.keys as string,
              input.multiline_safe ?? false,
            );
      return {
        action: 'send',
        ok: r.ok,
        target,
        name,
        ms: Date.now() - start,
        ...(r.ok ? {} : { error: r.stderr.trim() || `exit ${r.exit_code}` }),
      };
    }

    if (input.action === 'capture') {
      const name = requireName(input, 'capture');
      const lines = input.lines ?? 200;
      const includeAnsi = input.include_ansi ?? false;
      const start = Date.now();

      // No wait_pattern: one-shot capture, return whatever's in the
      // pane right now.
      if (!input.wait_pattern) {
        const cap = await runCapture(target, ctx.agent, name, lines, includeAnsi);
        return {
          action: 'capture',
          ok: cap.ok,
          target,
          name,
          content: cap.content,
          matched_pattern: false,
          ms: Date.now() - start,
          ...(cap.error ? { error: cap.error } : {}),
        };
      }

      const pattern = input.wait_pattern;
      const mode = input.wait_mode ?? 'auto';
      const timeout = input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      const idleStableMs = input.idle_stable_ms ?? DEFAULT_IDLE_STABLE_MS;
      const deadline = start + timeout;

      // Tiny pre-baseline sleep to dodge a race: if the model called
      // `tmux send keys="<cmd>\n"` immediately before this capture,
      // tmux's display buffer might not have rendered the typed
      // command yet. Without this delay our baseline could miss the
      // typed text → first poll sees the command appear → false-
      // positive match. 100ms is invisible to the model and reliable.
      await new Promise((res) => setTimeout(res, 100));
      const baselineCap = await runCapture(target, ctx.agent, name, lines, includeAnsi);
      const baseline = baselineCap.ok ? baselineCap.content : '';
      const baselineCount = countOccurrences(baseline, pattern);
      let lastContent = baseline;
      let lastError = baselineCap.ok ? undefined : baselineCap.error;
      let matched = false;

      // Mode-specific match check. Evaluated at baseline AND on each
      // poll iteration so the same code-path catches early-match.
      function matchCheck(content: string, count: number): boolean {
        if (mode === 'present') {
          // Pattern visible anywhere → match. For TUI sessions where
          // the pattern is part of a static rendered panel.
          return count > 0;
        }
        if (mode === 'idle') {
          // Idle-match handled separately below (needs stability
          // tracking), not a single-snapshot decision.
          return false;
        }
        // mode === 'auto' — the smart shell-friendly default:
        //   * count grew past baseline (new output appeared), OR
        //   * pattern present AND buffer ends with shell prompt sigil
        //     ($/#/>) — command finished, output rendered. Different
        //     shells render typed input differently (some echo it
        //     once, some draw a draft line above); prompt-detect
        //     works across both because we look at tail-of-buffer.
        if (count > baselineCount) return true;
        if (count > 0 && hasReadyPromptAtEnd(content)) return true;
        return false;
      }

      // Idle-mode tracking: when did the content last change, when
      // did we last see the pattern present? Match fires when both
      // have been true for >= idleStableMs continuously.
      let lastChangeTs = Date.now();
      let lastSeenContent = baseline;

      if (matchCheck(baseline, baselineCount)) {
        matched = true;
      }

      while (!matched && !lastError && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        // For idle-mode polling we sleep at most until the next
        // stability check tick, which can be shorter than POLL_INTERVAL_MS.
        const sleepFor =
          mode === 'idle'
            ? Math.min(POLL_INTERVAL_MS, remaining, idleStableMs)
            : Math.min(POLL_INTERVAL_MS, remaining);
        await new Promise((res) => setTimeout(res, sleepFor));
        const cap = await runCapture(target, ctx.agent, name, lines, includeAnsi);
        if (!cap.ok) {
          lastError = cap.error;
          break;
        }
        lastContent = cap.content;
        const currentCount = countOccurrences(lastContent, pattern);

        if (mode === 'idle') {
          // Idle-mode: match once pattern is present AND content has
          // been unchanged for >= idleStableMs. Reset the change
          // timer whenever content actually moves.
          if (lastContent !== lastSeenContent) {
            lastChangeTs = Date.now();
            lastSeenContent = lastContent;
          }
          if (currentCount > 0 && Date.now() - lastChangeTs >= idleStableMs) {
            matched = true;
            break;
          }
        } else if (matchCheck(lastContent, currentCount)) {
          matched = true;
          break;
        }
      }

      if (!matched && !lastError) {
        logger.info({
          msg: 'tmux.capture.pattern_timeout',
          target,
          name,
          mode,
          pattern: pattern.slice(0, 80),
          waited_ms: Date.now() - start,
        });
      }

      return {
        action: 'capture',
        ok: !lastError,
        target,
        name,
        content: lastContent,
        matched_pattern: matched,
        wait_pattern: pattern,
        ms: Date.now() - start,
        ...(lastError ? { error: lastError } : {}),
      };
    }

    if (input.action === 'list') {
      const r =
        target === 'local'
          ? await tmuxLocalList()
          : await tmuxRemoteList(ctx.agent, target);
      return {
        action: 'list',
        ok: r.ok,
        target,
        count: r.sessions.length,
        sessions: r.sessions,
      };
    }

    // kill
    const name = requireName(input, 'kill');
    const r =
      target === 'local'
        ? await tmuxLocalKill(name)
        : await tmuxRemoteKill(ctx.agent, target, name);
    // tmux kill-session exits non-zero with "can't find session" on
    // stderr if the name is gone — treat that as "was_running:false"
    // rather than an error.
    if (!r.ok) {
      const wasMissing =
        r.stderr.includes("can't find session") ||
        r.stderr.includes('no server running') ||
        r.stderr.includes('session not found');
      if (wasMissing) {
        return { action: 'kill', ok: true, target, name, was_running: false };
      }
    }
    return {
      action: 'kill',
      ok: r.ok,
      target,
      name,
      was_running: r.ok,
    };
  },
};

export function tmuxTools(): ToolDefinition[] {
  return [tmux] as ToolDefinition[];
}
