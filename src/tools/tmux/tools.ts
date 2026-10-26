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
import {
  getTmuxOrigin,
  recordTmuxOrigin,
  removeTmuxOrigin,
  type TmuxSessionKind,
} from '../../tmux/origin-store.ts';
import { detectTuiState, detectSuggestion, type TuiDetectResult } from '../../tmux/tui-markers.ts';
import {
  readAttentionMirror,
  recordTmuxObservation,
  type AttentionDisplay,
} from '../../tmux/attention.ts';

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

/** Field texts, shared by the zod schema (Claude, Grok) and the JSON
 *  schema (Codex, OpenAI-compatible) so every engine reads the same. */
const FIELD = {
  action: 'create | send | capture | wait_idle | list | kill.',
  target:
    '"local" (default) = the somora server. Otherwise a resource name from resource_list. ' +
    'tmux must be installed there.',
  name:
    'Session name, required for every action except list. Letters, digits, - and _; ' +
    'pick a readable one like "codex-auth-fix".',
  cwd: 'create only — working directory of the new session.',
  keys:
    'send only — text to type. Each \\n is an Enter (end with \\n to run a shell command). ' +
    'Not together with key.',
  key:
    'send only — key names, space-separated: Escape, C-c, C-u, Tab, BSpace, Up, F1, "C-x C-c" ' +
    '(C- = Ctrl, M- = Alt, S- = Shift). Not together with keys.',
  multiline_safe:
    'send only — true sends inner \\n as Alt+Enter, a newline that does not submit. Only for ' +
    'chat-style input boxes (Claude Code, codex, opencode). Not for a shell or a Python REPL: ' +
    'there every Enter runs the line, so send the lines as they are. A \\n at the very end still ' +
    'submits. Default false.',
  wait_pattern:
    'capture only — text to wait for. Checked every 200 ms until it matches or ' +
    'wait_timeout_ms runs out. Without it, capture returns the pane at once.',
  wait_mode:
    'capture only — how wait_pattern matches. "auto" (default, for shells): the pattern ' +
    'appears more often than before, or it is there and a shell prompt ($ # >) ends the pane. ' +
    '"present" (for TUIs): the pattern is anywhere in the pane. "idle": the pattern is there ' +
    'and the pane has not changed for idle_stable_ms.',
  idle_stable_ms: `wait_idle and wait_mode "idle" — how long the pane must stay unchanged, in ms. Default ${DEFAULT_IDLE_STABLE_MS}.`,
  wait_timeout_ms:
    `capture with wait_pattern, and wait_idle — longest wait in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}, ` +
    `max ${MAX_WAIT_TIMEOUT_MS}). On timeout you get the current pane with matched_pattern=false ` +
    `or became_idle=false.`,
  include_ansi:
    'capture only — true returns the pane with its ANSI styling, so dim suggestion text can ' +
    'be told apart from typed input. Default false.',
  lines: 'capture only — how many lines from the end of the scrollback to return. Default 200.',
  inherit_agent_env:
    'create only, local only. Default false: a claude or codex started in the pane uses the ' +
    "person's normal login. true keeps somora's own isolated Claude settings — rarely wanted.",
  kind:
    'create only — what runs in the pane: "shell" (default: shells, builds, REPLs, vim), ' +
    '"claude-code", "codex" or "opencode". With a coding-CLI kind, capture and wait_idle ' +
    'return tui_state, wait_idle waits until the program is really ready, and somora wakes ' +
    'you with a [tmux attention] turn when it finishes while you are not looking. In ' +
    'opencode a "Permission required" dialog counts as ready (Enter = allow once). When ' +
    'unsure, use "shell".',
  attention:
    'create only, coding-CLI kinds — false: no wake turn when the program finishes. Default true.',
};

