// What the TUI missed while it had no live stream (Codex review
// 2026-11-22, docs/display.md "When the connection drops").
//
// The live stream starts at connect time and replays nothing, and the
// TUI can only append (finished lines belong to the terminal). So after
// every (re)connect the client reads the session's history again and
// appends what came after the last thing it showed. The anchor is the
// newest user_message it saw, live or in the history: those carry a
// timestamp on both paths, the other live events do not.
//
// - A turn that was running when the stream dropped (or when the client
//   opened) has its user message on screen but not its end: its replies
//   are appended, its tool calls are not (some of them were shown live,
//   and they cannot be told apart from the rest).
// - Turns that started after the anchor are appended whole.

import type { HistoryEvent } from './api.ts';

export interface MissedEvents {
  /** Events to replay into the chat, in order. */
  events: HistoryEvent[];
  /** The running turn's end is among them: the live reply is over. */
  turnEnded: boolean;
  /** Tool calls of that turn were left out. */
  skippedTools: number;
}

/** The newest user_message's timestamp in a history, or null. */
export function lastUserTs(events: HistoryEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === 'user_message' && typeof ev.ts === 'number') return ev.ts;
  }
  return null;
}

/** The history ends inside a turn: its last user_message has no turn_end after it. */
export function endsMidTurn(events: HistoryEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const kind = events[i]!.kind;
    if (kind === 'turn_end') return false;
    if (kind === 'user_message') return true;
  }
  return false;
}

export function missedEvents(history: HistoryEvent[], anchorTs: number | null, midTurn: boolean): MissedEvents {
  // Everything after the anchor message. Without an anchor the client has
  // shown no turn of this session, so a running turn is all there is.
  let start = 0;
  if (anchorTs !== null) {
    let anchorIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const ev = history[i]!;
      if (ev.kind === 'user_message' && typeof ev.ts === 'number' && ev.ts <= anchorTs) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx < 0) return { events: [], turnEnded: false, skippedTools: 0 };
    start = anchorIdx + 1;
  }
  const tail = history.slice(start);
  const nextUser = tail.findIndex((ev) => ev.kind === 'user_message');
  const current = nextUser < 0 ? tail : tail.slice(0, nextUser);
  const later = nextUser < 0 ? [] : tail.slice(nextUser);
  const out: HistoryEvent[] = [];
  let turnEnded = false;
  let skippedTools = 0;
  if (midTurn && anchorTs !== null) {
    turnEnded = current.some((ev) => ev.kind === 'turn_end');
    for (const ev of current) {
      if (ev.kind === 'assistant_message' || ev.kind === 'thinking_message' || ev.kind === 'model_fallback') out.push(ev);
      else if (ev.kind === 'tool_call') skippedTools += 1;
    }
  }
  out.push(...later);
  if (later.length > 0) turnEnded = turnEnded || midTurn;
  return { events: out, turnEnded, skippedTools };
}
