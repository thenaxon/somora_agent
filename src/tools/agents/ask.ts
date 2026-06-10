// agent_ask — A2A live messaging (Phase 6c, Modus 2). One agent calls
// agent_ask({agent: '<other-agent>', message: '...'}); the target agent
// receives the message in ITS session as a user_message with from_agent
// set to the caller's name, runs a normal turn (memory auto-inject,
// tools, persona — all of it), and the reply text comes back inline.
//
// Session targeting: defaults to 'main'. The target agent's main session
// is the canonical "talk to it" entry point, same surface a human user
// types into.
//
// Lock + queue (src/server/session-queue.ts): an agent_ask call is
// priority='agent' and yields to any concurrent human user turn on the
// target's session — the user is never delayed by background A2A
// traffic. FIFO within the agent priority class. Sub-spawns to fresh
// sessions (spawn_subagent's sub-xxx-yyy) are uncontended; this lock
// only matters when multiple flows hit the SAME session.
//
// Timeout + pending: timeoutFromInput defaults to
// agentLoop.longTaskDefaultTimeoutMs (5 min) and clamps at
// longTaskMaxTimeoutMs (30 min). On timeout the tool returns
// state:'pending' (NOT an error) — the underlying call may still be
// queued or running on the target side; if it finishes, the response
// lands in the target's session JSONL. Programmatic retrieval of a
// pending response is a FUTURE item (planned `agent_ask_result` tool;
// see private/A2A-design.md).
//
// Self-call guard: agent_ask({agent: ctx.agent}) would deadlock the
// caller's own session lock. We refuse early with a clear error
// pointing at spawn_subagent (sealed self-clone) as the right tool.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolDefinition } from '../types.ts';
import { longTaskDefaultMs, longTaskMaxMs } from './long-task-timeouts.ts';

const TIMEOUT_BUFFER_MS = 2_000;

const AskInput = z
  .object({
    agent: z
      .string()
      .min(1)
      .describe(
        'Target agent name (e.g. "<agent-name>", "<other-agent>"). Must NOT be yourself — ' +
          'use spawn_subagent for self-clone tasks. Talks to the target\'s main session by default.',
      ),
    message: z
      .string()
      .min(1)
      .describe(
        'The message to send. Will appear in the target\'s session as a user_message ' +
          'with from_agent=<your name> so the target knows it\'s an A2A turn.',
      ),
    session: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Target session slug. Defaults to "main" — the target\'s primary conversation. ' +
          'Override only for unusual flows (e.g. picking up a sub-session).',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(7_200_000) // 2h hard schema cap; config caps further
      .optional()
      .describe(
        'Max ms to wait for the target\'s reply. Defaults to ' +
          'agentLoop.longTaskDefaultTimeoutMs (5 min); clamped at ' +
          'longTaskMaxTimeoutMs (30 min). On timeout the tool returns ' +
          'state:"pending" — the call may still complete; the reply ' +
          'lands in the target\'s session either way.',
      ),
  })
  .strict();

interface AskDoneResult {
  ok: true;
  state: 'done';
  call_id: string;
  target_agent: string;
  target_session: string;
  response: string;
  ms: number;
  usage?: {
    tokens_in: number;
    tokens_out: number;
    tokens_in_cached?: number;
    tokens_out_reasoning?: number;
  };
}

interface AskPendingResult {
  ok: false;
  state: 'pending';
  call_id: string;
  target_agent: string;
  target_session: string;
  hint: string;
  ms: number;
}

type AskResult = AskDoneResult | AskPendingResult;

