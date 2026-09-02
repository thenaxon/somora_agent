// Normalized chat-message + stream-event types. Mirrors the server's
// SseEvent shape (src/types/events.ts) — same vocabulary across all
// clients (TUI, web, future orbit).
//
// Wire format key gotcha: server emits `event: chat / agent / tool /
// memory / status / user_message` with a discriminated `data` shape
// (state for chat, phase for agent + tool, etc.). NOT separate
// chat-delta / chat-final events. The web client decodes these into
// ChatMessage rows below.

export interface ToolCallPayload {
  callId?: string;
  tool: string;
  /** Server-formatted args summary (one line, ready to render). */
  summary?: string;
  /** Server-formatted full details (multi-line, pretty). */
  details?: string;
  /** Raw input (only present from JSONL history events — live SSE
   *  events arrive pre-formatted via summary/details). */
  input?: Record<string, unknown>;
}

export interface ToolResultPayload {
  callId?: string;
  tool: string;
  summary?: string;
  details?: string;
  /** Set when the tool errored — `summary`/`details` are absent. */
  error?: string;
  /** Raw output from JSONL history. */
  output?: unknown;
}

export interface AttachmentDisplay {
  hash: string;
  name: string;
  mime: string;
  kind: 'image' | 'pdf' | 'text';
  size: number;
}

/** One image generated during an assistant turn. Refs only — bytes
 *  are served by GET /images/:id/file. */
/** One item from an `assistant_media` event. `type` decides how it is
 *  rendered; an entry whose type this client doesn't know is skipped
 *  rather than guessed at, which is what lets a future video type land
 *  without breaking older clients. */
export interface AssistantMedia {
  type: 'image' | 'video';
  id: string;
  prompt: string;
  mime: string;
  filename: string;
  /** Path served by the somora server. Rows written on 2026-08-27
   *  carry `/images/<id>/file`; newer ones `/media/<id>/file`. Both
   *  stay served — the string is in session files. */
  url: string;
  /** Video: a still to show before playback starts. */
  thumbUrl?: string;
  /** Video: playing time in seconds. */
  durationSec?: number;
}

/** The model's reasoning text for one assistant turn. Arrives via the
 *  `thinking` SSE event (cumulative deltas, then a final) and, on
 *  history load, from the `thinking_message` JSONL row that precedes
 *  the turn's assistant_message. Plain text — never markdown-rendered. */
export interface ThinkingContent {
  text: string;
  /** The server cut the text at its configured cap (ends with `…`). */
  truncated?: boolean;
  /** True while thinking deltas are still arriving for this turn. */
  streaming?: boolean;
}

export interface AssistantAudio {
  /** Path served by GET /tts/cache/:hash.:ext on the somora server. */
  url: string;
  mime: string;
  durationMs?: number;
  cacheKey: string;
}

export type ChatMessage =
  | {
      id: string;
      role: 'user';
      ts: number;
      text: string;
      fromAgent?: string;
      /** Marks an inbound that the server synthesized via an internal
       *  subsystem (today: 'sentinel'). Renderer draws a centered
       *  system divider instead of a user-bubble. */
      fromSystem?: 'sentinel' | 'tmux' | 'subagent' | 'job';
      attachments?: AttachmentDisplay[];
      /** Server turnId returned by POST /chat/send. Used to pair this
       *  optimistic bubble with later SSE events (turn_queued while
       *  waiting in line, user_message once the lock is acquired). */
      turnId?: string;
      /** Queue state for the user-typed turn this bubble represents:
       *   - undefined: not queued (lock was free; turn started right away)
       *   - { ahead: N }: enqueued behind N other turns (>=1)
       *   - cleared back to undefined when matching user_message arrives
       *  Sentinel and A2A inbounds never carry this. */
      queued?: { ahead: number };
      /** True from the moment the optimistic bubble is rendered until
       *  the server's user_message SSE event for the matching turnId
       *  arrives (which signals "this turn is now actually running").
       *  Used by the chat:delta handler to position a freshly-spawned
       *  assistant bubble BEFORE any still-pending user bubbles —
       *  i.e., queued messages stay below the agent's reply for the
       *  turn that's currently in flight, instead of being jumped
       *  over by the first delta. Invisible to the user; queued
       *  drives the visible "⌛ queued" marker. */
      pending?: boolean;
    }
  | {
      id: string;
      role: 'assistant';
      ts: number;
      text: string;
      streaming?: boolean;
      /** The persona's fallback model answered this turn (primary failed
       *  before producing content). Drives the ⇄ chip on the bubble. */
      fallback?: ModelFallback;
      /** Voice: server-generated TTS audio for this turn. Set when an
       *  assistant_audio SSE event with matching turnId arrived after
       *  the assistant message. Drives the per-bubble Play-button. */
      audio?: AssistantAudio;
      /** Media produced while this turn ran. Arrives after the text as
       *  an assistant_media event and is rendered under the bubble, so
       *  a person who asked for a picture gets the picture without the
       *  agent having to remember to send it. */
      media?: AssistantMedia[];
      /** The engine-emitted turnId for this message. Used to pair
       *  late-arriving assistant_audio events to the right bubble. */
      turnId?: string;
      /** Reasoning the model produced before/while writing this reply.
       *  Rendered as a collapsible block above the text. Absent when
       *  the engine does not surface thinking or capture is off. */
      thinking?: ThinkingContent;
    }
  | {
      /** The turn ended with an error (engine 5xx, abort, watchdog)
       *  instead of — or after — an assistant message. Rendered as a
       *  block inside the turn, so a failure is visible where it
       *  happened and media the turn produced before failing hangs
       *  under it, not under the previous answer (2026-08-28 report). */
      id: string;
      role: 'error';
      ts: number;
      text: string;
      turnId?: string;
      media?: AssistantMedia[];
    }
  | { id: string; role: 'tool_call'; ts: number; toolCall: ToolCallPayload }
  | { id: string; role: 'tool_result'; ts: number; toolResult: ToolResultPayload }
  | { id: string; role: 'memory_inject'; ts: number; memory: MemoryHitsSnapshot }
  | { id: string; role: 'engine_meta'; ts: number; meta: EngineMetaPayload };

