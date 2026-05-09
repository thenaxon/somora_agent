// Normalized chat-message + stream-event types. Mirrors the server
// JSONL event shapes (src/types/events.ts) and the TUI's stream
// adapter — same vocabulary across all clients.

export interface ToolCallPayload {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultPayload {
  callId: string;
  output: unknown;
}

export type ChatMessage =
  | { id: string; role: 'user'; ts: number; text: string }
  | { id: string; role: 'assistant'; ts: number; text: string; streaming?: boolean }
  | { id: string; role: 'tool_call'; ts: number; toolCall: ToolCallPayload }
  | { id: string; role: 'tool_result'; ts: number; toolResult: ToolResultPayload };

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
}

/** SSE events emitted by /chat/stream. We listen for these by name
 *  via EventSource.addEventListener — server sends `event: <name>`
 *  + JSON `data:`. */
export type StreamEvent =
  | { kind: 'status'; msg: string }
  | { kind: 'agent-start' }
  | {
      kind: 'agent-end';
      usage?: ChatUsage;
      contextWindow?: number;
      provider?: string;
      model?: string;
    }
  | { kind: 'chat-delta'; text: string }
  | { kind: 'chat-final'; text: string }
  | {
      kind: 'memory';
      count: number;
      topScore: number | null;
      refs: string[];
    }
  | {
      kind: 'tool';
      callId?: string;
      tool: string;
      phase: 'call' | 'result' | 'error' | string;
      input?: Record<string, unknown>;
      output?: unknown;
      summary?: string;
      error?: string;
    }
  | { kind: 'user-message'; text: string; ts: number; from_agent?: string }
  | { kind: 'heartbeat' };
