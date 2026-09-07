// agent_ask_result — pick up the outcome of an agent_ask call that
// returned state:'pending' (the target did not answer within
// timeout_ms). Companion to agent_ask the way subagent_result is to
// spawn_subagent wait:false.
//
// Why it exists: a pending agent_ask is NOT a failure — the target's
// turn may still be queued behind a human turn or running on a slow
// local model. Re-sending the message (the old hint) risks executing
// the target's work twice (2026-09-06 a2a-pending-result-retrieval
// report: a media handoff that would have rendered twice). This tool
// lets the caller check or wait on the SAME call instead.
//
// Thin HTTP client: the call registry (src/server/ask-calls.ts) lives
// in the main server process, and the blocking wait must be cycle-
// checked against the A2A wait-graph there — so both the in-process
// (openai-compatible) and MCP-child (claude-cli / codex-cli) paths go
// through GET /a2a/ask-result.

import { z } from 'zod';
import { loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolDefinition } from '../types.ts';
import { longTaskDefaultMs, longTaskMaxMs } from './long-task-timeouts.ts';

const TIMEOUT_BUFFER_MS = 2_000;

const Input = z
  .object({
    call_id: z.string().min(1).describe('call_id from an agent_ask result (pending or done).'),
    wait_until_done: z
      .boolean()
      .optional()
      .describe('Block server-side until the call finishes (or timeout_ms passes). Default false.'),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(7_200_000)
      .optional()
      .describe(
        'Max wait in ms when wait_until_done is true. Defaults to ' +
          'agentLoop.longTaskDefaultTimeoutMs (5 min); clamped at longTaskMaxTimeoutMs (30 min).',
      ),
    agent: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Target agent of the original call. Only needed after a server restart, when the ' +
          'in-memory record is gone and the answer has to be read from the target session.',
      ),
    session: z
      .string()
      .min(1)
      .optional()
      .describe('Target session of the original call (see `agent`).'),
  })
  .strict();

type InputT = z.infer<typeof Input>;

export interface AskResultOutcome {
  call_id: string;
  /** done = reply available; failed = the target's turn errored; pending = still queued/running. */
  state: 'done' | 'failed' | 'pending';
  /** Finer phase while pending: queued behind another turn, or running. */
  phase?: 'queued' | 'running';
  target_agent?: string;
  target_session?: string;
  response?: string;
  error?: string;
  outcome?: string;
  ms?: number;
  source?: 'registry' | 'history';
  hint?: string;
}

interface ServerAskResult {
  call_id: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'unknown';
  target_agent?: string;
  target_session?: string;
  started_at?: number;
  finished_at?: number;
  response?: string;
  error?: string;
  outcome?: string;
  source?: 'registry' | 'history';
  circular_wait?: boolean;
  chain?: string[];
}