export const agentAsk: ToolDefinition<z.infer<typeof AskInput>, AskResult> = {
  name: 'agent_ask',
  toolset: 'agents',
  description:
    'Send a live message to another somora agent and wait for their reply. Unlike spawn_subagent ' +
    '(which runs a sealed task in a fresh session), agent_ask writes into the target\'s actual ' +
    'session — so the target uses their full memory, persona, and conversation history to answer, ' +
    'and the exchange is visible in their session afterwards. Use this when you need the TARGET\'s ' +
    'expertise/state ("<agent>, what did the user say last week about X?"), NOT when you have a ' +
    'self-contained task you could delegate (use spawn_subagent for that). ' +
    'Defaults to the target\'s main session. Default timeout 5 min, cap 30 min — slow local ' +
    'models routinely need minutes. On timeout: returns state:"pending" (NOT an error); the call ' +
    'may still complete on the target side and land in their JSONL. ' +
    'IMPORTANT: cannot ask yourself — use spawn_subagent for self-clone tasks. ' +
    'Concurrent human user turns on the target\'s session take priority over your A2A call. ' +
    'agent_ask is REQUEST-RESPONSE, not a message bus: if YOU received a question via agent_ask ' +
    '(a user_message with from_agent set), your answer is your normal turn output — the asking ' +
    'agent receives it automatically as the result of their pending call. Never agent_ask your ' +
    'caller back to deliver an answer; circular calls are rejected (deadlock guard).',
  inputSchema: AskInput,
  jsonSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Target agent name.' },
      message: { type: 'string', description: 'Message text.' },
      session: {
        type: 'string',
        description: 'Target session slug (default "main").',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1000,
        description:
          'Max wait in ms. Default agentLoop.longTaskDefaultTimeoutMs (5 min); ' +
          'capped at longTaskMaxTimeoutMs (30 min).',
      },
    },
    required: ['agent', 'message'],
    additionalProperties: false,
  },
  // Engine race must accommodate the inner wait + 2s buffer (OpenClaw
  // pattern). Read at call time so config changes apply without restart.
  defaultTimeoutMs: 30_000,
  timeoutFromInput: (input) => {
    const requested = input.timeout_ms ?? longTaskDefaultMs();
    const clamped = Math.min(requested, longTaskMaxMs());
    return clamped + TIMEOUT_BUFFER_MS;
  },
  // Static safety fence; actual cap is dynamic via timeoutFromInput.
  maxTimeoutMs: 7_200_000 + TIMEOUT_BUFFER_MS,
  async handler(input, ctx): Promise<AskResult> {
    const targetAgent = input.agent;
    const targetSession = input.session ?? 'main';

    if (targetAgent === ctx.agent) {
      throw new Error(
        `agent_ask: can't ask yourself ('${ctx.agent}'). For a self-clone task in a fresh ` +
          `session, use spawn_subagent({ task: '...' }) (omit persona).`,
      );
    }

    const callId = randomUUID();
    const timeoutMs = Math.min(input.timeout_ms ?? longTaskDefaultMs(), longTaskMaxMs());

    logger.info({
      msg: 'agent_ask.start',
      from: ctx.agent,
      to: targetAgent,
      target_session: targetSession,
      call_id: callId,
      timeout_ms: timeoutMs,
      message_len: input.message.length,
    });

    const start = Date.now();
    const host = process.env.SOMORA_HOST || '127.0.0.1';
    const port = process.env.SOMORA_PORT || '18737';
    // SOMORA_TLS=1 → server is HTTP/2-over-TLS; A2A loopback must use
    // https://<publicHost> (see spawn.ts:runChatTurnViaHttp).
    const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';

    // AbortController hard-bounds the wait. If the timer fires before
    // the response comes back, the fetch errors with AbortError and we
    // return state:'pending'. The server-side call may still be queued
    // (in which case it'll eventually run and write to the target's
    // JSONL anyway) or in-flight (which we don't cancel — letting the
    // turn finish keeps the conversation intact in the target's session
    // even if the caller stopped listening).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const res = await loopbackFetch(`${scheme}://${host}:${port}/chat/send-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: targetAgent,
          session: targetSession,
          text: input.message,
          from_agent: ctx.agent,
          // waiter_* register this turn in the server's A2A wait-graph
          // (circular-wait detection, src/server/ask-wait-graph.ts).
          // Missing ctx.session (shouldn't happen — MCP children get
          // SOMORA_SESSION per turn) just degrades to no detection for
          // this call.
          ...(ctx.session ? { waiter_agent: ctx.agent, waiter_session: ctx.session } : {}),
          agent_ask_call_id: callId,
        }),
        signal: ac.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 409 circular_wait — the target's turn is (directly or via a
        // chain) already blocked waiting on THIS turn. Teach the model
        // the request-response pattern instead of surfacing a raw HTTP
        // error; this is the self-healing path for the Gideon↔Donna
        // deadlock (2026-06-01 feedback).
        if (res.status === 409 && body.includes('"circular_wait":true')) {
          let chain = '';
          try {
            const parsed = JSON.parse(body) as { chain?: string[] };
            if (Array.isArray(parsed.chain)) chain = parsed.chain.join(' → ');
          } catch {
            /* keep chain empty */
          }
          throw new Error(
            `agent_ask: rejected — ${targetAgent} is already blocked waiting on YOUR current ` +
              `turn` +
              (chain ? ` (wait chain: ${chain})` : '') +
              `. Your turn's final output is exactly what unblocks that wait: an agent_ask ` +
              `caller receives it as their tool result, a spawning parent receives it as the ` +
              `sub's result. Do NOT open a new agent_ask toward an agent that is waiting on ` +
              `you; just finish your current reply with the answer.`,
          );
        }
        throw new Error(
          `agent_ask: target ${targetAgent}/${targetSession} returned HTTP ${res.status}: ${body.slice(0, 300)}`,
        );
      }

      const data = (await res.json()) as {
        finalText?: string;
        usage?: AskDoneResult['usage'];
      };

      logger.info({
        msg: 'agent_ask.done',
        from: ctx.agent,
        to: targetAgent,
        call_id: callId,
        ms: Date.now() - start,
        reply_len: data.finalText?.length ?? 0,
      });

      return {
        ok: true,
        state: 'done',
        call_id: callId,
        target_agent: targetAgent,
        target_session: targetSession,
        response: data.finalText ?? '',
        ms: Date.now() - start,
        ...(data.usage ? { usage: data.usage } : {}),
      };
    } catch (err) {
      // Our own crafted errors (HTTP-status branch above, incl. the
      // circular-wait teaching message) are already actionable — pass
      // them through instead of re-wrapping via classifyFetchError.
      if (err instanceof Error && err.message.startsWith('agent_ask:')) {
        throw err;
      }
      // AbortError when our timer fired — translate to pending. Real
      // network errors (target unreachable, malformed response) bubble,
      // but we classify them first so the agent gets actionable info
      // instead of the bare `fetch failed` undici emits.
      if (ac.signal.aborted) {
        logger.info({
          msg: 'agent_ask.pending',
          from: ctx.agent,
          to: targetAgent,
          call_id: callId,
          waited_ms: Date.now() - start,
        });
        return {
          ok: false,
          state: 'pending',
          call_id: callId,
          target_agent: targetAgent,
          target_session: targetSession,
          hint:
            `${targetAgent} did not reply within timeout_ms (${timeoutMs}ms). ` +
            `The call may still be queued or in flight; if it completes, the response will land in ` +
            `${targetAgent}'s session ${targetSession} (visible in their TUI / JSONL). ` +
            `For programmatic retrieval of a pending response, see the planned agent_ask_result ` +
            `tool (FUTURE). To wait longer NOW, retry agent_ask with a higher timeout_ms.`,
          ms: Date.now() - start,
        };
      }
      const classified = classifyFetchError(err);
      logger.warn({
        msg: 'agent_ask.fetch_error',
        from: ctx.agent,
        to: targetAgent,
        call_id: callId,
        waited_ms: Date.now() - start,
        category: classified.category,
        code: classified.code,
        err: classified.message,
      });
      throw new Error(
        `agent_ask [${classified.category}${classified.code ? '/' + classified.code : ''}]: ` +
          `${classified.message}` +
          (classified.hint ? ` — hint: ${classified.hint}` : ''),
      );
    } finally {
      clearTimeout(timer);
    }
  },
};
