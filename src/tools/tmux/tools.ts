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
  localRunner,
  tmuxLocalCapture,
  tmuxLocalCreate,
  tmuxLocalKill,
  tmuxLocalList,
  tmuxLocalSend,
  tmuxLocalSendKey,
} from './local.ts';
import {
  remoteRunner,
  tmuxRemoteCapture,
  tmuxRemoteCreate,
  tmuxRemoteKill,
  tmuxRemoteList,
  tmuxRemoteSend,
  tmuxRemoteSendKey,
} from './remote.ts';
import { getTmuxOrigin, listTmuxOrigins, originKey, recordTmuxOrigin, removeTmuxOrigin } from '../../tmux/origin-store.ts';
import { shQuote as shellQuote } from '../../tmux/observe.ts';
import {
  readAttentionMirror,
  readTmuxObservations,
  recordTmuxObservation,
  type AttentionDisplay,
  type ObservationExtra,
  type SeenState,
} from '../../tmux/attention.ts';
import { agentStateOf, observePane, type AgentStateField, type Runner } from '../../tmux/observe.ts';
import { newConversation, promptAgent, startAgent, waitSettled, type DriveResult } from '../../tmux/drive.ts';
import { explainAgentState, resolveAgent } from '../../tmux/detection/manifests.ts';

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
/** prompt waits for the agent's whole answer by default. */
const DEFAULT_PROMPT_TIMEOUT_MS = 300_000;
/** start: an agent that loads plugins or logs in can take a while. */
const DEFAULT_START_TIMEOUT_MS = 60_000;

/** Field texts, shared by the zod schema (Claude, Grok) and the JSON
 *  schema (Codex, OpenAI-compatible) so every engine reads the same. */
const FIELD = {
  action: 'create | start | prompt | new_conversation | send | capture | read | wait_idle | list | explain | kill.',
  target:
    '"local" (default) = the somora server. Otherwise a resource name from resource_list. ' +
    'tmux must be installed there.',
  name:
    'Session name, required for every action except list. Letters, digits, - and _; ' +
    'pick a readable one like "codex-auth-fix".',
  cwd: 'create and start — working directory of a new session.',
  command:
    'start only — the command line that starts the coding agent, typed into the session\'s shell, ' +
    'e.g. "codex", "claude", "opencode --model <provider>/<model>", "pi". Native arguments go after it.',
  text:
    'prompt only — the message for the agent, any length, newlines kept. It is pasted and submitted ' +
    'as one message.',
  wait:
    'prompt only — true (default): return when the agent is done (idle) or stops at a dialog (blocked). ' +
    'false: return as soon as the agent took the prompt.',
  keys:
    'send only — text to type. Each \\n is an Enter (end with \\n to run a shell command). ' +
    'Into a Python REPL (3.13+) send lines without leading spaces: it indents by itself. ' +
    'For a coding agent use prompt instead. Not together with key.',
  key:
    'send only — key names, space-separated: Escape, C-c, C-u, Tab, BSpace, Up, Down, Enter, F1, "C-x C-c" ' +
    '(C- = Ctrl, M- = Alt, S- = Shift). Not together with keys.',
  multiline_safe:
    'send only — true sends inner \\n as Alt+Enter, a newline that does not submit. Prefer prompt for ' +
    'coding agents. Default false.',
  wait_pattern:
    'capture only — text to wait for. Checked every 200 ms until it matches or ' +
    'wait_timeout_ms runs out. Without it, capture returns the pane at once.',
  wait_mode:
    'capture only — how wait_pattern matches. "auto" (default, for shells): the pattern ' +
    'appears more often than before, or it is there and a shell prompt ($ # >) ends the pane. ' +
    '"present" (for TUIs): the pattern is anywhere in the pane. "idle": the pattern is there ' +
    'and the pane has not changed for idle_stable_ms.',
  idle_stable_ms: `wait_idle on a shell and wait_mode "idle" — how long the pane must stay unchanged, in ms. Default ${DEFAULT_IDLE_STABLE_MS}.`,
  wait_timeout_ms:
    `prompt, start, wait_idle and capture with wait_pattern — longest wait in ms (default ${DEFAULT_WAIT_TIMEOUT_MS}, ` +
    `prompt ${DEFAULT_PROMPT_TIMEOUT_MS}; max ${MAX_WAIT_TIMEOUT_MS}).`,
  include_ansi:
    'capture only — true returns the pane with its ANSI styling, so dim suggestion text can ' +
    'be told apart from typed input. Default false.',
  lines: 'capture, read, prompt, wait_idle — how many lines from the end to return. Default 200 (prompt 60).',
  inherit_agent_env:
    'create and start, local only. Default false: a claude or codex started in the pane uses the ' +
    "person's normal login. true keeps somora's own isolated Claude settings — rarely wanted.",
  kind:
    'create only, rarely needed — somora recognises the coding agent in a pane by its process. ' +
    'Name it ("claude", "codex", "opencode", "pi", …) only for a host whose ps cannot show it.',
  attention:
    'create and start — false: no wake turn when the agent finishes or needs an answer. Default true.',
};