export interface EngineMetaPayload {
  engine: string;
  itemType: string;
  /** Pretty label resolved server-side (e.g. todo_list → "plan"). Falls
   *  back to itemType verbatim for unknown types. */
  label: string;
  /** Optional one-liner summary (e.g. "3 tasks · 2 done"). */
  summary?: string;
  /** Opaque structured payload — clients render known shapes nicely,
   *  fall back to compact JSON for unknowns. */
  payload: unknown;
}

export interface ChatUsage {
  tokens_in?: number;
  tokens_in_cached?: number;
  tokens_out?: number;
  tokens_out_reasoning?: number;
  /** True when the reasoning count is an estimate from streamed text. */
  tokens_out_reasoning_estimated?: boolean;
}

export interface MemoryHitsSnapshot {
  count: number;
  topScore: number | null;
  refs: string[];
  fullText?: string;
}

/** Primary → fallback switch for one turn. Refs are `provider/modelId`. */
export interface ModelFallback {
  requested: string;
  actual: string;
  reason: string;
}

/** Live SSE wire-format envelope. The `event:` line is the
 *  discriminator, `data:` is the JSON-encoded payload below. */
export type StreamEvent =
  | { event: 'status'; data: { msg: string; session?: string } }
  | { event: 'heartbeat'; data: number | string }
  | {
      event: 'chat';
      data: { state: 'delta' | 'final'; text: string };
    }
  | {
      /** Model reasoning for the in-flight turn. `text` is cumulative
       *  like `chat`; `final` arrives before the `chat` final. */
      event: 'thinking';
      data: { state: 'delta' | 'final'; text: string; truncated?: true };
    }
  | {
      event: 'agent';
      data: {
        phase: 'start' | 'end';
        usage?: ChatUsage;
        contextWindow?: number;
        provider?: string;
        model?: string;
        thinking?: { level: 'off' | 'low' | 'medium' | 'high'; active: boolean };
        fallback?: ModelFallback;
      };
    }
  | { event: 'model_fallback'; data: ModelFallback }
  | {
      event: 'memory';
      data: { count: number; topScore?: number; refs: string[]; fullText?: string };
    }
  | {
      event: 'tool';
      data:
        | { phase: 'call'; tool: string; summary: string; details: string }
        | { phase: 'result'; tool: string; summary: string; details: string }
        | { phase: 'error'; tool: string; error: string; details?: string };
    }
  | {
      event: 'user_message';
      data: {
        text: string;
        ts: number;
        turnId?: string;
        from_agent?: string;
        from_system?: 'sentinel' | 'tmux' | 'subagent' | 'job';
      };
    }
  | {
      event: 'turn_queued';
      data: {
        turnId: string;
        ahead: number;
      };
    }
  | { event: 'turn_dequeued'; data: { turnId: string } }
  | { event: 'turn_started'; data: { turnId: string } }
  | { event: 'turn_error'; data: { turnId?: string; message: string; engine: string } }
  | {
      event: 'assistant_audio';
      data: { turnId: string; url: string; mime: string; durationMs?: number; cacheKey: string };
    }
  | {
      event: 'assistant_media';
      data: { turnId: string; media: AssistantMedia[] };
    }
  | {
      event: 'engine_meta';
      data: {
        engine: string;
        itemType: string;
        label: string;
        summary?: string;
        payload: unknown;
      };
    };
