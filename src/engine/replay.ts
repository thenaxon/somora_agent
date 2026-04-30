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

import type { NormalizedEvent } from '../types/events.ts';

export interface ReplayPair {
  user: string;
  assistant: string;
}

/**
 * Extract user/assistant pairs from the event stream that occurred
 * strictly after `sinceTs`. The current turn's user_message (the last
 * user_message in history without a paired assistant_message) is
 * naturally excluded because the pair is incomplete.
 */
export function computeReplayDelta(
  history: NormalizedEvent[],
  sinceTs: number,
): ReplayPair[] {
  const pairs: ReplayPair[] = [];
  let pendingUser: string | undefined;
  for (const ev of history) {
    if (ev.ts <= sinceTs) continue;
    if (ev.kind === 'user_message') {
      pendingUser = ev.text;
    } else if (ev.kind === 'assistant_message' && pendingUser !== undefined) {
      pairs.push({ user: pendingUser, assistant: ev.text });
      pendingUser = undefined;
    }
  }
  return pairs;
}

/**
 * Render a delta as a Markdown context block for engine-bridges.
 * Empty delta returns an empty string — caller can skip the prefix.
 */
export function renderReplayPrefix(pairs: ReplayPair[]): string {
  if (pairs.length === 0) return '';
  const lines = [
    '<context-from-other-engines>',
    'In dieser laufenden Session wurden zwischen deinem letzten Beitrag',
    'und der jetzigen Frage Turns mit anderen Modellen gemacht. Hier',
    'sind sie der Vollständigkeit halber. Sie sind Teil der Konversation,',
    'als hättest du sie selbst gehört. Antworte _nicht_ darauf — nur',
    'auf die aktuelle Frage am Ende.',
    '',
  ];
  for (const p of pairs) {
    lines.push(`User: ${p.user}`);
    lines.push(`Assistant: ${p.assistant}`);
    lines.push('');
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
