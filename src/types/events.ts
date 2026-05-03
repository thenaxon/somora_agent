// Internal canonical event format. Persisted as JSONL (later in step 1b+).
// Engine-agnostic — every adapter (anthropic, openai, ...) maps SDK events to this shape.
export type NormalizedEvent =
  | { kind: 'user_message'; ts: number; engine: string; text: string }
  | { kind: 'assistant_delta'; ts: number; engine: string; text: string }
  | { kind: 'assistant_message'; ts: number; engine: string; text: string }
  | { kind: 'tool_call'; ts: number; engine: string; callId: string; tool: string; input: unknown }
  | { kind: 'tool_result'; ts: number; engine: string; callId: string; output: unknown; error?: string }
  | { kind: 'turn_start'; ts: number; engine: string; turnId: string }
  | {
      kind: 'turn_end';
      ts: number;
      engine: string;
      turnId: string;
      usage?: {
        tokens_in: number;
        tokens_out: number;
        /** Tokens served from the provider's prefix-cache (subset of tokens_in). Optional — not all engines surface it. */
        tokens_in_cached?: number;
      };
    }
  | { kind: 'error'; ts: number; engine: string; message: string };

// Wire format over SSE — orbit-compatible. Deltas are cumulative.
export type SseEvent =
  | { event: 'chat'; data: { state: 'delta' | 'final'; text: string } }
  | {
      event: 'agent';
      data: {
        phase: 'start' | 'end';
        usage?: { tokens_in: number; tokens_out: number; tokens_in_cached?: number };
        contextWindow?: number;
        provider?: string;
        model?: string;
      };
    }
  | {
      // Per-turn auto-inject summary — what the runtime pulled from memory
      // before the engine ran. Lets the CLI / orbit show users which notes
      // were surfaced without them having to grep server logs.
      event: 'memory';
      data: {
        count: number;
        topScore?: number;
        // `<source>/<slug>` references in score order, top first.
        refs: string[];
      };
    }
  | {
      // Tool lifecycle event. Server pre-formats the renderable bits:
      //   call   → tool name (stripped of mcp__ prefix) + args summary
      //   result → tool name + result summary (omitted entirely if trivial,
      //            so clients never see "boring" rows like {ok:true})
      //   error  → tool name + error string
      // Clients render summary/error directly without inspecting raw payloads.
      event: 'tool';
      data:
        | { phase: 'call'; tool: string; summary: string }
        | { phase: 'result'; tool: string; summary: string }
        | { phase: 'error'; tool: string; error: string };
    }
  | { event: 'status'; data: { msg: string } };
