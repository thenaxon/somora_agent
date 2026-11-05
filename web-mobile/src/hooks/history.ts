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

// Origin types are shared with the desktop client — one source.
import type { FromSystem, TurnOrigin } from '../../../web/src/types/origin';
import { addCall, closeActivity, joinActivities, newActivity, settleCall, stepLabel, type Activity } from './activity';

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

export interface ModelFallback {
  requested: string;
  actual: string;
  reason: string;
  hops?: Array<{ model: string; reason: string }>;
}

export interface ChatMessage {
  id: string;
  /** `error`: the turn ended with an engine/backend error instead of
   *  (or after) an assistant message. Rendered as a compact error
   *  block inside the turn, so following turns don't shift.
   *  `note`: a line about the conversation itself — today only "context
   *  compacted" — drawn as a centered divider; `text` is its sentence.
   *  `activity`: the tool calls of one turn (`activity`), shown when the
   *  session's tool switch is on.
   *  `memory`: the notes recalled for the turn that follows (`memory`),
   *  shown when the session's memory switch is on. Live only, like the
   *  web client's memory line: history does not carry it. */
  role: 'user' | 'agent' | 'error' | 'note' | 'activity' | 'memory';
  /** memory rows: how many notes were recalled, the best score, their
   *  references and the text the agent was given. */
  memory?: { count: number; topScore?: number; refs: string[]; fullText?: string };
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
  /** Synthesized inbound marker (sentinel fire, tmux/browser/subagent/
   *  video wake, voice consult, late agent answer). Renderer draws a
   *  centered system divider instead of a user-bubble. Legacy: derived
   *  from `origin` on the server; the only marker on turns recorded
   *  before 2026-09-13. */
  fromSystem?: FromSystem;
  /** Structured origin of the turn (since 2026-09-13). Absent on older
   *  turns — renderers fall back to fromSystem/fromAgent. */
  origin?: TurnOrigin;
  /** Voice: optional TTS audio URL produced for this turn. Set when an
   *  `assistant_audio` SSE event arrived after the message; drives the
   *  Play-button on the agent bubble. */
  audio?: { url: string; mime: string; durationMs?: number };
  /** agent rows: the persona's primary model failed before producing
   *  anything and a `fallback:` model answered. `requested` is the
   *  primary, `actual` the model that answered; `hops` every model that
   *  failed (primary first) when a fallback chain was walked. */
  fallback?: ModelFallback;
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
  /** user rows: sent with steering into the running turn. With
   *  `pending` still set the model has not read it yet ("steering…");
   *  without, it has ("steered"). `steerId` pairs it with the server's
   *  user_message. */
  steer?: boolean;
  steerId?: string;
  /** activity rows: the turn's tool calls (hooks/activity.ts). */
  activity?: Activity;
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
  from_session?: string;
  from_system?: FromSystem;
  /** Structured origin of a `user_message` row (since 2026-09-13). */
  origin?: TurnOrigin;
  /** `user_message` steered into a running turn. */
  steer?: boolean;
  audio?: { url: string; mime: string; durationMs?: number; cacheKey: string };
  media?: Array<{ type: string; id: string; filename: string; mime: string; url: string }>;
  /** `kind: 'engine_meta'` rows. */
  itemType?: string;
  payload?: unknown;
  /** `kind: 'model_fallback'` rows. */
  requested?: string;
  actual?: string;
  reason?: string;
  hops?: Array<{ model: string; reason: string }>;
  /** `tool_call` / `tool_result` rows. */
  tool?: string;
  callId?: string;
  input?: unknown;
  error?: string;
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
      ...(ev.origin ? { origin: ev.origin } : {}),
      ...(ev.steer ? { steer: true } : {}),
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
  if (ev.kind === 'engine_meta' && ev.itemType === 'context_compacted') {
    return {
      id: `n-${ev.ts ?? 0}-${msgIdCounter++}`,
      role: 'note',
      text: compactionNoteText(ev.payload),
      ts: ev.ts ?? 0,
    };
  }
  return null;
}

/** The sentence of a context_compacted row (history or live). Every
 *  engine puts one in `payload.text`; older rows may lack it. The other
 *  engine_meta rows stay a desktop matter — they are engine internals
 *  — but a compaction explains why the context dropped. */
