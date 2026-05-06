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
} from './local.ts';
import {
  tmuxRemoteCapture,
  tmuxRemoteCreate,
  tmuxRemoteKill,
  tmuxRemoteList,
  tmuxRemoteSend,
} from './remote.ts';

const POLL_INTERVAL_MS = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 600_000; // 10 min — same ceiling as longTaskMax

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
        'send only — text to type into the session. Newlines (\\n) are sent as Enter keypresses; ' +
          'every other character goes through literally (no shell escaping needed). Append \\n ' +
          'yourself if you want the command to actually run.',
      ),
    wait_pattern: z
      .string()
      .min(1)
      .optional()
      .describe(
        'capture only — string to wait for in the pane content. Useful for "wait until prompt ' +
          'comes back" scenarios. The capture polls every 200ms until the pattern is found OR ' +
          'wait_timeout_ms elapses, then returns whatever\'s captured. Without wait_pattern: ' +
          'capture returns the current pane content immediately.',
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
): Promise<{ ok: boolean; content: string; error?: string }> {
  if (target === 'local') {
    const r = await tmuxLocalCapture({ name, lines });
    return r.ok
      ? { ok: true, content: r.stdout }
      : { ok: false, content: r.stdout, error: r.stderr.trim() || `exit ${r.exit_code}` };
  }
  const r = await tmuxRemoteCapture(agent, target, name, lines);
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
    'capture supports wait_pattern: useful for "wait for prompt to come back" — the call polls ' +
    'every 200ms until the pattern appears in the pane content or wait_timeout_ms elapses. ' +
    'Without wait_pattern, capture returns the current pane content immediately.',
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
      wait_pattern: { type: 'string' },
      wait_timeout_ms: {
        type: 'integer',
        minimum: 100,
        maximum: MAX_WAIT_TIMEOUT_MS,
        default: DEFAULT_WAIT_TIMEOUT_MS,
      },
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
          `keys:"<text>\\n"}) to type into it, then tmux({action:"capture", ...}) to read. ` +
          `tmux({action:"kill", ...}) when done.`,
      };
    }

    if (input.action === 'send') {
      const name = requireName(input, 'send');
      const keys = input.keys ?? '';
      const start = Date.now();
      const r =
        target === 'local'
          ? await tmuxLocalSend(name, keys)
          : await tmuxRemoteSend(ctx.agent, target, name, keys);
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
      const start = Date.now();

      // No wait_pattern: one-shot capture, return whatever's in the
      // pane right now.
      if (!input.wait_pattern) {
        const cap = await runCapture(target, ctx.agent, name, lines);
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

      // wait_pattern set: poll every 200ms until a NEW occurrence of
      // the pattern appears, or timeout.
      //
      // The trick: count pattern occurrences in the baseline first,
      // then on each poll count again — match only when the count
      // GROWS. This handles the common gotcha that the typed command
      // itself often contains the pattern (e.g. `echo done-marker`
      // shows 'done-marker' in the pane the moment it's typed,
      // before the command has even run). Counting catches the
      // ADDITIONAL occurrence that comes from the actual output.
      //
      // Subtle case: if the model's wait_pattern is something like
      // 'error' and the typed command happens to also contain it,
      // we still wait for an additional appearance — usually that's
      // what the model wants. If the pattern is unique enough to
      // appear once-and-only-once in the output, this works.
      const pattern = input.wait_pattern;
      const timeout = input.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
      const deadline = start + timeout;
      // Tiny pre-baseline sleep to dodge a race: if the model called
      // `tmux send keys="<cmd>\n"` immediately before this capture,
      // tmux's display buffer might not have rendered the typed
      // command yet (network round-trip + tmux's own update tick).
      // Without this delay our baseline could miss the typed text
      // → first poll sees the command appear → false-positive match.
      // 100ms is invisible to the model and reliable for this case.
      await new Promise((res) => setTimeout(res, 100));
      const baselineCap = await runCapture(target, ctx.agent, name, lines);
      const baseline = baselineCap.ok ? baselineCap.content : '';
      const baselineCount = countOccurrences(baseline, pattern);
      let lastContent = baseline;
      let lastError = baselineCap.ok ? undefined : baselineCap.error;
      let matched = false;
      while (!lastError && Date.now() < deadline) {
        // Sleep BEFORE re-capturing — gives the typed command time
        // to produce output. If we polled immediately we'd often
        // just see the baseline again.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((res) => setTimeout(res, Math.min(POLL_INTERVAL_MS, remaining)));
        const cap = await runCapture(target, ctx.agent, name, lines);
        if (!cap.ok) {
          lastError = cap.error;
          break;
        }
        lastContent = cap.content;
        const currentCount = countOccurrences(lastContent, pattern);
        if (currentCount > baselineCount) {
          matched = true;
          break;
        }
      }

      if (!matched && !lastError) {
        logger.info({
          msg: 'tmux.capture.pattern_timeout',
          target,
          name,
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
