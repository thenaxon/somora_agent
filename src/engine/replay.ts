// Cross-engine continuity helper.
//
// CLI engines (claude-cli, codex-cli) keep their own internal session
// state via `sdkSessionId` / `codexSessionId`. When such a session is
// resumed they remember every turn they themselves participated in.
// They do NOT remember turns made by other engines on the same somora
// session. To fill that gap we compute a delta — the user/assistant
// pairs that happened since this engine was last active — and prepend
// it as context to the new user message.
//
// `lastSeenTurnTs` is tracked per engine inside the session meta-file:
// `meta.engineLastSeen = { 'claude-cli': 173..., 'codex-cli': 174... }`.
//
// The delta is _compaction-aware_: if `meta.compactions[]` covers part
// of the gap (which can happen when openai-compatible compacted between
// this engine's last turn and now), the replay folds the summary in and
// only emits the user/assistant pairs that occurred AFTER the latest
// applicable compaction. That bounds the replay size: after very long
// gaps the engine sees `[summary] + recent pairs` instead of thousands
// of raw turns.

import { pickLatestApplicable, type Compaction } from '../compaction/index.ts';
import { sanitizeAssistantText } from '../server/sanitize-assistant-text.ts';
import type { NormalizedEvent } from '../types/events.ts';

export interface ReplayPair {
  user: string;
  assistant: string;
  /** A2A attribution of the user-side. Set when the user-message in
   *  this pair was written by another agent, not the human user. */
  fromAgent?: string;
}

export interface ReplayDelta {
  /** If a compaction covers part of the gap, its summary lives here. */
  summary?: string;
  /** Pairs since `max(sinceTs, latestApplicableCompaction.throughTs)`. */
  pairs: ReplayPair[];
}

/**
 * Compute what this engine missed since `sinceTs`. If
 * `compactions[]` contains an entry whose `throughTs > sinceTs`, the
 * delta is `{ summary: latestApplicable.summary, pairs: pairs after
 * compaction.throughTs }`. Otherwise it is `{ pairs: pairs after
 * sinceTs }`.
 *
 * The current turn's user_message (the last user_message in history
 * without a paired assistant_message) is naturally excluded because
 * the pair is incomplete.
 */
export function computeReplayDelta(
  history: NormalizedEvent[],
  sinceTs: number,
  compactions?: Compaction[],
): ReplayDelta {
  const applicable = pickLatestApplicable(compactions, sinceTs);
  const effectiveSinceTs = applicable ? applicable.throughTs : sinceTs;
  const pairs: ReplayPair[] = [];
  let pendingUser: { text: string; fromAgent?: string } | undefined;
  for (const ev of history) {
    if (ev.ts <= effectiveSinceTs) continue;
    if (ev.kind === 'user_message') {
      pendingUser = { text: ev.text, ...(ev.from_agent ? { fromAgent: ev.from_agent } : {}) };
    } else if (ev.kind === 'assistant_message' && pendingUser !== undefined) {
      pairs.push({
        user: pendingUser.text,
        assistant: ev.text,
        ...(pendingUser.fromAgent ? { fromAgent: pendingUser.fromAgent } : {}),
      });
      pendingUser = undefined;
    }
  }
  return { ...(applicable ? { summary: applicable.summary } : {}), pairs };
}

/**
 * Render a delta as a Markdown context block for engine-bridges.
 * Empty delta (no summary, no pairs) returns an empty string — caller
 * can skip the prefix entirely.
 */
export function renderReplayPrefix(delta: ReplayDelta): string {
  if (!delta.summary && delta.pairs.length === 0) return '';
  const lines = [
    '<context-from-other-engines>',
    'In dieser laufenden Session wurden zwischen deinem letzten Beitrag',
    'und der jetzigen Frage Turns mit anderen Modellen gemacht. Hier',
    'sind sie der Vollständigkeit halber. Sie sind Teil der Konversation,',
    'als hättest du sie selbst gehört. Antworte _nicht_ darauf — nur',
    'auf die aktuelle Frage am Ende.',
    '',
  ];
  if (delta.summary) {
    lines.push('<earlier-summary>');
    lines.push(delta.summary);
    lines.push('</earlier-summary>');
    lines.push('');
  }
  if (delta.pairs.length > 0) {
    lines.push('<recent-pairs>');
    for (const p of delta.pairs) {
      // A2A: when the user-side was written by another agent, mark
      // it explicitly in the replay so engines catching up don't
      // confuse it with a human-user turn.
      const userLabel = p.fromAgent ? `User (from agent ${p.fromAgent})` : 'User';
      lines.push(`${userLabel}: ${p.user}`);
      // Defensive XML-strip: if a prior engine's assistant_message
      // text contains hallucinated <tool_call>…</tool_call> /
      // <tool_response>…</tool_response> XML (see
      // src/server/sanitize-assistant-text.ts), replace it before
      // it gets re-injected into the NEXT engine's context — which
      // would otherwise see thousands of tokens of XML noise. This
      // is belt-and-suspenders: the run-turn chokepoint already
      // normalises new messages, but legacy events already on disk
      // never went through that filter.
      const cleanAssistant = sanitizeAssistantText(p.assistant).text;
      lines.push(`Assistant: ${cleanAssistant}`);
      lines.push('');
    }
    lines.push('</recent-pairs>');
  }
  lines.push('</context-from-other-engines>');
  lines.push('');
  return lines.join('\n');
}

export interface EngineLastSeen {
  [engineName: string]: number;
}

export function getLastSeenTs(
  meta: { engineLastSeen?: EngineLastSeen },
  engine: string,
): number {
  return meta.engineLastSeen?.[engine] ?? 0;
}

export function withLastSeenTs(
  meta: { engineLastSeen?: EngineLastSeen },
  engine: string,
  ts: number,
): EngineLastSeen {
  return { ...(meta.engineLastSeen ?? {}), [engine]: ts };
}