export const agentAskResult: ToolDefinition<InputT, AskResultOutcome> = {
  name: 'agent_ask_result',
  toolset: 'agents',
  description:
    'Fetch the outcome of an agent_ask call by its call_id — use this when agent_ask returned ' +
    'state:"pending" (the target did not answer within timeout_ms). Returns "done" (with the ' +
    'target\'s reply), "failed" (with the error — e.g. the target\'s model was unreachable), or ' +
    '"pending" (still queued behind another turn, or running). NEVER re-send the original ' +
    'message to "wait longer": the target is still working on it and would do the work twice. ' +
    'Pass `wait_until_done: true` to block server-side until it finishes — cheaper than polling, ' +
    'since each poll costs one of your own tool-call rounds. Default timeout 5 min, cap 30 min. ' +
    'Deadlock guard: if the target is itself waiting on YOUR current turn, the wait returns ' +
    '"pending" immediately with a hint — finish your turn first. After a somora restart pass ' +
    '`agent` + `session` of the original call so the reply can be read from the target session.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      call_id: { type: 'string', description: 'call_id from an agent_ask result.' },
      wait_until_done: { type: 'boolean', description: 'Block until the call finishes. Default false.' },
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        description: 'Max wait in ms with wait_until_done (default 5 min, cap 30 min).',
      },
      agent: { type: 'string', description: 'Target agent of the original call (only after a restart).' },
      session: { type: 'string', description: 'Target session of the original call (only after a restart).' },
    },
    required: ['call_id'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 30_000,
  timeoutFromInput: (input) => {
    if (!input.wait_until_done) return undefined;
    const requested = input.timeout_ms ?? longTaskDefaultMs();
    return Math.min(requested, longTaskMaxMs()) + TIMEOUT_BUFFER_MS;
  },
  maxTimeoutMs: 7_200_000 + TIMEOUT_BUFFER_MS,
  async handler(input, ctx): Promise<AskResultOutcome> {
    const host = process.env.SOMORA_HOST || '127.0.0.1';
    const port = process.env.SOMORA_PORT || '18737';
    const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
    const timeoutMs = input.wait_until_done
      ? Math.min(input.timeout_ms ?? longTaskDefaultMs(), longTaskMaxMs())
      : 0;

    const params = new URLSearchParams({ call_id: input.call_id });
    if (input.wait_until_done) {
      params.set('wait_until_done', '1');
      params.set('timeout_ms', String(timeoutMs));
    }
    if (input.agent) params.set('agent', input.agent);
    if (input.session) params.set('session', input.session);
    if (ctx.session) {
      params.set('waiter_agent', ctx.agent);
      params.set('waiter_session', ctx.session);
    }

    const res = await loopbackFetch(`${scheme}://${host}:${port}/a2a/ask-result?${params.toString()}`, {
      signal: AbortSignal.timeout(timeoutMs + 30_000),
    });
    if (res.status === 404) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `agent_ask_result: call '${input.call_id}' is unknown` +
          (input.agent && input.session
            ? ` — no user_message with that call_id in ${input.agent}/${input.session}.`
            : `. If somora restarted since the call, pass agent + session of the original ` +
              `agent_ask so the reply can be read from the target session.`) +
          (body ? ` (${body.slice(0, 200)})` : ''),
      );
    }
    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => '');
      throw new Error(`agent_ask_result: HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as ServerAskResult;

    const base = {
      call_id: data.call_id,
      ...(data.target_agent ? { target_agent: data.target_agent } : {}),
      ...(data.target_session ? { target_session: data.target_session } : {}),
      ...(data.source ? { source: data.source } : {}),
      ...(data.started_at !== undefined
        ? { ms: (data.finished_at ?? Date.now()) - data.started_at }
        : {}),
    };

    if (data.circular_wait) {
      return {
        ...base,
        state: 'pending',
        phase: 'running',
        hint:
          `deadlock guard: ${data.target_agent ?? 'the target'} is currently blocked waiting on YOUR ` +
          `turn` +
          (data.chain && data.chain.length > 0 ? ` (wait chain: ${data.chain.join(' → ')})` : '') +
          `. Waiting here would hang both of you. Finish your current turn — its output answers ` +
          `their pending question — and fetch this result in a later turn.`,
      };
    }
    if (data.state === 'done') {
      return {
        ...base,
        state: 'done',
        response: data.response ?? '',
        ...(data.outcome ? { outcome: data.outcome } : {}),
      };
    }
    if (data.state === 'failed') {
      return {
        ...base,
        state: 'failed',
        error: data.error ?? 'target turn failed',
        ...(data.response ? { response: data.response } : {}),
        hint:
          'The target could not produce a reply (model/engine failure). Retrying the original ' +
          'agent_ask is safe ONLY if the target did no side-effecting work — check its session ' +
          'or ask it explicitly before re-issuing a task.',
      };
    }
    const phase: 'queued' | 'running' = data.state === 'queued' ? 'queued' : 'running';
    return {
      ...base,
      state: 'pending',
      phase,
      hint:
        phase === 'queued'
          ? `The call is queued behind another turn on ${data.target_agent}/${data.target_session}. ` +
            `Do not re-send. Call agent_ask_result again (wait_until_done:true blocks until it runs).`
          : `${data.target_agent} is still working on this call` +
            (data.state === 'unknown'
              ? ' (no turn_end in the session yet — if the server restarted mid-turn the turn was lost; ' +
                'check the session before re-issuing)'
              : '') +
            `. Do not re-send; call agent_ask_result again` +
            (input.wait_until_done ? ' with a higher timeout_ms.' : ' with wait_until_done:true.'),
    };
  },
};