const TmuxInput = z
  .object({
    action: z
      .enum(['create', 'start', 'prompt', 'new_conversation', 'send', 'capture', 'read', 'wait_idle', 'list', 'explain', 'kill'])
      .describe(FIELD.action),
    target: z.string().min(1).default('local').describe(FIELD.target),
    name: z.string().min(1).max(100).optional().describe(FIELD.name),
    cwd: z.string().min(1).optional().describe(FIELD.cwd),
    command: z.string().min(1).max(2000).optional().describe(FIELD.command),
    text: z.string().min(1).max(100_000).optional().describe(FIELD.text),
    wait: z.boolean().default(true).describe(FIELD.wait),
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
    wait_timeout_ms: z.number().int().min(100).max(MAX_WAIT_TIMEOUT_MS).optional().describe(FIELD.wait_timeout_ms),
    include_ansi: z.boolean().default(false).describe(FIELD.include_ansi),
    lines: z.number().int().min(1).max(10_000).optional().describe(FIELD.lines),
    inherit_agent_env: z.boolean().default(false).describe(FIELD.inherit_agent_env),
    kind: z
      .string()
      .min(1)
      .max(40)
      .refine((k) => k === 'shell' || resolveAgent(k) !== null, 'kind: "shell" or a known coding agent (claude, codex, opencode, pi, …)')
      .optional()
      .describe(FIELD.kind),
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
  /** The agent's state a moment after the keys (answering a dialog
   *  shows at once whether it went on, stopped or closed). */
  agent?: AgentStateField;
  error?: string;
}

/** Sessions of the calling agent that finished or wait at a dialog and
 *  were not looked at yet — so a busy agent learns of them without
 *  polling list. Added to every result where there are any. */
interface WaitingEntry {
  name: string;
  target?: string;
  state: 'ready' | 'blocked' | 'running' | null;
  /** finished: stopped working and is idle; dialog: waits at a dialog. */
  reason: 'finished' | 'dialog';
  /** For a dialog: the detection rule that matched (permission_required …). */
  rule?: string;
  since: number | null;
}
/** prompt, start: what drive.ts reports, under its action. */
type DriveActionResult = { action: 'prompt' | 'start' | 'new_conversation'; target: string; name: string; command?: string } & DriveResult;

interface CaptureResult {
  action: 'capture' | 'read';
  ok: boolean;
  target: string;
  name: string;
  content: string;
  matched_pattern: boolean;
  /** Only present when wait_pattern was provided. */
  wait_pattern?: string;
  /** The coding agent in the pane and its state; absent for a shell. */
  agent?: AgentStateField;
  /** Attention-watcher metadata; only present for watched sessions. */
  attention?: AttentionDisplay;
  ms: number;
  error?: string;
}
interface WaitIdleResult {
  action: 'wait_idle';
  ok: boolean;
  target: string;
  name: string;
  /** Final pane content snapshot. */
  content: string;
  /** Shell: the pane stayed unchanged for idle_stable_ms. Coding agent:
   *  it is idle (done, ready for input). A dialog ends the wait too, with
   *  became_idle false and agent.state "blocked". */
  became_idle: boolean;
  agent?: AgentStateField;
  hint?: string;
  attention?: AttentionDisplay;
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
    agent?: {
      name: string;
      state: AgentStateField['state'];
      /** Working on the current task for this long, in seconds. */
      working_for_s?: number;
      /** How long the last finished task took, in seconds. */
      last_task_s?: number;
    };
    attention?: AttentionDisplay;
  }>;
}
interface ExplainResult {
  action: 'explain';
  ok: boolean;
  target: string;
  name: string;
  agent?: AgentStateField;
  explain?: unknown;
  error?: string;
}
interface KillResult {
  action: 'kill';
  ok: boolean;
  target: string;
  name: string;
  was_running: boolean;
}

