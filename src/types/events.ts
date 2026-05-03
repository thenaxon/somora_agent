// Internal canonical event format. Persisted as JSONL (later in step 1b+).
// Engine-agnostic — every adapter (anthropic, openai, ...) maps SDK events to this shape.
export type NormalizedEvent =
  | {
      kind: 'user_message';
      ts: number;
      engine: string;
      text: string;
      /**
       * Agent-to-agent (A2A) attribution. When set, this user_message
       * was written into THIS session by another somora agent (via
       * `agent_ask` or as a sub-task seed) — NOT by the human user.
       *
       * Semantics:
       *   - undefined → human user (default, unchanged behavior)
       *   - 'hans'    → Hans wrote this turn into the current agent's
       *                 session as part of an A2A flow.
       *
       * Storage: persists in JSONL alongside `text`; replays into
       * cross-engine context with a "[Message from agent <name>]"
       * header so other engines learn provenance during catch-up.
       *
       * TUI: rendered with the sender's icon instead of the user icon.
       */
      from_agent?: string;
    }
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
        /** Reasoning/thinking tokens (subset of tokens_out). Optional — only reasoning-capable models surface it. */
        tokens_out_reasoning?: number;
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
        usage?: {
          tokens_in: number;
          tokens_out: number;
          tokens_in_cached?: number;
          tokens_out_reasoning?: number;
        };
        contextWindow?: number;
        provider?: string;
        model?: string;
        /**
         * Effective thinking depth for this turn. Surfaces what the
         * engine actually applied so clients can show it in the header.
         * 'dormant' = setting present but model lacks 'reasoning' capability.
         */
        thinking?: { level: 'off' | 'low' | 'medium' | 'high'; active: boolean };
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
        // Full inject block text — exactly what was concatenated into
        // the engine's systemPrompt/ephemeralContext for this turn.
        // Always present; clients render only when /verbose memory is on.
        fullText: string;
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
        | { phase: 'call'; tool: string; summary: string; details: string }
        | { phase: 'result'; tool: string; summary: string; details: string }
        | { phase: 'error'; tool: string; error: string; details?: string };
    }
  | { event: 'status'; data: { msg: string } };
