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
      fromSystem?: 'sentinel';
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
      /** Voice: server-generated TTS audio for this turn. Set when an
       *  assistant_audio SSE event with matching turnId arrived after
       *  the assistant message. Drives the per-bubble Play-button. */
      audio?: AssistantAudio;
      /** The engine-emitted turnId for this message. Used to pair
       *  late-arriving assistant_audio events to the right bubble. */
      turnId?: string;
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
}

export interface MemoryHitsSnapshot {
  count: number;
  topScore: number | null;
  refs: string[];
  fullText?: string;
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
      event: 'agent';
      data: {
        phase: 'start' | 'end';
        usage?: ChatUsage;
        contextWindow?: number;
        provider?: string;
        model?: string;
        thinking?: { level: 'off' | 'low' | 'medium' | 'high'; active: boolean };
      };
    }
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
        from_system?: 'sentinel';
      };
    }
  | {
      event: 'turn_queued';
      data: {
        turnId: string;
        ahead: number;
      };
    }
  | {
      event: 'assistant_audio';
      data: { turnId: string; url: string; mime: string; durationMs?: number; cacheKey: string };
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
