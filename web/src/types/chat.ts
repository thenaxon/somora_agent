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

export type ChatMessage =
  | {
      id: string;
      role: 'user';
      ts: number;
      text: string;
      fromAgent?: string;
      attachments?: AttachmentDisplay[];
    }
  | { id: string; role: 'assistant'; ts: number; text: string; streaming?: boolean }
  | { id: string; role: 'tool_call'; ts: number; toolCall: ToolCallPayload }
  | { id: string; role: 'tool_result'; ts: number; toolResult: ToolResultPayload }
  | { id: string; role: 'memory_inject'; ts: number; memory: MemoryHitsSnapshot };

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
      data: { text: string; ts: number; from_agent?: string };
    };
