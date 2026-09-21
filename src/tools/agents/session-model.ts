// session_model — switch the model of a session that already exists.
//
// Until 2026-09-21 only a person could do that: agent_ask takes `model`
// for a session it CREATES and refuses it for an existing one ("the
// model of a running session is the user's call"). Rene lifted that:
// an orchestrator that sees a colleague's session struggling on a small
// model should be able to move it. What stays is that it never happens
// silently — the server writes a row into the affected conversation
// saying who switched to what, every open client updates its header,
// and the running turn is not touched (the next turn uses the new
// model).

import { z } from 'zod';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolDefinition } from '../types.ts';

const Input = z
  .object({
    model: z.string().min(1).optional().describe('Model alias or provider/id. Omit together with clear:true.'),
    clear: z.boolean().optional().describe('true = remove the override; the persona default applies again.'),
    agent: z.string().min(1).optional().describe('Whose session. Default: you.'),
    session: z.string().min(1).optional().describe('Session slug or id. Default for your own agent: the session you are in. Required for another agent.'),
  })
  .strict();

interface SessionModelResult {
  ok: boolean;
  agent: string;
  session: string;
  model: string | null;
  resolved?: string;
  takes_effect: 'next turn';
  note: string;
}

export const sessionModel: ToolDefinition<z.infer<typeof Input>, SessionModelResult> = {
  name: 'session_model',
  toolset: 'agents',
  description:
    'Switch the model of an EXISTING somora chat session — your own (default: the session you are in) or ' +
    'another agent\'s (name `agent` and `session`; find sessions with session_list). Use it when the user ' +
    'asks for it ("stell hans\' Projekt-Session auf opus"), or when a session clearly needs a stronger or ' +
    'cheaper model for what it is doing. The running turn keeps its model; the NEXT turn uses the new one. ' +
    'The switch is written into that conversation with your name, and every open window updates — so say ' +
    'in your reply what you switched and why. `clear:true` removes the override (back to the persona ' +
    'default). For a session that does not exist yet, use agent_ask with create_session + model instead.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Model alias or provider/id. Omit together with clear:true.' },
      clear: { type: 'boolean', description: 'true = remove the override; the persona default applies again.' },
      agent: { type: 'string', description: 'Whose session. Default: you.' },
      session: { type: 'string', description: 'Session slug or id. Default for your own agent: the session you are in. Required for another agent.' },
    },
    additionalProperties: false,
  },
  defaultTimeoutMs: 15_000,
  async handler(input, ctx): Promise<SessionModelResult> {
    if (Boolean(input.model) === Boolean(input.clear)) {
      throw new Error('session_model: pass either `model` or `clear:true`, not both and not neither');
    }
    const target = resolveSessionModelTarget(input, { agent: ctx.agent, session: ctx.session });
    const host = process.env.SOMORA_HOST || '127.0.0.1';
    const port = process.env.SOMORA_PORT || '18737';
    const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
    const url = `${scheme}://${host}:${port}/agents/${encodeURIComponent(target.agent)}/sessions/${encodeURIComponent(target.session)}/model`;
    const by = { by_agent: ctx.agent, ...(ctx.session ? { by_session: ctx.session } : {}) };
    let res;
    try {
      res = await loopbackFetch(url, {
        method: input.clear ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input.clear ? by : { model: input.model, ...by }),
      });
    } catch (err) {
      const c = classifyFetchError(err);
      throw new Error(`session_model [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; session?: string; resolved?: string };
    if (!res.ok) throw new Error(`session_model: ${data.error ?? `HTTP ${res.status}`}`);
    return {
      ok: true,
      agent: target.agent,
      session: data.session ?? target.session,
      model: input.clear ? null : input.model!,
      ...(data.resolved ? { resolved: data.resolved } : {}),
      takes_effect: 'next turn',
      note: 'Recorded in that conversation with your name. A turn that is running there right now keeps its model.',
    };
  },
};

/** Which session is meant. Exported for tests. */
export function resolveSessionModelTarget(
  input: { agent?: string | undefined; session?: string | undefined },
  self: { agent: string; session?: string | undefined },
): { agent: string; session: string } {
  const agent = input.agent ?? self.agent;
  if (input.session) return { agent, session: input.session };
  if (agent !== self.agent) {
    throw new Error(`session_model: name the session of '${agent}' you mean — session_list({agent:"${agent}"}) shows them`);
  }
  if (!self.session) throw new Error('session_model: not running inside a session — name the session explicitly');
  return { agent, session: self.session };
}
