// Internal canonical event format. Persisted as JSONL (later in step 1b+).
// Engine-agnostic — every adapter (anthropic, openai, ...) maps SDK events to this shape.
export type NormalizedEvent =
  | { kind: 'user_message'; ts: number; engine: string; text: string }
  | { kind: 'assistant_delta'; ts: number; engine: string; text: string }
  | { kind: 'assistant_message'; ts: number; engine: string; text: string }
  | { kind: 'tool_call'; ts: number; engine: string; callId: string; tool: string; input: unknown }
  | { kind: 'tool_result'; ts: number; engine: string; callId: string; output: unknown; error?: string }
  | { kind: 'turn_start'; ts: number; engine: string; turnId: string }
  | { kind: 'turn_end'; ts: number; engine: string; turnId: string; usage?: { tokens_in: number; tokens_out: number } }
  | { kind: 'error'; ts: number; engine: string; message: string };

// Wire format over SSE — orbit-compatible. Deltas are cumulative.
export type SseEvent =
  | { event: 'chat'; data: { state: 'delta' | 'final'; text: string } }
  | {
      event: 'agent';
      data: {
        phase: 'start' | 'end';
        usage?: { tokens_in: number; tokens_out: number };
        contextWindow?: number;
        provider?: string;
        model?: string;
      };
    }
  | { event: 'tool'; data: { phase: 'call' | 'result'; tool?: string; input?: unknown; output?: unknown; error?: string } }
  | { event: 'status'; data: { msg: string } };
