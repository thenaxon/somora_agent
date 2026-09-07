// Turn-origin registry — "who wrote the message this turn is answering".
//
// While an A2A turn runs (agent_ask wrote the user_message), the target
// side knows the asker's agent AND session (from_agent / from_session).
// `agent_ask` without an explicit `session` consults this registry so a
// reply-back to the asker lands in the session the question came from,
// not in `main` (2026-09-06 report: project sessions leaked into main
// because the responder had to guess). Sub-agents get the same
// treatment through their spawn meta (parent_agent / parent_session) —
// that lives on disk and is resolved by the route, not here.
//
// Set at every turn start (with null for human/system turns so a stale
// A2A origin can never survive into the next human turn), cleared at
// turn end. Process-local, like ask-wait-graph.ts — MCP children reach
// it through GET /a2a/turn-origin.

export interface TurnOrigin {
  agent: string;
  /** Session id (or 'main') of the asker, exactly as agent_ask sent it. */
  session: string;
}

const keyOf = (agent: string, session: string) => `${agent}/${session}`;
const origins = new Map<string, TurnOrigin>();

/** Record (or reset, with null) the origin of the turn now running on
 *  `agent/session`. */
export function setTurnOrigin(agent: string, session: string, origin: TurnOrigin | null): void {
  const k = keyOf(agent, session);
  if (origin) origins.set(k, origin);
  else origins.delete(k);
}

export function clearTurnOrigin(agent: string, session: string): void {
  origins.delete(keyOf(agent, session));
}

export function getTurnOrigin(agent: string, session: string): TurnOrigin | null {
  return origins.get(keyOf(agent, session)) ?? null;
}