const TmuxInput = z
  .object({
    action: z.enum(['create', 'send', 'capture', 'wait_idle', 'list', 'kill']).describe(FIELD.action),
    target: z.string().min(1).default('local').describe(FIELD.target),
    name: z.string().min(1).max(100).optional().describe(FIELD.name),
    cwd: z.string().min(1).optional().describe(FIELD.cwd),
    keys: z.string().optional().describe(FIELD.keys),
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(
        KEY_TOKEN_RE,
        'key: only [A-Za-z0-9_-] tokens, optionally space-separated (e.g. "Escape", "C-c", "F1", "C-x C-c")',
      )
      .optional()
      .describe(FIELD.key),
    multiline_safe: z.boolean().default(false).describe(FIELD.multiline_safe),
    wait_pattern: z.string().min(1).optional().describe(FIELD.wait_pattern),
    wait_mode: z.enum(['auto', 'present', 'idle']).default('auto').describe(FIELD.wait_mode),
    idle_stable_ms: z.number().int().min(100).max(10_000).default(DEFAULT_IDLE_STABLE_MS).describe(FIELD.idle_stable_ms),
    wait_timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(MAX_WAIT_TIMEOUT_MS)
      .default(DEFAULT_WAIT_TIMEOUT_MS)
      .describe(FIELD.wait_timeout_ms),
    include_ansi: z.boolean().default(false).describe(FIELD.include_ansi),
    lines: z.number().int().min(1).max(10_000).default(200).describe(FIELD.lines),
    inherit_agent_env: z.boolean().default(false).describe(FIELD.inherit_agent_env),
    kind: z.enum(['shell', 'claude-code', 'codex', 'opencode']).default('shell').describe(FIELD.kind),
    attention: z.boolean().default(true).describe(FIELD.attention),
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
interface TuiStateField {
  /** "ready" = TUI prompt available to accept input. "queued" = agent
   *  typed something but the TUI hasn't submitted it yet (don't proceed,
   *  the input is still in composer). "running" = TUI is actively
   *  processing — wait or interrupt with key:"Escape". "idle_unknown" =
   *  detection failed (e.g. unknown kind). */
  state: 'ready' | 'queued' | 'running' | 'idle_unknown';
  /** Substrings from the pane that matched the kind's marker table. */
  markers: string[];
  /** True when the TUI is rendering ghost-text (a dim auto-suggestion)
   *  on its input line. This is the TUI predicting a next step for a
   *  HUMAN — it is NOT real typed input. Ignore it: don't delete it,
   *  don't narrate it, don't submit it. */
  suggestion_visible?: boolean;
  /** The ghost text, when suggestion_visible. Informational only. */
  suggestion_text?: string;
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
  /** Only present when the session was created with kind != "shell". */
  tui_state?: TuiStateField;
  /** Attention-watcher metadata; only present for watched coding-CLI
   *  sessions while the watcher is enabled. */
  attention?: AttentionDisplay;
  ms: number;
  error?: string;
}
interface WaitIdleResult {
  action: 'wait_idle';
  ok: boolean;
  target: string;
  name: string;
  /** Final pane content snapshot (after stability was reached or timeout fired). */
  content: string;
  /** True if the pane went stable for `idle_stable_ms` before max_wait_ms expired.
   *  For TUI sessions (kind != "shell"), this is true only when the pane is BOTH
   *  content-stable AND the marker-detected state is "ready" — a stable pane that
   *  still shows queued-input or running markers reports became_idle=false. */
  became_idle: boolean;
  /** Only present when the session was created with kind != "shell". */
  tui_state?: TuiStateField;
  /** Attention-watcher metadata; only present for watched coding-CLI
   *  sessions while the watcher is enabled. */
  attention?: AttentionDisplay;
  /** Total wall time the action waited, including the final stability window. */
  ms: number;
  error?: string;
}
interface ListResult {
  action: 'list';
  ok: boolean;
  target: string;
  count: number;
  sessions: Array<{
    name: string;
    created_at: number;
    windows: number;
    attention?: AttentionDisplay;
  }>;
}
interface KillResult {
  action: 'kill';
  ok: boolean;
  target: string;
  name: string;
  was_running: boolean;
}

type TmuxResult =
  | CreateResult
  | SendResult
  | CaptureResult
  | WaitIdleResult
  | ListResult
  | KillResult;

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

/** Bottom-of-pane window for the ghost-text probe — the input box
 *  lives there; scanning full scrollback would only add stale hits. */
const SUGGESTION_PROBE_LINES = 40;

/**
 * Enrich a detected tui_state with ghost-text (auto-suggestion) info.
 * Reuses the caller's capture when it already includes ANSI; otherwise
 * runs one extra small `capture-pane -e` probe. Best-effort — a failed
 * probe returns the plain state unchanged.
 */
async function enrichTuiState(
  tui: TuiDetectResult,
  target: string,
  agent: string,
  name: string,
  kind: TmuxSessionKind | undefined,
  ansiContent: string | null,
): Promise<TuiStateField> {
  try {
    const ansi =
      ansiContent ??
      (await runCapture(target, agent, name, SUGGESTION_PROBE_LINES, true)).content;
    const s = detectSuggestion(ansi, kind);
    if (!s) return tui;
    return {
      ...tui,
      suggestion_visible: s.suggestion_visible,
      ...(s.suggestion_text !== undefined ? { suggestion_text: s.suggestion_text } : {}),
    };
  } catch {
    return tui;
  }
}

/**
 * Observation ledger write for the attention watcher: when the ORIGIN
 * (agent, session) looks at (capture / wait_idle) or drives (send) a
 * watched coding-CLI session, note the timestamp so a completion the
 * agent saw itself never triggers a wake (anti-double-trigger contract,
 * design doc §3.2). Non-origin agents don't count — someone else
 * peeking doesn't mean the origin agent is informed. Best-effort.
 */
function noteObservation(
  target: string,
  name: string,
  ctx: { agent: string; session?: string },
  sawState?: TuiDetectResult['state'],
): void {
  if (target !== 'local') return;
  try {
    const origin = getTmuxOrigin(name);
    if (!origin || !origin.kind || origin.kind === 'shell') return;
    if (origin.agent !== ctx.agent) return;
    if (origin.session && ctx.session && origin.session !== ctx.session) return;
    recordTmuxObservation(name, ctx.agent, ctx.session, sawState);
  } catch {
    /* ledger must never break the tool */
  }
}

/** Attention metadata for one local session, read from the watcher's
 *  mirror file. Empty when the watcher is off (boot clears the mirror)
 *  or the session isn't watched — zero traces when the feature is
 *  disabled (three-gates rule). */
function attentionFor(target: string, name: string): { attention?: AttentionDisplay } {
  if (target !== 'local') return {};
  try {
    const a = readAttentionMirror()[name];
    return a ? { attention: a } : {};
  } catch {
    return {};
  }
}

/**
 * Look up the session's declared kind from origin-store. Only local
 * sessions carry origin records (remote tmux runs on a different host
 * and isn't tracked here yet) — remote always returns undefined,
 * which downstream means "no TUI detection, behave like today".
 */
function lookupSessionKind(target: string, name: string): TmuxSessionKind | undefined {
  if (target !== 'local') return undefined;
  try {
    const origin = getTmuxOrigin(name);
    return origin?.kind;
  } catch {
    return undefined;
  }
}

export const tmux: ToolDefinition<z.infer<typeof TmuxInput>, TmuxResult> = {
  name: 'tmux',
  toolset: 'exec',
  description:
    'Drive a long-lived terminal (tmux) session, locally on the somora server or on an SSH ' +
    'resource. Use it for interactive programs you drive over several turns (claude, codex, ' +
    'opencode, a REPL, vim): the session keeps running between your calls. For a one-shot ' +
    'command or a background job use exec instead, and kill tmux sessions you no longer need.' +
    '\n\n' +
    'Flow: create once → send and capture (or wait_idle) as often as needed → kill. list shows ' +
    'the sessions on a target.\n' +
    '- send: `keys` types text, and \\n presses Enter. In a chat-style input box (Claude Code, ' +
    'codex, opencode) Enter sends the whole message, so set multiline_safe:true there to keep ' +
    'inner newlines; a shell or a Python REPL runs each line on Enter and needs no flag. `key` ' +
    'sends keys by name: Escape or C-c interrupts a running task, C-u clears the input line.\n' +
    '- capture: returns the pane now, or with wait_pattern waits for a text (see wait_mode).\n' +
    '- wait_idle: waits until the pane stops changing — use it when you do not know what the ' +
    'output will look like.\n' +
    '- At create, set kind ("claude-code", "codex", "opencode") when that program will run in ' +
    'the pane: capture and wait_idle then return tui_state {state: ready | queued | running, ' +
    'suggestion_visible, suggestion_text}.' +
    '\n\n' +
    'Ghost text: Claude Code and codex show a dim suggested next input. It is not typed input — ' +
    'ignore it, it disappears when you type. Never press Enter on input you did not type ' +
    'yourself: it may be a suggestion or text someone left there, and submitting it can do ' +
    'damage ("delete project"). If unsure, capture with include_ansi:true (dim text is a ' +
    'suggestion) or ask the person.',
  inputSchema: TmuxInput,
  jsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'send', 'capture', 'wait_idle', 'list', 'kill'], description: FIELD.action },
      target: { type: 'string', default: 'local', description: FIELD.target },
      name: { type: 'string', description: FIELD.name },
      cwd: { type: 'string', description: FIELD.cwd },
      keys: { type: 'string', description: FIELD.keys },
      key: { type: 'string', description: FIELD.key },
      multiline_safe: { type: 'boolean', default: false, description: FIELD.multiline_safe },
      wait_pattern: { type: 'string', description: FIELD.wait_pattern },
      wait_mode: { type: 'string', enum: ['auto', 'present', 'idle'], default: 'auto', description: FIELD.wait_mode },
      idle_stable_ms: {
        type: 'integer',
        minimum: 100,
        maximum: 10_000,
        default: DEFAULT_IDLE_STABLE_MS,
        description: FIELD.idle_stable_ms,
      },
      wait_timeout_ms: {
        type: 'integer',
        minimum: 100,
        maximum: MAX_WAIT_TIMEOUT_MS,
        default: DEFAULT_WAIT_TIMEOUT_MS,
        description: FIELD.wait_timeout_ms,
      },
      include_ansi: { type: 'boolean', default: false, description: FIELD.include_ansi },
      lines: { type: 'integer', minimum: 1, maximum: 10_000, default: 200, description: FIELD.lines },
      inherit_agent_env: { type: 'boolean', default: false, description: FIELD.inherit_agent_env },
      kind: {
        type: 'string',
        enum: ['shell', 'claude-code', 'codex', 'opencode'],
        default: 'shell',
        description: FIELD.kind,
      },
      attention: { type: 'boolean', default: true, description: FIELD.attention },
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
    if (input.action === 'wait_idle' && input.wait_timeout_ms) {
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
          ? await tmuxLocalCreate({
              name,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              inheritAgentEnv: input.inherit_agent_env === true,
            })
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
      // Track origin for the web tmux-list view (local sessions only;
      // remote sessions live on other hosts and aren't browse-able from
      // here yet). Failure to record never blocks the tool.
      const kind: TmuxSessionKind = input.kind ?? 'shell';
      if (target === 'local') {
        try {
          recordTmuxOrigin({
            name,
            agent: ctx.agent,
            ...(ctx.session ? { session: ctx.session } : {}),
            ...(kind !== 'shell' ? { kind } : {}),
            ...(input.attention === false ? { attention: false } : {}),
          });
        } catch (err) {
          logger.warn({
            msg: 'tmux.origin.record_failed',
            name,
            err: (err as Error).message,
          });
        }
      }
      // Tailored hint depending on declared kind — points the agent at
      // tui_state for the kinds that emit it.
      const kindHint =
        kind === 'shell'
          ? ''
          : ` This session is kind:"${kind}" — capture and wait_idle return a ` +
            `tui_state:{state, markers, suggestion_visible, suggestion_text} block. Before ` +
            `assuming an input was processed, check tui_state.state — "queued" means it's ` +
            `not submitted yet, "running" means the TUI is still working. If ` +
            `suggestion_visible is true, the input line shows the TUI's dim ghost-text ` +
            `prediction for a human — ignore it, it is not real input.`;
      return {
        action: 'create',
        ok: true,
        target,
        name,
        hint:
          `Session ready. Use tmux({action:"send", target:"${target}", name:"${name}", ` +
          `keys:"<text>\\n"}) to type into it, or tmux({..., key:"Escape"}) for control ` +
          `keys (Escape, C-c, C-u, F1, …). tmux({action:"capture", ...}) to read, ` +
          `tmux({action:"kill", ...}) when done.${kindHint}`,
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
      if (r.ok) noteObservation(target, name, ctx);
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
        const kind = lookupSessionKind(target, name);
        const tui = detectTuiState(cap.content, kind);
        const tuiOut = tui
          ? await enrichTuiState(tui, target, ctx.agent, name, kind, includeAnsi ? cap.content : null)
          : null;
        if (cap.ok) noteObservation(target, name, ctx, tui?.state);
        return {
          action: 'capture',
          ok: cap.ok,
          target,
          name,
          content: cap.content,
          matched_pattern: false,
          ms: Date.now() - start,
          ...(tuiOut ? { tui_state: tuiOut } : {}),
          ...attentionFor(target, name),
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

      const captureKind = lookupSessionKind(target, name);
      const captureTui = detectTuiState(lastContent, captureKind);
      const captureTuiOut = captureTui
        ? await enrichTuiState(captureTui, target, ctx.agent, name, captureKind, includeAnsi ? lastContent : null)
        : null;
      if (!lastError) noteObservation(target, name, ctx, captureTui?.state);
      return {
        action: 'capture',
        ok: !lastError,
        target,
        name,
        content: lastContent,
        matched_pattern: matched,
        wait_pattern: pattern,
        ms: Date.now() - start,
        ...(captureTuiOut ? { tui_state: captureTuiOut } : {}),
        ...attentionFor(target, name),
        ...(lastError ? { error: lastError } : {}),
      };
    }

    if (input.action === 'wait_idle') {
      const name = requireName(input, 'wait_idle');
      const lines = input.lines ?? 200;
      const includeAnsi = input.include_ansi ?? false;
      const idleStableMs = input.idle_stable_ms ?? DEFAULT_IDLE_STABLE_MS;
      const timeout = input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      const start = Date.now();
      const deadline = start + timeout;
      // Look up the session's kind once — drives whether a stable but
      // queued/running pane should count as idle. Undefined / "shell"
      // = no detection, falls back to today's pure-stability behavior.
      const sessionKind = lookupSessionKind(target, name);

      // Same pre-baseline race-dodge as capture's wait_pattern path:
      // if the model called `send` immediately before this wait, give
      // tmux a tick to render the typed text so the baseline already
      // contains it.
      await new Promise((res) => setTimeout(res, 100));
      const baselineCap = await runCapture(target, ctx.agent, name, lines, includeAnsi);
      if (!baselineCap.ok) {
        return {
          action: 'wait_idle',
          ok: false,
          target,
          name,
          content: baselineCap.content,
          became_idle: false,
          ms: Date.now() - start,
          error: baselineCap.error,
        };
      }

      let lastContent = baselineCap.content;
      let lastChangeTs = Date.now();
      let becameIdle = false;
      let lastError: string | undefined;

      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        // Sleep at most until the next stability check tick. Capping at
        // idleStableMs means a freshly-stable pane can be detected on
        // the very next poll instead of waiting a full POLL_INTERVAL.
        const sleepFor = Math.min(POLL_INTERVAL_MS, remaining, idleStableMs);
        await new Promise((res) => setTimeout(res, sleepFor));
        const cap = await runCapture(target, ctx.agent, name, lines, includeAnsi);
        if (!cap.ok) {
          lastError = cap.error;
          break;
        }
        if (cap.content !== lastContent) {
          lastContent = cap.content;
          lastChangeTs = Date.now();
          continue;
        }
        if (Date.now() - lastChangeTs >= idleStableMs) {
          // Content has been stable. For shell sessions that's enough;
          // for TUI sessions, also require the TUI state to be "ready"
          // — a pane sitting on "Press up to edit queued messages" or
          // "esc to interrupt" is content-stable but the TUI is NOT
          // actually done. Treating it as idle is the exact failure
          // ada reported 2026-05-17 (queued-input feedback).
          const tui = detectTuiState(lastContent, sessionKind);
          if (!tui || tui.state === 'ready') {
            becameIdle = true;
            break;
          }
          // TUI state is queued or running. Reset the stability timer
          // so the next "stable" decision is computed from now — that
          // way a still-running TUI eventually times out via deadline
          // (rather than spinning the inner branch every poll).
          lastChangeTs = Date.now();
        }
      }

      if (!becameIdle && !lastError) {
        logger.info({
          msg: 'tmux.wait_idle.timeout',
          target,
          name,
          waited_ms: Date.now() - start,
          idle_stable_ms: idleStableMs,
          kind: sessionKind,
        });
      }

      const tuiFinal = detectTuiState(lastContent, sessionKind);
      const tuiFinalOut = tuiFinal
        ? await enrichTuiState(tuiFinal, target, ctx.agent, name, sessionKind, includeAnsi ? lastContent : null)
        : null;
      if (!lastError) noteObservation(target, name, ctx, tuiFinal?.state);
      return {
        action: 'wait_idle',
        ok: !lastError,
        target,
        name,
        content: lastContent,
        became_idle: becameIdle,
        ms: Date.now() - start,
        ...(tuiFinalOut ? { tui_state: tuiFinalOut } : {}),
        ...attentionFor(target, name),
        ...(lastError ? { error: lastError } : {}),
      };
    }

    if (input.action === 'list') {
      const r =
        target === 'local'
          ? await tmuxLocalList()
          : await tmuxRemoteList(ctx.agent, target);
      // Annotate local sessions with attention metadata (watched
      // coding-CLI sessions only; empty when the watcher is off).
      const mirror = target === 'local' ? readAttentionMirror() : {};
      const sessions = r.sessions.map((s) =>
        mirror[s.name] ? { ...s, attention: mirror[s.name] } : s,
      );
      return {
        action: 'list',
        ok: r.ok,
        target,
        count: sessions.length,
        sessions,
      };
    }

    // kill
    const name = requireName(input, 'kill');
    const r =
      target === 'local'
        ? await tmuxLocalKill(name)
        : await tmuxRemoteKill(ctx.agent, target, name);
    // Drop the origin record on successful kill — also when we're
    // about to return was_running=false since the session is gone
    // either way. Best-effort, never blocks.
    if (target === 'local') {
      try {
        removeTmuxOrigin(name);
      } catch (err) {
        logger.warn({
          msg: 'tmux.origin.remove_failed',
          name,
          err: (err as Error).message,
        });
      }
    }
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