type TmuxResult = (
  | CreateResult
  | SendResult
  | DriveActionResult
  | CaptureResult
  | WaitIdleResult
  | ListResult
  | ExplainResult
  | KillResult
) & { waiting_for_you?: WaitingEntry[] };

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

/** The caller's sessions that need attention, except `name` on `target`. */
function waitingFor(ctx: { agent: string; session?: string }, target: string, name?: string): WaitingEntry[] {
  try {
    const mirror = readAttentionMirror();
    const out: WaitingEntry[] = [];
    for (const o of listTmuxOrigins()) {
      if (o.agent !== ctx.agent) continue;
      if (o.session && ctx.session && o.session !== ctx.session) continue;
      const key = originKey(o.target, o.name);
      if (name !== undefined && key === originKey(target, name)) continue;
      const a = mirror[key];
      if (!a?.needs_attention) continue;
      out.push({
        name: o.name,
        ...(o.target ? { target: o.target } : {}),
        state: a.state,
        reason: a.state === 'blocked' ? 'dialog' : 'finished',
        ...(a.state === 'blocked' && a.rule ? { rule: a.rule } : {}),
        since: a.last_event_at,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Where a target's tmux commands run. */
function runnerFor(target: string, agent: string): Runner {
  return target === 'local' ? localRunner : remoteRunner(agent, target);
}

/** The agent state as the attention ledger records what was seen. */
function seen(agent: AgentStateField | null | undefined): SeenState | undefined {
  if (!agent) return undefined;
  if (agent.state === 'idle') return 'ready';
  if (agent.state === 'working') return 'running';
  if (agent.state === 'blocked') return 'blocked';
  return undefined;
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
  sawState?: SeenState,
  extra?: ObservationExtra,
): void {
  try {
    const origin = getTmuxOrigin(name, target);
    if (!origin) return;
    if (origin.agent !== ctx.agent) return;
    if (origin.session && ctx.session && origin.session !== ctx.session) return;
    recordTmuxObservation(originKey(target, name), ctx.agent, ctx.session, sawState, extra);
  } catch {
    /* ledger must never break the tool */
  }
}

/** Attention metadata for one local session, read from the watcher's
 *  mirror file. Empty when the watcher is off (boot clears the mirror)
 *  or the session isn't watched — zero traces when the feature is
 *  disabled (three-gates rule). */
function attentionFor(target: string, name: string): { attention?: AttentionDisplay } {
  try {
    const a = readAttentionMirror()[originKey(target, name)];
    return a ? { attention: a } : {};
  } catch {
    return {};
  }
}

/** The kind declared at create (an agent name), from the origin record. */
function lookupSessionKind(target: string, name: string): string | undefined {
  try {
    return getTmuxOrigin(name, target)?.kind;
  } catch {
    return undefined;
  }
}

const ACTIONS = ['create', 'start', 'prompt', 'new_conversation', 'send', 'capture', 'read', 'wait_idle', 'list', 'explain', 'kill'] as const;

export const tmux: ToolDefinition<z.infer<typeof TmuxInput>, TmuxResult> = {
  name: 'tmux',
  toolset: 'exec',
  description:
    'Drive long-lived terminal (tmux) sessions, locally on the somora server or on an SSH resource: ' +
    'coding agents (Claude Code, Codex, OpenCode, Pi and others), shells, REPLs. A session keeps ' +
    'running between your calls. For a one-shot command or a background job use exec instead.' +
    '\n\n' +
    'Coding agents — somora recognises the agent in a session and reports agent:{name, state}: ' +
    'idle (ready for input), working, blocked (an approval, question or startup dialog waits for an ' +
    'answer), unknown.\n' +
    '1. start: create a session (if needed), type the agent\'s command into its shell, return when the ' +
    'agent is ready. error agent_not_ready with state blocked = it stopped at a dialog (trust this ' +
    'folder, login, a settings question): read content and answer with send, or ask the person.\n' +
    '2. prompt: hand the agent a message (text). It is pasted and submitted as one message; with ' +
    'wait (default) the call returns when the agent is done or blocked. Read content for the answer ' +
    '(read for more lines). prompt refuses a blocked or working agent (agent_blocked, agent_busy) ' +
    'and says when the agent did not take the text (agent_prompt_stalled: capture before sending ' +
    'again, never twice blindly).\n' +
    '3. blocked: read the dialog, decide or ask the person, answer with send key:"Down" / "Enter" / ' +
    '"Escape" or keys:"1" — the send result shows the agent\'s state right after. Never approve ' +
    'something you do not understand.\n' +
    '4. A long task: prompt with wait:false or let wait time out, then end your turn — somora wakes ' +
    'you with a [tmux attention] turn when the agent stops working or needs an answer. While you are ' +
    'busy, results carry waiting_for_you: your other sessions that finished or wait at a dialog.\n' +
    '5. new_conversation: a fresh conversation before a new task (sends /new or /clear as the agent ' +
    'needs, answers Codex\'s worktree question with the current one, returns when idle).\n' +
    'Coordinating several agents: one session per agent with a clear name and role, a fresh ' +
    'conversation per task, and ask each to end its work with a short status (done | blocked, files ' +
    'changed, open questions). list shows each agent\'s state with working_for_s / last_task_s.' +
    '\n\n' +
    'Shells and REPLs: send types text (keys, \\n = Enter) or key names (key: Escape, C-c, C-u, Tab, ' +
    'F1, "C-x C-c"); capture reads the pane, with wait_pattern it waits for a text; wait_idle waits ' +
    'until the pane stops changing (for an agent: until it is idle or blocked). list shows the ' +
    'sessions on a target with their agents, explain shows which detection rule decided the state. ' +
    'Kill sessions you no longer need.' +
    '\n\n' +
    'Ghost text: Claude Code and Codex show a dim suggested input (agent.suggestion_visible). It is ' +
    'not typed input — ignore it. Never press Enter on input you did not type yourself.',
  inputSchema: TmuxInput,
  jsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: FIELD.action },
      target: { type: 'string', default: 'local', description: FIELD.target },
      name: { type: 'string', description: FIELD.name },
      cwd: { type: 'string', description: FIELD.cwd },
      command: { type: 'string', description: FIELD.command },
      text: { type: 'string', description: FIELD.text },
      wait: { type: 'boolean', default: true, description: FIELD.wait },
      keys: { type: 'string', description: FIELD.keys },
      key: { type: 'string', description: FIELD.key },
      multiline_safe: { type: 'boolean', default: false, description: FIELD.multiline_safe },
      wait_pattern: { type: 'string', description: FIELD.wait_pattern },
      wait_mode: { type: 'string', enum: ['auto', 'present', 'idle'], default: 'auto', description: FIELD.wait_mode },
      idle_stable_ms: { type: 'integer', minimum: 100, maximum: 10_000, default: DEFAULT_IDLE_STABLE_MS, description: FIELD.idle_stable_ms },
      wait_timeout_ms: { type: 'integer', minimum: 100, maximum: MAX_WAIT_TIMEOUT_MS, description: FIELD.wait_timeout_ms },
      include_ansi: { type: 'boolean', default: false, description: FIELD.include_ansi },
      lines: { type: 'integer', minimum: 1, maximum: 10_000, description: FIELD.lines },
      inherit_agent_env: { type: 'boolean', default: false, description: FIELD.inherit_agent_env },
      kind: { type: 'string', description: FIELD.kind },
      attention: { type: 'boolean', default: true, description: FIELD.attention },
    },
    required: ['action'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 30_000,
  // Waiting actions block up to their own timeout; the engine race gets
  // that plus a buffer. Other actions are quick (one tmux call).
  timeoutFromInput: (input) => {
    if (input.action === 'prompt') {
      return input.wait === false ? 30_000 : (input.wait_timeout_ms ?? DEFAULT_PROMPT_TIMEOUT_MS) + 15_000;
    }
    if (input.action === 'start') return (input.wait_timeout_ms ?? DEFAULT_START_TIMEOUT_MS) + 15_000;
    if (input.action === 'new_conversation') return (input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS) + 15_000;
    if (input.action === 'capture' && input.wait_pattern) return (input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS) + 2_000;
    if (input.action === 'wait_idle') return (input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS) + 5_000;
    if (input.action === 'list') return 30_000;
    return undefined;
  },
  maxTimeoutMs: MAX_WAIT_TIMEOUT_MS + 15_000,
  async handler(input, ctx): Promise<TmuxResult> {
    const r = await handle(input, ctx);
    if (r.action === 'list') return r;
    const target = input.target ?? 'local';
    const waiting = waitingFor(ctx, target, input.name);
    return waiting.length > 0 ? { ...r, waiting_for_you: waiting } : r;
  },
};

async function handle(input: z.infer<typeof TmuxInput>, ctx: { agent: string; session?: string }): Promise<TmuxResult> {
    const target = input.target ?? 'local';
    const run = runnerFor(target, ctx.agent);

    // create, and start in a session that does not exist yet.
    const createSession = async (name: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const r =
        target === 'local'
          ? await tmuxLocalCreate({
              name,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              inheritAgentEnv: input.inherit_agent_env === true,
            })
          : await tmuxRemoteCreate(ctx.agent, target, name, input.cwd);
      if (!r.ok) return { ok: false, error: r.stderr.trim() || `exit ${r.exit_code}` };
      // Origin record: who to wake, which kind was declared. Never blocks
      // the tool.
      {
        try {
          recordTmuxOrigin({
            name,
            target,
            agent: ctx.agent,
            ...(ctx.session ? { session: ctx.session } : {}),
            ...(input.kind && input.kind !== 'shell' ? { kind: input.kind } : {}),
            ...(input.attention === false ? { attention: false } : {}),
          });
        } catch (err) {
          logger.warn({ msg: 'tmux.origin.record_failed', name, err: (err as Error).message });
        }
      }
      return { ok: true };
    };

    if (input.action === 'create') {
      const name = requireName(input, 'create');
      const c = await createSession(name);
      if (!c.ok) return { action: 'create', ok: false, target, name, error: c.error };
      return {
        action: 'create',
        ok: true,
        target,
        name,
        hint:
          `Session ready (a shell). To run a coding agent in it use tmux({action:"start", name:"${name}", ` +
          `command:"<agent command>"}), then prompt. For a shell: send keys:"<command>\\n", capture to read, ` +
          `kill when done.`,
      };
    }

    if (input.action === 'start') {
      const name = requireName(input, 'start');
      if (!input.command) throw new Error('tmux start: requires `command` (e.g. "codex", "claude", "pi")');
      const exists = await run(`tmux has-session -t ${shellQuote(`=${name}`)}`);
      if (!exists.ok) {
        const c = await createSession(name);
        if (!c.ok) return { action: 'start', target, name, ok: false, error: 'tmux_error', hint: c.error, content: '', ms: 0 };
        await new Promise((r) => setTimeout(r, 300)); // the shell draws its prompt
      }
      const kind = input.kind ?? lookupSessionKind(target, name);
      const r = await startAgent(run, name, {
        command: input.command,
        ...(kind && kind !== 'shell' ? { kind } : {}),
        timeoutMs: input.wait_timeout_ms ?? DEFAULT_START_TIMEOUT_MS,
        lines: input.lines ?? 60,
      });
      noteObservation(target, name, ctx, seen(r.agent));
      return { action: 'start', target, name, ...r };
    }

    if (input.action === 'prompt') {
      const name = requireName(input, 'prompt');
      if (!input.text) throw new Error('tmux prompt: requires `text`');
      const kind = lookupSessionKind(target, name) ?? input.kind;
      const r = await promptAgent(run, name, {
        // The task's start for the watcher, written when Enter went out,
        // before the wait: the watcher looks every few seconds and may
        // see the task begin and end while this call still waits.
        onSubmitted: (at) => noteObservation(target, name, ctx, undefined, { promptedAt: at }),
        text: input.text,
        wait: input.wait !== false,
        timeoutMs: input.wait_timeout_ms ?? DEFAULT_PROMPT_TIMEOUT_MS,
        lines: input.lines ?? 60,
        ...(kind ? { kind } : {}),
      });
      if (r.submitted) noteObservation(target, name, ctx, r.settled ? seen(r.agent) : undefined);
      logger.info({ msg: 'tmux.prompt', target, name, ok: r.ok, error: r.error, state: r.agent?.state, ms: r.ms, text_len: input.text.length });
      return { action: 'prompt', target, name, ...r };
    }

    if (input.action === 'new_conversation') {
      const name = requireName(input, 'new_conversation');
      const kind = lookupSessionKind(target, name) ?? input.kind;
      // The agent working on its /new is no task: mark it the moment the
      // command goes out (the watcher may see it end while this call
      // still waits), close the mark after. Nothing sent, nothing marked.
      let resetFrom: number | null = null;
      const r = await newConversation(run, name, {
        onSubmitted: (at) => {
          resetFrom = at;
          noteObservation(target, name, ctx, undefined, { resetFrom: at, resetTo: undefined });
        },
        timeoutMs: input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS,
        lines: input.lines ?? 40,
        ...(kind ? { kind } : {}),
      });
      if (resetFrom !== null) noteObservation(target, name, ctx, r.ok ? seen(r.agent) : undefined, { resetFrom, resetTo: Date.now() });
      logger.info({ msg: 'tmux.new_conversation', target, name, ok: r.ok, error: r.error, command: r.command, dialog: r.dialog_answered, state: r.agent?.state, ms: r.ms });
      return { action: 'new_conversation', target, name, ...r };
    }

    if (input.action === 'send') {
      const name = requireName(input, 'send');
      const hasKeys = input.keys !== undefined;
      const hasKey = input.key !== undefined;
      if (hasKeys && hasKey) {
        throw new Error('tmux send: pass either `keys` (text) or `key` (control/function key name), not both');
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
          : await tmuxRemoteSend(ctx.agent, target, name, input.keys as string, input.multiline_safe ?? false);
      let agent: AgentStateField | null = null;
      if (r.ok) {
        // A moment for the program to react, then one look.
        await new Promise((res) => setTimeout(res, 600));
        const o = await observePane(run, name, { lines: 1 });
        if (!('error' in o)) agent = agentStateOf(o.look, lookupSessionKind(target, name));
        noteObservation(target, name, ctx, seen(agent));
      }
      return {
        action: 'send',
        ok: r.ok,
        target,
        name,
        ms: Date.now() - start,
        ...(agent ? { agent } : {}),
        ...(r.ok ? {} : { error: r.stderr.trim() || `exit ${r.exit_code}` }),
      };
    }

    if ((input.action === 'capture' && !input.wait_pattern) || input.action === 'read') {
      const name = requireName(input, input.action);
      const start = Date.now();
      const o = await observePane(run, name, {
        lines: input.lines ?? 200,
        ansi: input.action === 'capture' && input.include_ansi === true,
        joinWrapped: input.action === 'read',
      });
      if ('error' in o) {
        return { action: input.action, ok: false, target, name, content: '', matched_pattern: false, ms: Date.now() - start, error: o.error };
      }
      const agent = agentStateOf(o.look, lookupSessionKind(target, name));
      noteObservation(target, name, ctx, seen(agent));
      return {
        action: input.action,
        ok: true,
        target,
        name,
        content: o.look.content,
        matched_pattern: false,
        ms: Date.now() - start,
        ...(agent ? { agent } : {}),
        ...attentionFor(target, name),
      };
    }

    if (input.action === 'capture') {
      const name = requireName(input, 'capture');
      const lines = input.lines ?? 200;
      const includeAnsi = input.include_ansi ?? false;
      const start = Date.now();
      const pattern = input.wait_pattern as string;
      const mode = input.wait_mode ?? 'auto';
      const timeout = input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      const idleStableMs = input.idle_stable_ms ?? DEFAULT_IDLE_STABLE_MS;
      const deadline = start + timeout;

      // Give tmux a tick to render text a send right before typed, so
      // the baseline already holds it (no false "new output" match).
      await new Promise((res) => setTimeout(res, 100));
      const baselineCap = await runCapture(target, ctx.agent, name, lines, includeAnsi);
      const baseline = baselineCap.ok ? baselineCap.content : '';
      const baselineCount = countOccurrences(baseline, pattern);
      let lastContent = baseline;
      let lastError = baselineCap.ok ? undefined : baselineCap.error;
      let matched = false;

      function matchCheck(content: string, count: number): boolean {
        if (mode === 'present') return count > 0;
        if (mode === 'idle') return false; // decided with stability below
        // auto: more occurrences than at the start, or present with a
        // shell prompt at the end (the command finished).
        if (count > baselineCount) return true;
        if (count > 0 && hasReadyPromptAtEnd(content)) return true;
        return false;
      }

      let lastChangeTs = Date.now();
      let lastSeenContent = baseline;
      if (matchCheck(baseline, baselineCount)) matched = true;

      while (!matched && !lastError && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const sleepFor = mode === 'idle' ? Math.min(POLL_INTERVAL_MS, remaining, idleStableMs) : Math.min(POLL_INTERVAL_MS, remaining);
        await new Promise((res) => setTimeout(res, sleepFor));
        const cap = await runCapture(target, ctx.agent, name, lines, includeAnsi);
        if (!cap.ok) {
          lastError = cap.error;
          break;
        }
        lastContent = cap.content;
        const currentCount = countOccurrences(lastContent, pattern);
        if (mode === 'idle') {
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
        logger.info({ msg: 'tmux.capture.pattern_timeout', target, name, mode, pattern: pattern.slice(0, 80), waited_ms: Date.now() - start });
      }
      let agent: AgentStateField | null = null;
      if (!lastError) {
        const o = await observePane(run, name, { lines: 1 });
        if (!('error' in o)) agent = agentStateOf(o.look, lookupSessionKind(target, name));
        noteObservation(target, name, ctx, seen(agent));
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
        ...(agent ? { agent } : {}),
        ...attentionFor(target, name),
        ...(lastError ? { error: lastError } : {}),
      };
    }

    if (input.action === 'wait_idle') {
      const name = requireName(input, 'wait_idle');
      const lines = input.lines ?? 200;
      const idleStableMs = input.idle_stable_ms ?? DEFAULT_IDLE_STABLE_MS;
      const timeout = input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      const start = Date.now();
      const kind = lookupSessionKind(target, name);

      await new Promise((res) => setTimeout(res, 100));
      const first = await observePane(run, name, { lines });
      if ('error' in first) {
        return { action: 'wait_idle', ok: false, target, name, content: '', became_idle: false, ms: Date.now() - start, error: first.error };
      }

      // A coding agent: wait until it is idle or blocked.
      if (agentStateOf(first.look, kind)) {
        const w = await waitSettled(run, name, { timeoutMs: timeout, lines, ...(kind ? { kind } : {}) });
        noteObservation(target, name, ctx, w.settled ? seen(w.agent) : undefined);
        if (!w.settled && w.error !== 'timeout') {
          return { action: 'wait_idle', ok: false, target, name, content: w.content, became_idle: false, ms: Date.now() - start, error: w.hint ?? w.error, ...(w.agent ? { agent: w.agent } : {}) };
        }
        return {
          action: 'wait_idle',
          ok: true,
          target,
          name,
          content: w.content,
          became_idle: w.settled === true && w.agent?.state === 'idle',
          ms: Date.now() - start,
          ...(w.agent ? { agent: w.agent } : {}),
          ...(w.settled && w.agent?.state === 'blocked'
            ? { hint: 'The agent stopped at a dialog (blocked). Read content, then answer it with send or ask the person.' }
            : !w.settled
              ? { hint: w.hint }
              : {}),
          ...attentionFor(target, name),
        };
      }

      // A shell: the pane stays unchanged for idle_stable_ms.
      let lastContent = first.look.content;
      let lastChangeTs = Date.now();
      let becameIdle = false;
      let lastError: string | undefined;
      const deadline = start + timeout;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((res) => setTimeout(res, Math.min(POLL_INTERVAL_MS, remaining, idleStableMs)));
        const cap = await runCapture(target, ctx.agent, name, lines, false);
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
          becameIdle = true;
          break;
        }
      }
      if (!becameIdle && !lastError) {
        logger.info({ msg: 'tmux.wait_idle.timeout', target, name, waited_ms: Date.now() - start, idle_stable_ms: idleStableMs });
      }
      if (!lastError) noteObservation(target, name, ctx);
      return {
        action: 'wait_idle',
        ok: !lastError,
        target,
        name,
        content: lastContent,
        became_idle: becameIdle,
        ms: Date.now() - start,
        ...attentionFor(target, name),
        ...(lastError ? { error: lastError } : {}),
      };
    }

    if (input.action === 'list') {
      const r = target === 'local' ? await tmuxLocalList() : await tmuxRemoteList(ctx.agent, target);
      const mirror = readAttentionMirror();
      // The agent in each session — one look per session, a few at a time.
      const agents = new Map<string, { name: string; state: AgentStateField['state'] }>();
      const queue = [...r.sessions];
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let s = queue.shift(); s; s = queue.shift()) {
            const o = await observePane(run, s.name, { lines: 1 });
            if ('error' in o) continue;
            const a = agentStateOf(o.look, lookupSessionKind(target, s.name));
            if (a) agents.set(s.name, { name: a.name, state: a.state });
          }
        }),
      );
      const now = Date.now();
      const observations = readTmuxObservations();
      const sessions = r.sessions.map((s) => {
        const att = mirror[originKey(target, s.name)];
        const a = agents.get(s.name);
        // Handed a task the watcher has not seen yet (it looks every few
        // seconds): the task runs since the prompt.
        const prompted = observations[originKey(target, s.name)]?.promptedAt;
        // Only a prompt newer than the last task's end is still unspent.
        const unspent = prompted && now - prompted < 60_000 && prompted > (att?.task_ended_at ?? 0) && att?.state !== 'running';
        const startedAt = att?.task_started_at ?? (unspent ? prompted : null);
        const timing = {
          ...(a?.state === 'working' && startedAt ? { working_for_s: Math.round((now - startedAt) / 1000) } : {}),
          ...(att?.last_task_ms ? { last_task_s: Math.round(att.last_task_ms / 1000) } : {}),
        };
        return {
          ...s,
          ...(a ? { agent: { ...a, ...timing } } : {}),
          ...(att ? { attention: att } : {}),
        };
      });
      return { action: 'list', ok: r.ok, target, count: sessions.length, sessions };
    }

    if (input.action === 'explain') {
      const name = requireName(input, 'explain');
      const o = await observePane(run, name, { lines: 1 });
      if ('error' in o) return { action: 'explain', ok: false, target, name, error: o.error };
      const agent = agentStateOf(o.look, lookupSessionKind(target, name));
      if (!agent) {
        return { action: 'explain', ok: true, target, name, explain: { agent: null, processes: o.look.processes.map((p) => p.args.slice(0, 120)), note: 'no coding agent recognised in this pane' } };
      }
      const x = explainAgentState(agent.name, { screen: o.look.screen, title: o.look.title });
      return {
        action: 'explain',
        ok: true,
        target,
        name,
        agent,
        explain: x && {
          state: x.state,
          rule: x.rule ?? null,
          fallback: x.fallback ?? null,
          rules_from: x.source,
          ...(x.version ? { version: x.version } : {}),
          ...(x.path ? { path: x.path } : {}),
          title: o.look.title,
          matched_rules: x.rules.filter((r) => r.matched).map((r) => ({ id: r.id, state: r.state, priority: r.priority, region: r.region })),
          rules_checked: x.rules.length,
        },
      };
    }

    // kill
    const name = requireName(input, 'kill');
    const r = target === 'local' ? await tmuxLocalKill(name) : await tmuxRemoteKill(ctx.agent, target, name);
    {
      try {
        removeTmuxOrigin(name, target);
      } catch (err) {
        logger.warn({ msg: 'tmux.origin.remove_failed', name, err: (err as Error).message });
      }
    }
    // kill-session on a name that is gone: was_running false, not an error.
    if (!r.ok) {
      const wasMissing = r.stderr.includes("can't find session") || r.stderr.includes('no server running') || r.stderr.includes('session not found');
      if (wasMissing) return { action: 'kill', ok: true, target, name, was_running: false };
    }
    return { action: 'kill', ok: r.ok, target, name, was_running: r.ok };
}

export function tmuxTools(): ToolDefinition[] {
  return [tmux] as ToolDefinition[];
}
