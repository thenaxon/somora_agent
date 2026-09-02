// Chat-message model + history → message conversion for the mobile
// client. Pure (no React, no fetch) so the pairing rules can be unit-
// tested against a real session sequence — see history.test.mts.
//
// Why pairing by turnId: a turn that ERRORS produces no assistant
// message, only `error` → `turn_end` → `assistant_media` (the pictures
// it made before dying). "Attach media to the most recent agent row"
// then hits the PREVIOUS turn's reply, and the answer appears to have
// landed a few lines up (2026-08-28 report). Every row that belongs to
// a turn carries the engine's turnId; media and errors go to a row of
// the SAME turn or to a fresh row — never to another turn's.

/** Model reasoning attached to an agent row. Arrives over SSE
 *  (`thinking` event, cumulative deltas then a final) or from the
 *  `thinking_message` history row that precedes the turn's
 *  assistant_message. Plain text — never markdown-rendered. */
export interface ThinkingContent {
  text: string;
  /** The server cut the text at its configured cap (ends with `…`). */
  truncated?: boolean;
  /** True while thinking deltas are still arriving for this turn. */
  streaming?: boolean;
}

export interface ChatMessage {
  id: string;
  /** `error`: the turn ended with an engine/backend error instead of
   *  (or after) an assistant message. Rendered as a compact error
   *  block inside the turn, so following turns don't shift. */
  role: 'user' | 'agent' | 'error';
  text: string;
  ts: number;
  /** True while the agent's response is still streaming. */
  streaming?: boolean;
  /** agent rows: the model's reasoning for this turn, when the engine
   *  surfaces it and the server captures it. Rendered as a compact
   *  collapsible line at the top of the bubble. */
  thinking?: ThinkingContent;
  /** A2A: name of the peer agent that wrote this inbound. Renderer
   *  swaps the user-bubble for a peer-agent bubble in the sender's
   *  color/icon. */
  fromAgent?: string;
  /** Synthesized inbound marker. Today: 'sentinel'. Renderer draws a
   *  centered system divider instead of a user-bubble. */
  fromSystem?: 'sentinel' | 'tmux' | 'subagent' | 'job';
  /** Voice: optional TTS audio URL produced for this turn. Set when an
   *  `assistant_audio` SSE event arrived after the message; drives the
   *  Play-button on the agent bubble. */
  audio?: { url: string; mime: string; durationMs?: number };
  /** Media the agent produced during this turn. The PWA deliberately
   *  does NOT display it — this is a marker so the reply doesn't look
   *  like the agent delivered nothing, with the desktop app as the
   *  place to actually look at it. */
  mediaNote?: { images: number; videos: number };
  /** user rows: server-issued turnId for self-typed turns (from POST
   *  /chat/send), used to pair with turn_queued / user_message /
   *  turn_dequeued. agent + error rows: the ENGINE's turnId (`t-…`,
   *  from turn_started / turn_start), used to pair assistant_media
   *  and turn_error to the right turn. */
  turnId?: string;
  /** Set when a turn_queued SSE event arrived for this bubble's
   *  turnId. Cleared once the matching user_message event lands
   *  (= the turn actually started). Drives the hourglass marker
   *  next to the timestamp — and the "↩ edit" recall button. */
  queued?: { ahead: number };
  /** True from optimistic send until the matching user_message
   *  SSE arrives. Used by the chat:delta handler to anchor the
   *  fresh assistant bubble BEFORE any queued user-bubbles so
   *  the agent's reply for the CURRENT turn stays above messages
   *  the user typed while waiting. */
  pending?: boolean;
}

export interface HistoryEvent {
  kind: string;
  ts?: number;
  text?: string;
  /** `kind: 'error'` rows carry the failure text here. */
  message?: string;
  /** `kind: 'thinking_message'`: the server cut the text at its cap. */
  truncated?: boolean;
  turnId?: string;
  from_agent?: string;
  from_system?: 'sentinel' | 'tmux' | 'subagent' | 'job';
  audio?: { url: string; mime: string; durationMs?: number; cacheKey: string };
  media?: Array<{ type: string; id: string; filename: string; mime: string; url: string }>;
}

/** Split a media list by type. An entry whose type this client doesn't
 *  know is ignored rather than counted as something it isn't. */
export function countMedia(media: unknown[]): { images: number; videos: number } {
  let images = 0;
  let videos = 0;
  for (const m of media) {
    const t = (m as { type?: unknown }).type;
    if (t === 'video') videos += 1;
    else if (t === 'image') images += 1;
  }
  return { images, videos };
}