export function compactionNoteText(payload: unknown): string {
  const text = (payload as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' && text.length > 0 ? text : 'history compacted';
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
  // model_fallback precedes the fallback model's assistant_message:
  // fold it onto the NEXT agent row, same as thinking.
  let pendingFallback: ModelFallback | null = null;
  // The activity row of the turn being read: one per turn, placed where
  // its first tool call was. A page that starts mid-turn opens one too.
  let actIdx = -1;
  let turnStartTs: number | undefined;
  const updateAct = (fn: (a: Activity) => Activity) => {
    const row = out[actIdx]!;
    out[actIdx] = { ...row, activity: fn(row.activity!) };
  };
  for (const ev of events) {
    if (ev.kind === 'turn_start') {
      currentTurnId = typeof ev.turnId === 'string' ? ev.turnId : undefined;
      pendingThinking = null;
      pendingFallback = null;
      actIdx = -1;
      turnStartTs = ev.ts;
      continue;
    }
    if (ev.kind === 'tool_call' && typeof ev.tool === 'string') {
      const tool = ev.tool.replace(/^mcp__[^_]+__/, '');
      const ts = ev.ts ?? 0;
      if (actIdx < 0) {
        out.push({
          id: `t-${ts}-${msgIdCounter++}`,
          role: 'activity',
          text: '',
          ts,
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
          // The turn's time counts from its start, not its first call.
          activity: newActivity(turnStartTs ?? ts),
        });
        actIdx = out.length - 1;
      }
      updateAct((a) => addCall(a, { tool, label: stepLabel(tool, ev.input), ts, ...(ev.callId ? { callId: ev.callId } : {}) }));
      continue;
    }
    if (ev.kind === 'tool_result') {
      if (actIdx >= 0) {
        updateAct((a) => settleCall(a, { ...(ev.callId ? { callId: ev.callId } : {}), ...(typeof ev.error === 'string' && ev.error ? { error: ev.error } : {}) }));
      }
      continue;
    }
    if (ev.kind === 'model_fallback' && typeof ev.requested === 'string' && typeof ev.actual === 'string') {
      pendingFallback = {
        requested: ev.requested,
        actual: ev.actual,
        reason: typeof ev.reason === 'string' ? ev.reason : '',
        ...(Array.isArray(ev.hops) ? { hops: ev.hops as ModelFallback['hops'] } : {}),
      };
      continue;
    }
    if (ev.kind === 'turn_end') {
      // Keep the id: assistant_media for this turn is written AFTER
      // turn_end. The next turn_start replaces it.
      if (typeof ev.turnId === 'string') currentTurnId = ev.turnId;
      pendingThinking = null;
      if (actIdx >= 0) updateAct((a) => closeActivity(a, ev.ts ?? 0));
      actIdx = -1;
      turnStartTs = undefined;
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
    if (mapped.role === 'agent' && pendingFallback) {
      mapped.fallback = pendingFallback;
      pendingFallback = null;
    }
    out.push(mapped);
  }
  return out;
}

/**
 * Fold a fresh history snapshot into what is already on screen.
 *
 * The snapshot is authoritative for everything it covers; anything the
 * live stream produced AFTER its newest event is kept. Replacing the
 * list instead — which is what both clients used to do — meant a
 * snapshot that arrived late could take a just-streamed answer with it.
 * That was one of the two ways an answer went missing after a
 * connection blip (2026-09-09 report); the other was never asking for a
 * snapshot after a silent reconnect at all.
 */
export function mergeHistorySnapshot(restored: ChatMessage[], live: readonly ChatMessage[]): ChatMessage[] {
  if (restored.length === 0) return [...live];
  const oldestPersistedTs = restored[0]!.ts;
  // An activity row stands where its turn's first call was but covers
  // every call after it: the snapshot reaches as far as its last one.
  const newestPersistedTs = Math.max(...restored.map(lastTsOf));
  // The snapshot is the newest window only: what was scrolled in before
  // it stays, what the stream added after it stays.
  const merged = [
    ...live.filter((m) => m.ts < oldestPersistedTs),
    ...restored,
    ...live.filter((m) => m.ts > newestPersistedTs),
  ];
  // Memory rows are live only — history does not carry them — so the
  // ones inside the window go back in at their moment.
  const inside = live.filter((m) => m.role === 'memory' && m.ts >= oldestPersistedTs && m.ts <= newestPersistedTs);
  for (const row of inside) {
    const at = merged.findIndex((m) => m.ts > row.ts);
    merged.splice(at < 0 ? merged.length : at, 0, row);
  }
  return merged;
}

/** The newest moment a row stands for. */
function lastTsOf(m: ChatMessage): number {
  if (!m.activity) return m.ts;
  const last = m.activity.steps[m.activity.steps.length - 1];
  return Math.max(m.ts, last?.ts ?? 0, m.activity.endedAt ?? 0);
}

/** An older page of history in front of what is shown. A turn cut by
 *  the page boundary keeps one activity row. */
export function prependOlderMessages(older: ChatMessage[], shown: readonly ChatMessage[]): ChatMessage[] {
  const firstShownTs = shown.length > 0 ? shown[0]!.ts : Number.POSITIVE_INFINITY;
  const kept = older.filter((m) => m.ts < firstShownTs);
  const tail = kept[kept.length - 1];
  const head = shown[0];
  if (
    tail?.activity && head?.activity && tail.activity.endedAt === undefined &&
    (!head.turnId || !tail.turnId || head.turnId === tail.turnId)
  ) {
    const joined: ChatMessage = {
      ...tail,
      ...(tail.turnId ?? head.turnId ? { turnId: tail.turnId ?? head.turnId } : {}),
      activity: joinActivities(tail.activity, head.activity),
    };
    return [...kept.slice(0, -1), joined, ...shown.slice(1)];
  }
  return [...kept, ...shown];
}

/** A live `tool` event (GET /chat/stream). */
export interface LiveToolEvent {
  phase: 'call' | 'result' | 'error';
  tool: string;
  callId?: string;
  /** The input (call) or output (result) as pretty JSON. */
  details?: string;
  error?: string;
}

/**
 * Fold a live tool event into the list: onto the activity row of the
 * running turn, or a new one placed where the turn's reply will stand —
 * above its streaming bubble and above messages still waiting to be
 * sent, like the compaction note.
 */
export function applyLiveTool(prev: readonly ChatMessage[], d: LiveToolEvent, now: number, turnId: string | null): ChatMessage[] {
  const tool = d.tool.replace(/^mcp__[^_]+__/, '');
  let idx = -1;
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    const m = prev[i]!;
    if (m.role === 'activity') {
      const sameTurn = !turnId || !m.turnId || m.turnId === turnId;
      if (m.activity && m.activity.endedAt === undefined && sameTurn) idx = i;
      break;
    }
    // A message that started a later turn: the row before it is not ours.
    if (m.role === 'user' && !m.pending && !m.steer) break;
  }
  if (d.phase !== 'call') {
    if (idx < 0) return prev as ChatMessage[];
    const row = prev[idx]!;
    const next = prev.slice();
    next[idx] = {
      ...row,
      activity: settleCall(row.activity!, {
        tool,
        ...(d.callId ? { callId: d.callId } : {}),
        ...(d.phase === 'error' ? { error: d.error || 'tool failed' } : {}),
      }),
    };
    return next;
  }
  const step = { tool, label: stepLabel(tool, d.details), ts: now, ...(d.callId ? { callId: d.callId } : {}) };
  if (idx >= 0) {
    const row = prev[idx]!;
    const next = prev.slice();
    next[idx] = { ...row, activity: addCall(row.activity!, step) };
    return next;
  }
  const row: ChatMessage = {
    id: newId('t'),
    role: 'activity',
    text: '',
    ts: now,
    ...(turnId ? { turnId } : {}),
    activity: addCall(newActivity(now), step),
  };
  let at = prev.findIndex((m) => (m.role === 'agent' && m.streaming) || (m.role === 'user' && m.pending && !m.steer));
  if (at < 0) at = prev.length;
  return [...prev.slice(0, at), row, ...prev.slice(at)];
}

/** A live `memory` event (GET /chat/stream): the notes recalled for
 *  the turn that starts. */
export interface LiveMemoryEvent {
  count?: unknown;
  topScore?: unknown;
  refs?: unknown;
  fullText?: unknown;
}

/** Add the turn's memory row where its reply will stand — above its
 *  streaming bubble and above messages still waiting to be sent, like
 *  a new activity row. Nothing recalled adds nothing. */
export function applyLiveMemory(prev: readonly ChatMessage[], d: LiveMemoryEvent, now: number, turnId: string | null): ChatMessage[] {
  if (typeof d.count !== 'number' || d.count <= 0 || !Array.isArray(d.refs)) return prev as ChatMessage[];
  const row: ChatMessage = {
    id: newId('m'),
    role: 'memory',
    text: '',
    ts: now,
    ...(turnId ? { turnId } : {}),
    memory: {
      count: d.count,
      refs: d.refs.filter((r): r is string => typeof r === 'string'),
      ...(typeof d.topScore === 'number' ? { topScore: d.topScore } : {}),
      ...(typeof d.fullText === 'string' && d.fullText ? { fullText: d.fullText } : {}),
    },
  };
  let at = prev.findIndex((m) => (m.role === 'agent' && m.streaming) || (m.role === 'user' && m.pending && !m.steer));
  if (at < 0) at = prev.length;
  return [...prev.slice(0, at), row, ...prev.slice(at)];
}

/** The turn ended (agent end, turn error): every open activity row
 *  closes. Returns the same array when nothing was open. */
export function closeLiveActivities(prev: ChatMessage[], now: number): ChatMessage[] {
  let changed = false;
  const next = prev.map((m) => {
    if (!m.activity || m.activity.endedAt !== undefined) return m;
    changed = true;
    return { ...m, activity: closeActivity(m.activity, now) };
  });
  return changed ? next : prev;
}
