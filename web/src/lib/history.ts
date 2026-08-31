// Session history → chat rows. Used at session-open and load-older;
// live SSE builds rows incrementally in ChatProvider with the same
// pairing rules.
//
// Turn pairing: a session file carries `turn_start[turnId]` … events …
// `turn_end[turnId]`, and side artifacts that arrive AFTER the turn
// closed (`assistant_media`, `assistant_audio`) name that turnId. The
// assistant_message row itself has no turnId, so this walk stamps every
// row it builds with the turn it is inside of, and pairs artifacts by
// that stamp. The old "attach to the most recent assistant row" rule
// put a failed turn's pictures under the PREVIOUS answer — the failed
// turn has an `error` row instead of an assistant row, which the old
// walk also dropped entirely (2026-08-28 report).

import type { HistoryEvent } from './api';
import type { AssistantMedia, ChatMessage, ModelFallback } from '../types/chat';
import { extractTodoListItems, resolveEngineMetaLabel, summariseTodoList } from './engine-meta-labels';

let historyIdSeq = 0;
function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++historyIdSeq}`;
}

export function kindFromMime(mime: string): 'image' | 'pdf' | 'text' {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}

/** Index of the row that owns `turnId` — the last assistant or error
 *  row stamped with it. -1 when no such row exists. When `turnId` is
 *  missing (old engines), falls back to the last assistant row, which
 *  is the pre-pairing behaviour and right often enough for old files. */
export function findTurnOwner(rows: ChatMessage[], turnId: string | undefined): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = rows[i];
    if (!m) continue;
    if (m.role !== 'assistant' && m.role !== 'error') continue;
    if (turnId === undefined) return m.role === 'assistant' ? i : -1;
    if (m.turnId === turnId) return i;
  }
  return -1;
}

/** Attach media to its turn's row, or — when the turn left no row at
 *  all — add a media-only assistant row so the pictures still show up
 *  in order. Never touches a row of a different turn. */
export function attachMedia(
  rows: ChatMessage[],
  turnId: string | undefined,
  media: AssistantMedia[],
  ts: number,
): ChatMessage[] {
  const idx = findTurnOwner(rows, turnId);
  const next = rows.slice();
  if (idx >= 0) {
    const m = next[idx];
    if (m && (m.role === 'assistant' || m.role === 'error')) {
      next[idx] = { ...m, media };
      return next;
    }
  }
  next.push({
    id: newId('h-media'),
    role: 'assistant',
    ts,
    text: '',
    media,
    ...(turnId ? { turnId } : {}),
  });
  return next;
}

export function historyEventsToMessages(events: HistoryEvent[]): ChatMessage[] {
  let out: ChatMessage[] = [];
  // model_fallback precedes the fallback engine's output: stamp the
  // NEXT assistant message with it.
  let pendingFallback: ModelFallback | null = null;
  // The turn we are currently inside of (turn_start … turn_end).
  let currentTurnId: string | undefined;
  for (const e of events) {
    if (e.kind === 'turn_start') {
      currentTurnId = typeof e.turnId === 'string' ? e.turnId : undefined;
      continue;
    }
    if (e.kind === 'turn_end') {
      // Keep the id: media/audio for this turn are appended AFTER
      // turn_end and still name it. The next turn_start replaces it.
      if (typeof e.turnId === 'string') currentTurnId = e.turnId;
      continue;
    }
    if (e.kind === 'model_fallback') {
      if (typeof e.requested === 'string' && typeof e.actual === 'string') {
        pendingFallback = { requested: e.requested, actual: e.actual, reason: e.reason ?? '' };
      }
      continue;
    }
    if (e.kind === 'error') {
      out.push({
        id: newId('h-err'),
        role: 'error',
        ts: e.ts,
        text: typeof e.message === 'string' ? e.message : 'turn failed',
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
      });
      continue;
    }
    if (e.kind === 'assistant_message' && typeof e.text === 'string') {
      out.push({
        id: newId('h-am'),
        role: 'assistant',
        ts: e.ts,
        text: e.text,
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        ...(pendingFallback ? { fallback: pendingFallback } : {}),
      });
      pendingFallback = null;
      continue;
    }
    if (e.kind === 'assistant_media' && Array.isArray(e.media) && e.media.length > 0) {
      out = attachMedia(
        out,
        typeof e.turnId === 'string' ? e.turnId : currentTurnId,
        e.media as AssistantMedia[],
        e.ts,
      );
      continue;
    }
    if (e.kind === 'assistant_audio' && e.audio) {
      const idx = findTurnOwner(out, typeof e.turnId === 'string' ? e.turnId : currentTurnId);
      const m = idx >= 0 ? out[idx] : undefined;
      if (m && m.role === 'assistant') {
        out[idx] = {
          ...m,
          audio: {
            url: e.audio.url,
            mime: e.audio.mime,
            ...(e.audio.durationMs !== undefined ? { durationMs: e.audio.durationMs } : {}),
            cacheKey: e.audio.cacheKey,
          },
        };
      }
      continue;
    }
    out.push(...historyEventToMessages(e));
  }
  return out;
}

export function historyEventToMessages(e: HistoryEvent): ChatMessage[] {
  if (e.kind === 'user_message' && typeof e.text === 'string') {
    return [
      {
        id: newId('h-um'),
        role: 'user',
        ts: e.ts,
        text: e.text,
        ...(e.from_agent ? { fromAgent: e.from_agent } : {}),
        ...(e.from_system ? { fromSystem: e.from_system } : {}),
        ...(e.attachments && e.attachments.length > 0
          ? {
              attachments: e.attachments.map((a) => ({
                hash: a.hash,
                name: a.name,
                mime: a.mime,
                size: a.size,
                kind: kindFromMime(a.mime),
              })),
            }
          : {}),
      },
    ];
  }
  if (e.kind === 'assistant_message' && typeof e.text === 'string') {
    return [{ id: newId('h-am'), role: 'assistant', ts: e.ts, text: e.text }];
  }
  if (e.kind === 'tool_call' && e.tool) {
    return [
      {
        id: newId('h-tc'),
        role: 'tool_call',
        ts: e.ts,
        toolCall: {
          tool: e.tool,
          ...(e.callId ? { callId: e.callId } : {}),
          ...(e.input ? { input: e.input } : {}),
        },
      },
    ];
  }
  if (e.kind === 'tool_result' && e.callId) {
    return [
      {
        id: newId('h-tr'),
        role: 'tool_result',
        ts: e.ts,
        toolResult: {
          tool: '?',
          callId: e.callId,
          ...(e.output !== undefined ? { output: e.output } : {}),
        },
      },
    ];
  }
  if (e.kind === 'engine_meta' && typeof e.itemType === 'string') {
    const engine = e.engine ?? 'unknown';
    const label = resolveEngineMetaLabel(engine, e.itemType);
    let summary: string | undefined;
    if (engine === 'codex-cli' && e.itemType === 'todo_list') {
      const items = extractTodoListItems(e.payload);
      if (items) summary = summariseTodoList(items);
    }
    return [
      {
        id: newId('h-em'),
        role: 'engine_meta',
        ts: e.ts,
        meta: {
          engine,
          itemType: e.itemType,
          label,
          ...(summary ? { summary } : {}),
          payload: e.payload,
        },
      },
    ];
  }
  return [];
}