let msgIdCounter = 0;
export function newId(prefix: string): string {
  msgIdCounter++;
  return `${prefix}-${Date.now()}-${msgIdCounter}`;
}

export function eventToMessage(ev: HistoryEvent): ChatMessage | null {
  if (ev.kind === 'user_message') {
    return {
      id: `u-${ev.ts ?? 0}-${msgIdCounter++}`,
      role: 'user',
      text: ev.text ?? '',
      ts: ev.ts ?? 0,
      ...(ev.from_agent ? { fromAgent: ev.from_agent } : {}),
      ...(ev.from_system ? { fromSystem: ev.from_system } : {}),
    };
  }
  if (ev.kind === 'assistant_message') {
    return {
      id: `a-${ev.ts ?? 0}-${msgIdCounter++}`,
      role: 'agent',
      text: ev.text ?? '',
      ts: ev.ts ?? 0,
    };
  }
  if (ev.kind === 'error' && typeof ev.message === 'string') {
    return {
      id: `e-${ev.ts ?? 0}-${msgIdCounter++}`,
      role: 'error',
      text: ev.message,
      ts: ev.ts ?? 0,
    };
  }
  return null;
}

/** Index of the last row of the given turn that can carry media/audio
 *  (agent or error), or -1. */
export function findTurnRow(list: readonly ChatMessage[], turnId: string | undefined): number {
  if (!turnId) return -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m && (m.role === 'agent' || m.role === 'error') && m.turnId === turnId) return i;
  }
  return -1;
}

/**
 * Convert a `/chat/history` event list into rows. Tracks the engine's
 * turnId from `turn_start`/`turn_end` so agent + error rows are
 * stamped with it; `assistant_media` pairs by that id and otherwise
 * gets its own media-only agent row. `assistant_audio` keeps the old
 * "most recent agent row" fold — it is emitted right after the text
 * of its own turn, and the audio pipeline never runs on an error.
 */
export function historyEventsToMessages(events: readonly HistoryEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let currentTurnId: string | undefined;
  // thinking_message precedes its turn's assistant_message (after the
  // tool rows): fold it onto the NEXT agent row. A turn that ends
  // without one (error, abort) drops it — there is no bubble to
  // hang it on, and a thinking-only row would read as an answer.
  let pendingThinking: ThinkingContent | null = null;
  for (const ev of events) {
    if (ev.kind === 'turn_start') {
      currentTurnId = typeof ev.turnId === 'string' ? ev.turnId : undefined;
      pendingThinking = null;
      continue;
    }
    if (ev.kind === 'turn_end') {
      // Keep the id: assistant_media for this turn is written AFTER
      // turn_end. The next turn_start replaces it.
      if (typeof ev.turnId === 'string') currentTurnId = ev.turnId;
      pendingThinking = null;
      continue;
    }
    if (ev.kind === 'thinking_message') {
      if (typeof ev.text === 'string' && ev.text.length > 0) {
        pendingThinking = { text: ev.text, ...(ev.truncated ? { truncated: true } : {}) };
      }
      continue;
    }
    if (ev.kind === 'assistant_audio' && ev.audio) {
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const m = out[i];
        if (m && m.role === 'agent') {
          out[i] = {
            ...m,
            audio: {
              url: ev.audio.url,
              mime: ev.audio.mime,
              ...(typeof ev.audio.durationMs === 'number' ? { durationMs: ev.audio.durationMs } : {}),
            },
          };
          break;
        }
      }
      continue;
    }
    if (ev.kind === 'assistant_media' && Array.isArray(ev.media) && ev.media.length > 0) {
      const note = countMedia(ev.media);
      const idx = findTurnRow(out, ev.turnId);
      if (idx >= 0) {
        out[idx] = { ...out[idx]!, mediaNote: note };
      } else {
        // No row of this turn to hang it on (or an unstamped legacy
        // row): give the media its own row rather than borrowing a
        // neighbour's.
        out.push({
          id: `m-${ev.ts ?? 0}-${msgIdCounter++}`,
          role: 'agent',
          text: '',
          ts: ev.ts ?? 0,
          ...(ev.turnId ? { turnId: ev.turnId } : {}),
          mediaNote: note,
        });
      }
      continue;
    }
    const mapped = eventToMessage(ev);
    if (!mapped) continue;
    if ((mapped.role === 'agent' || mapped.role === 'error') && currentTurnId) {
      mapped.turnId = currentTurnId;
    }
    if (mapped.role === 'agent' && pendingThinking) {
      mapped.thinking = pendingThinking;
      pendingThinking = null;
    }
    out.push(mapped);
  }
  return out;
}
