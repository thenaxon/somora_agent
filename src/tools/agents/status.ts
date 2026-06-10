// subagent_status / subagent_result — companion tools to
// spawn_subagent's wait:false (default) async path. Used by the
// orchestrator agent to poll progress and pull final results out.

import { z } from 'zod';
import { findWaitCycle, registerWait } from '../../server/ask-wait-graph.ts';
import { getTask, listTasksForAgent, waitForTaskCompletion, type AsyncTaskEntry } from '../../server/async-tasks.ts';
import { loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ChatTurnResult } from '../../server/run-turn-types.ts';
import type { ToolDefinition } from '../types.ts';
import { longTaskDefaultMs, longTaskMaxMs } from './long-task-timeouts.ts';

// In-process MCP child path runs without server-side task store
// access; we route status/result HTTP calls back to the main server
// just like spawn-async itself does.
async function fetchStatusViaHttp(task_id: string): Promise<AsyncTaskEntry | null> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  // SOMORA_TLS=1 → loopback must use HTTPS to match the cert hostname.
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const res = await loopbackFetch(
    `${scheme}://${host}:${port}/spawn-status?task_id=${encodeURIComponent(task_id)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`spawn-status HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as AsyncTaskEntry;
}

async function fetchResultViaHttp(
  task_id: string,
  opts: {
    wait_until_done?: boolean;
    timeout_ms?: number;
    /** Caller turn identity for the server-side circular-wait guard —
     *  see /spawn-result in src/server/index.ts. */
    waiter_agent?: string;
    waiter_session?: string;
  } = {},
): Promise<{
  task_id: string;
  state: string;
  result?: ChatTurnResult;
  error?: string;
  circular_wait?: boolean;
  chain?: string[];
} | null> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const params = new URLSearchParams({ task_id });
  if (opts.wait_until_done) params.set('wait_until_done', '1');
  if (opts.timeout_ms !== undefined) params.set('timeout_ms', String(opts.timeout_ms));
  if (opts.waiter_agent && opts.waiter_session) {
    params.set('waiter_agent', opts.waiter_agent);
    params.set('waiter_session', opts.waiter_session);
  }
  const res = await loopbackFetch(`${scheme}://${host}:${port}/spawn-result?${params.toString()}`);
  if (res.status === 404) return null;
  if (res.status === 409) {
    return (await res.json()) as {
      task_id: string;
      state: string;
      error?: string;
      circular_wait?: boolean;
      chain?: string[];
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`spawn-result HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as { task_id: string; state: string; result?: ChatTurnResult };
}

const StatusInput = z.object({ task_id: z.string().min(1) }).strict();

export const subagentStatus: ToolDefinition<z.infer<typeof StatusInput>> = {
  name: 'subagent_status',
  toolset: 'agents',
  description:
    'Check the status of a sub-agent task spawned with wait:false. Returns running/done/failed ' +
    'plus the target agent + session and timestamps. Cheap — call this freely. Use it when ' +
    'the user asks about progress ("are the subs done yet?"). Use subagent_result to fetch the ' +
    'actual answer once state is "done".',
  inputSchema: StatusInput,
  jsonSchema: {
    type: 'object',
    properties: { task_id: { type: 'string', description: 'task_id from a wait:false spawn_subagent return value.' } },
    required: ['task_id'],
    additionalProperties: false,
  },
  async handler(input) {
    // In-process first; HTTP fallback if not present (MCP child path).
    let entry = getTask(input.task_id);
    if (!entry) {
      const remote = await fetchStatusViaHttp(input.task_id);
      if (!remote) throw new Error(`subagent_status: task '${input.task_id}' not found`);
      entry = remote;
    }
    return {
      task_id: entry.task_id,
      state: entry.state,
      parent_agent: entry.parent_agent,
      parent_session: entry.parent_session,
      target_agent: entry.target_agent,
      target_session: entry.target_session,
      started_at: entry.started_at,
      ...(entry.finished_at !== undefined ? { finished_at: entry.finished_at } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  },
};

const ResultInput = z
  .object({
    task_id: z.string().min(1),
    wait_until_done: z
      .boolean()
      .default(false)
      .describe(
        'When true, the tool blocks server-side until the task finishes (or timeout_ms elapses) ' +
          'instead of erroring on "still running". Use this to avoid burning your own ' +
          'agent-loop tool-call rounds on a polling loop.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      // Schema cap is the absolute hard ceiling we'll ever permit; the
      // *effective* per-call cap is agentLoop.longTaskMaxTimeoutMs (read
      // at handler time via longTaskMaxMs()). Set the schema cap higher
      // than any reasonable config value so config drives it, not zod.
      .max(7_200_000) // 2 h schema ceiling — config caps further
      .optional()
      .describe(
        'Max ms to wait when wait_until_done. Defaults to ' +
          'agentLoop.longTaskDefaultTimeoutMs (5 min) and is hard-capped at ' +
          'agentLoop.longTaskMaxTimeoutMs (30 min). Pass higher than the ' +
          'cap and the cap wins; the sub keeps running in the background.',
      ),
  })
  .strict();

// OpenClaw-style buffer: when the tool is waiting up to N ms internally,
// give the engine race N + this much before it pulls the rug. Keeps the
// inner+outer timing aligned without races at the boundary.
const TIMEOUT_BUFFER_MS = 2_000;

/**
 * Hint returned instead of blocking when the sub is (directly or via a
 * chain) waiting on the CALLER's own turn. Blocking here would deadlock
 * until both timeouts fire: the caller holds its session lock while
 * waiting, and the sub's pending agent_ask to the caller queues on
 * exactly that lock. The teaching hint makes the situation self-healing
 * — the caller finishes its turn, the sub's queued question runs and
 * gets answered, the sub completes, and the result is fetchable on the
 * caller's next turn. See src/server/ask-wait-graph.ts.
 */
function circularWaitHint(chain?: string[]): string {
  return (
    `deadlock guard: this sub is currently blocked waiting on YOUR turn` +
    (chain && chain.length > 0 ? ` (wait chain: ${chain.join(' → ')})` : '') +
    `. Blocking on its result now would hang both of you. Finish your current turn — ` +
    `the sub's pending question to you will then be answered in your session ` +
    `automatically — and fetch the result with subagent_result in a later turn.`
  );
}

