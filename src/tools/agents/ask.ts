// agent_ask — A2A live messaging (Phase 6c, Modus 2). One agent calls
// agent_ask({agent: '<other-agent>', message: '...'}); the target agent
// receives the message in ITS session as a user_message with from_agent
// set to the caller's name, runs a normal turn (memory auto-inject,
// tools, persona — all of it), and the reply text comes back inline.
//
// Session targeting: an explicit `session` always wins. Without one,
// the default is context-sensitive (2026-09-06 report — replies to a
// project session kept landing in main): when the CURRENT turn is
// itself an A2A turn from agent X (or a sub-agent whose parent is X)
// and the target is X, the message goes back to the session X wrote
// from (GET /a2a/turn-origin). Otherwise 'main' — the target agent's
// canonical "talk to it" entry point, same surface a human types into.
//
// Every call carries from_session so the receiver's header reads
// `[Message from agent hans, session cerebrocraft]` and it can address
// a follow-up. An unknown session slug returns the target's existing
// sessions instead of a bare 404.
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
// queued or running on the target side. The outcome is retrievable by
// call_id through agent_ask_result (src/tools/agents/ask-result.ts,
// backed by src/server/ask-calls.ts) — never by re-sending the message.
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
          'use spawn_subagent for self-clone tasks.',
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
        'Target session slug (or id). Default: if you are answering a message that THIS agent ' +
          'sent you (A2A, or it is your spawning parent), the session they wrote from — ' +
          'otherwise "main". Pass it explicitly to talk to a specific project session; an unknown ' +
          'slug returns the target\'s existing sessions.',
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
  /** True when `session` was omitted and the reply-back default picked
   *  the asker's source session instead of main. */
  session_inferred?: boolean;
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
  session_inferred?: boolean;
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
    'Session: when you are replying to an agent that wrote to you (their message carries ' +
    '"[Message from agent X, session Y]") and omit `session`, the message goes back to that ' +
    'session Y; otherwise to the target\'s main session. Pass `session` explicitly for a specific ' +
    'project session. Default timeout 5 min, cap 30 min — slow local ' +
    'models routinely need minutes. On timeout: returns state:"pending" (NOT an error); the call ' +
    'may still complete on the target side — fetch or wait for it with agent_ask_result ' +
    '(call_id), never by re-sending the message. ' +
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
        description:
          'Target session slug or id. Default: the session your asker wrote from when the target ' +
          'is that asker (A2A reply-back / your spawning parent), otherwise "main".',
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

    if (targetAgent === ctx.agent) {
      throw new Error(
        `agent_ask: can't ask yourself ('${ctx.agent}'). For a self-clone task in a fresh ` +
          `session, use spawn_subagent({ task: '...' }) (omit persona).`,
      );
    }

    const callId = randomUUID();
    const timeoutMs = Math.min(input.timeout_ms ?? longTaskDefaultMs(), longTaskMaxMs());

    const host = process.env.SOMORA_HOST || '127.0.0.1';
    const port = process.env.SOMORA_PORT || '18737';
    // SOMORA_TLS=1 → server is HTTP/2-over-TLS; A2A loopback must use
    // https://<publicHost> (see spawn.ts:runChatTurnViaHttp).
    const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
    const base = `${scheme}://${host}:${port}`;

    // Reply-back default: no explicit session + this turn was started
    // by the target (A2A inbound or spawning parent) → their session.
    let targetSession = input.session ?? 'main';
    let sessionInferred = false;
    if (!input.session && ctx.session) {
      const origin = await lookupTurnOrigin(base, ctx.agent, ctx.session);
      if (origin && origin.agent === targetAgent && origin.session) {
        targetSession = origin.session;
        sessionInferred = true;
        logger.info({
          msg: 'agent_ask.session_inferred',
          from: ctx.agent,
          from_session: ctx.session,
          to: targetAgent,
          session: targetSession,
          origin_kind: origin.kind,
          call_id: callId,
        });
      }
    }

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
      const res = await loopbackFetch(`${base}/chat/send-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: targetAgent,
          session: targetSession,
          text: input.message,
          from_agent: ctx.agent,
          // from_session lets the target address a follow-up to the
          // session this question came from (header + reply-back default).
          ...(ctx.session ? { from_session: ctx.session } : {}),
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
        if (res.status === 404 && body.includes('"known_sessions"')) {
          let known: string[] = [];
          try {
            const parsed = JSON.parse(body) as { known_sessions?: string[] };
            if (Array.isArray(parsed.known_sessions)) known = parsed.known_sessions;
          } catch {
            /* keep known empty */
          }
          throw new Error(
            `agent_ask: session '${targetSession}' does not exist for agent ${targetAgent}. ` +
              (known.length > 0
                ? `Existing sessions: ${known.join(', ')}. Pick one of these (or omit session ` +
                  `for the default) — do NOT fall back to main for project work.`
                : `That agent has no sessions yet; omit session to use main.`),
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
        ...(sessionInferred ? { session_inferred: true } : {}),
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
          ...(sessionInferred ? { session_inferred: true } : {}),
          hint:
            `${targetAgent} did not reply within timeout_ms (${timeoutMs}ms). ` +
            `The call is still queued or running on ${targetAgent}/${targetSession} — do NOT ` +
            `re-send the message (it would run the work twice). Fetch the outcome with ` +
            `agent_ask_result({ call_id: "${callId}" }) — add wait_until_done:true to block ` +
            `until it finishes.`,
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

interface TurnOriginInfo {
  agent: string;
  session: string;
  kind: 'a2a' | 'subagent';
}

/** Who started the turn `agent/session` is running right now — the
 *  A2A asker, or the spawning parent for a sub-session. Null for a
 *  plain human/system turn or when the lookup fails (never blocks a
 *  call; the default then stays main). */
async function lookupTurnOrigin(
  base: string,
  agent: string,
  session: string,
): Promise<TurnOriginInfo | null> {
  try {
    const res = await loopbackFetch(
      `${base}/a2a/turn-origin/${encodeURIComponent(agent)}/${encodeURIComponent(session)}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { origin?: TurnOriginInfo | null };
    return data.origin && typeof data.origin.agent === 'string' && typeof data.origin.session === 'string'
      ? data.origin
      : null;
  } catch (err) {
    logger.warn({ msg: 'agent_ask.turn_origin_lookup_failed', agent, session, err: String(err) });
    return null;
  }
}
