// A2A header helpers — when a turn's userMessage was written by
// another agent (via agent_ask), engines prepend a sender-tag so the
// model knows the provenance. Same shape across all three engines so
// agents see consistent attribution regardless of who's running them.

const HEADER_PREFIX = '[Message from agent ';

/**
 * Prepend an attribution header if `fromAgent` is set; pass through
 * otherwise. Used both for the live `userMessage` and inside the
 * cross-engine replay-prefix (so a session that's been a2a-active
 * keeps that visible when another engine catches up).
 */
export function withFromAgentHeader(text: string, fromAgent: string | undefined): string {
  if (!fromAgent) return text;
  return `${HEADER_PREFIX}${fromAgent}]\n${text}`;
}