export const subagentResult: ToolDefinition<z.infer<typeof ResultInput>> = {
  name: 'subagent_result',
  toolset: 'agents',
  description:
    'Fetch the result of a sub-agent task. Returns one of three states: ' +
    '"done" (with result text + usage), "failed" (with error), or "pending" ' +
    '(task still running). ' +
    'Pass `wait_until_done: true` to block server-side until the task finishes — much more ' +
    'efficient than polling subagent_status in a loop, since each poll burns one of your own ' +
    'agent-loop tool-call rounds. Default `timeout_ms` is 5min (configurable via ' +
    'agentLoop.longTaskDefaultTimeoutMs); hard cap 30min (longTaskMaxTimeoutMs). ' +
    'IMPORTANT: state "pending" is NOT an error — the sub is still working. Do NOT immediately ' +
    'retry; either wait and call subagent_status later, or call this again with a higher ' +
    'timeout_ms. Repeated pending returns mean the sub legitimately needs more time. ' +
    'Deadlock guard: if the sub is itself blocked waiting on YOUR turn (e.g. it agent_asked ' +
    'you and the call is queued behind your current turn), wait_until_done returns "pending" ' +
    'immediately with an explanatory hint instead of blocking — finish your turn first.',
  inputSchema: ResultInput,
  jsonSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      wait_until_done: { type: 'boolean', description: 'Block until task finishes. Default false.' },
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        description:
          'Max wait in ms. Defaults to agentLoop.longTaskDefaultTimeoutMs ' +
          '(5 min); capped at longTaskMaxTimeoutMs (30 min).',
      },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  // Engine-level race must accommodate the tool's internal wait. Without
  // wait_until_done the tool returns immediately, so 30s is plenty. With
  // wait_until_done the inner wait is the caller's clamped timeout — give
  // the engine that + 2s buffer to round-trip the reply. Read config
  // values at call time so a runtime config change takes effect on the
  // next invocation.
  defaultTimeoutMs: 30_000,
  timeoutFromInput: (input) => {
    if (!input.wait_until_done) return undefined;
    // longTaskDefaultMs/longTaskMaxMs are read at call time (not module
    // load), so a config change takes effect on the next invocation
    // without a server restart. The actual clamping happens here; the
    // tool's static maxTimeoutMs below is just an upper safety fence.
    const requested = input.timeout_ms ?? longTaskDefaultMs();
    const clamped = Math.min(requested, longTaskMaxMs());
    return clamped + TIMEOUT_BUFFER_MS;
  },
  // Static safety fence in case timeoutFromInput is bypassed somehow;
  // 2h + buffer comfortably accommodates any reasonable longTaskMaxMs
  // setting without re-evaluating per-call.
  maxTimeoutMs: 7_200_000 + TIMEOUT_BUFFER_MS,
  async handler(input, ctx) {
    // Resolve effective timeout once per call; reused for the actual
    // wait below and surfaced in the pending hint so the caller knows
    // what value got applied (especially when their requested value was
    // clamped down by longTaskMaxMs).
    const effectiveTimeoutMs = input.wait_until_done
      ? Math.min(input.timeout_ms ?? longTaskDefaultMs(), longTaskMaxMs())
      : 0;
    let local = getTask(input.task_id);
    if (local) {
      // getTask only hits in the MAIN SERVER process (the MCP child has
      // its own empty task map and falls through to HTTP below), so the
      // wait-graph here is the authoritative instance.
      if (local.state === 'running' && input.wait_until_done) {
        // wait_until_done is a blocking A2A wait like agent_ask /
        // spawn wait:true — it must be cycle-CHECKED (the sub may
        // already be waiting on this caller) and edge-REGISTERED (so
        // other calls see this wait). Unlike agent_ask we don't error
        // on a cycle: the task is legitimately still running, so we
        // return state:'pending' with a hint instead of blocking into
        // a guaranteed dual-timeout hang.
        const waiter = ctx.session
          ? { agent: ctx.agent, session: ctx.session }
          : undefined;
        const target = { agent: local.target_agent, session: local.target_session };
        if (waiter) {
          const cycle = findWaitCycle(waiter, target);
          if (cycle) {
            return {
              task_id: local.task_id,
              state: 'pending' as const,
              target_agent: local.target_agent,
              target_session: local.target_session,
              hint: circularWaitHint(cycle),
            };
          }
        }
        const releaseWait = waiter ? registerWait(waiter, target) : undefined;
        try {
          local = (await waitForTaskCompletion(input.task_id, effectiveTimeoutMs)) ?? local;
        } finally {
          releaseWait?.();
        }
      }
      if (local.state === 'running') {
        return {
          task_id: local.task_id,
          state: 'pending' as const,
          target_agent: local.target_agent,
          target_session: local.target_session,
          hint: input.wait_until_done
            ? 'sub still running after timeout_ms; call again with a higher timeout_ms or check subagent_status later'
            : 'sub still running; pass wait_until_done:true to block, or call subagent_status to peek',
        };
      }
      if (local.state === 'failed') {
        return {
          task_id: local.task_id,
          state: 'failed' as const,
          target_agent: local.target_agent,
          target_session: local.target_session,
          error: local.error ?? 'unknown error',
        };
      }
      return {
        task_id: local.task_id,
        state: 'done' as const,
        target_agent: local.target_agent,
        target_session: local.target_session,
        result: local.result?.finalText ?? '',
        usage: local.result?.usage,
        ms: local.result?.ms,
      };
    }
    // HTTP fallback (MCP child) — pass the wait params through. The
    // circular-wait guard runs server-side in /spawn-result (the child
    // can't see the main server's wait-graph); waiter_* carry this
    // turn's identity over.
    const remote = await fetchResultViaHttp(input.task_id, {
      wait_until_done: input.wait_until_done,
      timeout_ms: input.timeout_ms,
      ...(ctx.session ? { waiter_agent: ctx.agent, waiter_session: ctx.session } : {}),
    });
    if (!remote) throw new Error(`subagent_result: task '${input.task_id}' not found`);
    if (remote.state === 'running') {
      return {
        task_id: remote.task_id,
        state: 'pending' as const,
        hint: remote.circular_wait
          ? circularWaitHint(remote.chain)
          : input.wait_until_done
            ? 'sub still running after timeout_ms; call again with a higher timeout_ms or check subagent_status later'
            : 'sub still running; pass wait_until_done:true to block, or call subagent_status to peek',
      };
    }
    if (remote.state === 'failed') {
      return {
        task_id: remote.task_id,
        state: 'failed' as const,
        error: remote.error ?? 'unknown error',
      };
    }
    return {
      task_id: remote.task_id,
      state: 'done' as const,
      result: remote.result?.finalText ?? '',
      usage: remote.result?.usage,
      ms: remote.result?.ms,
    };
  },
};

