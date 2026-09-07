// A2A header helpers — when a turn's userMessage was written by
// another agent (via agent_ask), engines prepend a sender-tag so the
// model knows the provenance. Same shape across all three engines so
// agents see consistent attribution regardless of who's running them.
//
// Since 2026-09-07 the header also names the asker's SESSION (as its
// slug) — without it a responder could not address a follow-up and
// fell back to the asker's main session.

const HEADER_PREFIX = '[Message from agent ';

/** Agent-facing slug of a session id: `20260906-172957_cerebrocraft`
 *  → `cerebrocraft`, `main` stays `main`. Unknown shapes pass through. */
export function sessionSlugOf(sessionId: string): string {
  const m = /^\d{8}-\d{6}_(.+)$/.exec(sessionId);
  return m ? m[1]! : sessionId;
}

/**
 * Prepend an attribution header if `fromAgent` is set; pass through
 * otherwise. Used both for the live `userMessage` and inside the
 * cross-engine replay-prefix (so a session that's been a2a-active
 * keeps that visible when another engine catches up).
 */
export function withFromAgentHeader(
  text: string,
  fromAgent: string | undefined,
  fromSession?: string,
): string {
  if (!fromAgent) return text;
  const session = fromSession ? `, session ${sessionSlugOf(fromSession)}` : '';
  return `${HEADER_PREFIX}${fromAgent}${session}]\n${text}`;
}
