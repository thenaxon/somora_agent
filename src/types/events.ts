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
       *   - '<agent>' → another agent wrote this turn into the current
       *                 agent's session as part of an A2A flow.
       *
       * Storage: persists in JSONL alongside `text`; replays into
       * cross-engine context with a "[Message from agent <name>]"
       * header so other engines learn provenance during catch-up.
       *
       * TUI: rendered with the sender's icon instead of the user icon.
       */
      from_agent?: string;
      /**
       * Correlation UUID for an `agent_ask` round-trip. Persisted on
       * BOTH sides: on the caller's side as a tool_call → tool_result
       * pair (the call_id is in the tool_call payload), and on the
       * target's side as user_message.agent_ask_call_id alongside
       * from_agent.
       *
       * MVP today: plumbed through but only used for log correlation.
       * FUTURE: powers a planned `agent_ask_result(call_id)` retrieval
       * tool so a caller can pick up the response asynchronously when
       * the synchronous wait timed out (see A2A-design.md).
       */
      agent_ask_call_id?: string;
      /**
       * Memory-recall block (`<memory-context>...</memory-context>`)
       * that was injected at the time THIS turn was sent. Persisted
       * here so history reconstruction at later turns recreates the
       * exact byte sequence we originally sent — required for
       * prefix-cache to match across turns on stateless backends.
       *
       * Without this field, openai-compatible engines have no way to
       * rebuild past user_messages identically (every turn re-queries
       * memory and gets potentially different hits), so any cache
       * breakpoint sitting between the system block and the latest
       * user message gets invalidated turn-after-turn.
       *
       * Engines that don't reconstruct full history (claude-cli /
       * codex-cli with resumed sessions) ignore this field — they
       * inline the memory block into the outgoing user_message text
       * directly, and the underlying provider remembers the prior
       * turns it already saw.
       *
       * TUI rendering should display only `text`, not `ephemeral` —
       * the recall block is internal scaffolding, not user-typed.
       */
      ephemeral?: string;
      /**
       * User-attached files (Phase Y.B, web upload). Refs only — bytes
       * live at `~/.somora/attachments/<hash>.<ext>` content-
       * addressed. JSONL persists name/mime/size for display +
       * sanity-checks at replay time; the path is derived from the
       * hash on demand.
       */
      attachments?: Array<{
        hash: string;
        name: string;
        mime: string;
        size: number;
      }>;
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
  | { kind: 'error'; ts: number; engine: string; message: string }
  // Server-side marker for project focus changes within a session. Fired
  // whenever the user pins a project via slash-command OR an agent
  // autonomously calls project_focus via the Tool surface. Persists in
  // JSONL purely for forensics: lets you reconstruct "from which turn
  // onwards did this session see project context X?" months later
  // without needing to replay session.meta history. The `engine` field
  // is the sentinel `'somora'` here — these aren't engine-emitted.
  | {
      kind: 'project_switched';
      ts: number;
      engine: string;
      from: string | null;
      to: string | null;
      via: 'tool' | 'slash_command';
    };

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
  | { event: 'status'; data: { msg: string } }
  | {
      // A2A user-message broadcast. Fired ONLY when an `agent_ask` (or
      // similar A2A tool) writes a user_message with `from_agent` set
      // into a session. Used by the TUI of a human watching that
      // session live so they see the inbound A2A turn appear in real
      // time, rendered with the sender's icon instead of their own.
      //
      // Now ALSO fired for self-typed turns so multi-client setups
      // (TUI tail + web window open at once) see each other's
      // inputs live. Senders dedupe their own optimistic copy by
      // recent-text — TUI does this implicitly via the local echo,
      // web's ChatProvider tracks pending texts in a ref.
      event: 'user_message';
      data: {
        text: string;
        ts?: number;
        /** Set only when the message came from another agent
         *  (A2A). Self-typed user turns omit it. */
        from_agent?: string;
        agent_ask_call_id?: string;
      };
    }
  | {
      // Project focus change. Fired when the user (via /projekt slash-
      // command or web button) pins or clears a project for this
      // session. Clients use this to live-update the project-chip in
      // the chat header without polling.
      //
      // `to: null` means the focus was cleared. Agent-initiated focus
      // changes from MCP-routed tool calls (claude-cli / codex-cli)
      // don't have SSE access from the child process — the client
      // catches up on the next chat:final or by refetching
      // /agents/:agent/sessions/:session/project explicitly.
      event: 'project';
      data: {
        from: string | null;
        to: string | null;
        via: 'tool' | 'slash_command';
      };
    };