// ─────────────────────────────────────────────────────────────────────
// subagent_list — enumerate spawn tasks initiated by the calling agent
// ─────────────────────────────────────────────────────────────────────

async function fetchListViaHttp(parent_agent: string): Promise<AsyncTaskEntry[]> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const res = await loopbackFetch(
    `${scheme}://${host}:${port}/spawn-list?parent_agent=${encodeURIComponent(parent_agent)}`,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`spawn-list HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { tasks: AsyncTaskEntry[] };
  return json.tasks;
}

const ListInput = z
  .object({
    state: z
      .enum(['running', 'done', 'failed', 'all'])
      .default('all')
      .describe(
        'Filter by task state. "running" shows only active subs, "done"/"failed" only finished, ' +
          '"all" (default) returns everything still in the registry. Tasks are kept in memory for ' +
          'the server\'s lifetime and lost on restart.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe('Max entries to return after sort. Newest tasks come first.'),
  })
  .strict();

export const subagentList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'subagent_list',
  toolset: 'agents',
  description:
    'List sub-agent tasks YOU spawned (this agent\'s own subs only — no peer-agent visibility). ' +
    'Use this when you need to know what\'s still running in the background, e.g. "are the ' +
    'research subs done yet before I summarize?", "did anything from earlier finish?", or just ' +
    'a sanity-check before composing a reply that depends on prior spawns. ' +
    'Returns one entry per task with task_id, state, target_agent/session, started_at, ' +
    'finished_at (if done). Sorted newest-first. ' +
    'Tasks live in the server\'s in-memory registry only — server restarts wipe them ' +
    '(JSONL session files persist independently). To inspect a specific task in detail, ' +
    'use subagent_status (state + timestamps) or subagent_result (final answer).',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        enum: ['running', 'done', 'failed', 'all'],
        default: 'all',
        description: 'Filter by task state.',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    // In-process first; HTTP fallback for MCP-child path (subprocess
    // doesn't share the async-tasks Map with the main server).
    let entries = listTasksForAgent(ctx.agent);
    if (entries.length === 0) {
      // Either no tasks for this agent OR we're an MCP child without
      // direct access. The HTTP endpoint distinguishes — empty list
      // back means "really none".
      try {
        entries = await fetchListViaHttp(ctx.agent);
      } catch {
        // HTTP fallback failed (server unreachable); treat as no tasks
        // rather than throwing — list is best-effort discovery.
        entries = [];
      }
    }
    const filtered = input.state === 'all'
      ? entries
      : entries.filter((e) => e.state === input.state);
    // Newest first by started_at.
    filtered.sort((a, b) => b.started_at - a.started_at);
    const truncated = filtered.length > input.limit;
    const tasks = filtered.slice(0, input.limit).map((t) => ({
      task_id: t.task_id,
      state: t.state,
      target_agent: t.target_agent,
      target_session: t.target_session,
      started_at: t.started_at,
      ...(t.finished_at !== undefined ? { finished_at: t.finished_at } : {}),
      ...(t.error ? { error: t.error } : {}),
    }));
    return {
      count: tasks.length,
      truncated,
      tasks,
    };
  },
};
