// agent_ask_cancel — take back a question of your own: out of the
// target's queue while it waits (Phase 2), or, since 2026-09-24, softly
// while it runs — the target is told to stop through its steer inbox
// and the outcome wakes no one (a free target starts a call within
// milliseconds, so "still queued" never fit "I delegated, the user
// changed course"). An agent may only take back what it asked for
// itself; a person removes anything from the web queue view, and a
// hard stop of a running turn stays the person's Stop button.

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolDefinition } from '../types.ts';

const Input = z.object({ call_id: z.string().min(1).describe('call_id of a pending agent_ask.') }).strict();

interface CancelResult {
  call_id: string;
  state: 'removed' | 'withdrawn' | 'already_started' | 'unknown';
  /** withdrawn: the stop message reached the target's running turn. */
  steered?: boolean;
  hint: string;
}

export const agentAskCancel: ToolDefinition<z.infer<typeof Input>, CancelResult> = {
  name: 'agent_ask_cancel',
  toolset: 'agents',
  description:
    'Take back a question you sent with agent_ask — because it is outdated or you asked the wrong ' +
    'agent. Only your own calls. Still waiting in the target\'s queue (phase queued): it is removed ' +
    'and the target never sees it (`removed`). Already running: the target is told to stop through ' +
    'its running turn and whatever it still delivers wakes you no more (`withdrawn`, with `steered` ' +
    'saying whether the stop message reached the turn); the target stops on its own, this tool ' +
    'does not abort it — a person can.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: { call_id: { type: 'string', description: 'call_id of a pending agent_ask.' } },
    required: ['call_id'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 15_000,
  async handler(input, ctx): Promise<CancelResult> {
    const host = process.env.SOMORA_HOST || '127.0.0.1';
    const port = process.env.SOMORA_PORT || '18737';
    const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
    let res;
    try {
      res = await loopbackFetch(`${scheme}://${host}:${port}/chat/queue/${encodeURIComponent(input.call_id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requesting_agent: ctx.agent, withdraw_running: true }),
      });
    } catch (err) {
      const c = classifyFetchError(err);
      throw new Error(`agent_ask_cancel [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
    }
    if (res.status === 403) {
      throw new Error(`agent_ask_cancel: call '${input.call_id}' was not sent by you — only the asker can take it back`);
    }
    if (res.status === 409) {
      logger.info({ msg: 'agent_ask_cancel.already_started', agent: ctx.agent, call_id: input.call_id });
      return { call_id: input.call_id, state: 'already_started', hint: 'The target is already answering; wait for it with agent_ask_result, or ask the user to stop it.' };
    }
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { state?: string; steered?: boolean; ranMs?: number | null };
      if (body.state === 'withdrawn') {
        logger.info({ msg: 'agent_ask_cancel.withdrawn', agent: ctx.agent, call_id: input.call_id, steered: body.steered === true });
        return body.steered
          ? {
              call_id: input.call_id,
              state: 'withdrawn',
              steered: true,
              hint: `Taken back: the target's running turn (${Math.round((body.ranMs ?? 0) / 1000)} s in) has been told to stop and deliver nothing; its outcome will not wake you. Do not wait for it.`,
            }
          : {
              call_id: input.call_id,
              state: 'withdrawn',
              steered: false,
              hint: 'Taken back: its outcome will not wake you — but the target\'s turn could not be told to stop (its engine does not read messages mid-turn, or the turn just ended); it finishes on its own, or a person stops it.',
            };
      }
    }
    if (res.status === 404) {
      return { call_id: input.call_id, state: 'unknown', hint: 'Nothing waits under this call_id — it already started, finished, or was never queued.' };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`agent_ask_cancel: HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    logger.info({ msg: 'agent_ask_cancel.removed', agent: ctx.agent, call_id: input.call_id });
    return { call_id: input.call_id, state: 'removed', hint: 'Taken out of the queue; the target never saw it. Send a new agent_ask if you still need something.' };
  },
};
