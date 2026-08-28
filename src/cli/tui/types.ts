// Shared types between Ink components and the network layer.
// Kept in plain .ts so non-React code (api.ts, stream.ts) can import them
// without dragging React into modules that don't need it.

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface ThinkingState {
  level: ThinkingLevel;
  // True if the active model has the 'reasoning' capability — i.e.
  // the setting is actually being applied. False = dormant.
  active: boolean;
}

export interface TurnStats {
  tokensIn: number;
  tokensInCached: number | null;
  tokensOut: number;
  tokensOutReasoning: number | null;
  contextWindow: number | null;
  provider: string | null;
  model: string | null;
  thinking: ThinkingState | null;
}

export interface SessionThinkingInfo {
  effective: ThinkingLevel | null;
  override: ThinkingLevel | null;
  personaDefault: ThinkingLevel | null;
  source: 'session-override' | 'persona-default' | 'engine-default';
  modelSupportsReasoning: boolean;
}

export interface AgentInfo {
  name: string;
  description: string;
  icon?: string;
}

export interface SessionSummary {
  id: string;
  slug: string;
  isMain: boolean;
  createdAt: string | null;
  lastActivity: string | null;
  messageCount: number;
  /** Currently-pinned project, if any (Phase Projects v1). */
  projectSlug?: string;
  /** ISO timestamp of the latest unread-candidate event (A2A in,
   *  sentinel in, assistant final reply). Null if none. */
  unreadAt?: string | null;
  /** ISO timestamp of when any client last viewed this session. */
  seenAt?: string | null;
}

// Project surface — mirror of the server's project frontmatter, kept lean
// for what the TUI actually renders.
export interface ProjectEntityInfo {
  slug: string;
  label: string;
}

export interface ProjectPathInfo {
  ref: string;
  label?: string;
}

export interface ProjectInfo {
  slug: string;
  name: string;
  entity: string;
  description?: string;
  color?: string;
  tags: string[];
  paths: ProjectPathInfo[];
  archived: boolean;
}

export interface SessionProjectInfo {
  /** Pinned project slug or null if none. */
  slug: string | null;
  /** Loaded project frontmatter (null when slug is null OR when the
   *  pinned slug points at a missing file — server returns `missing:true`
   *  in that case but the TUI just sees `project: null`). */
  project: ProjectInfo | null;
}

export interface ModelInfo {
  provider: string;
  id: string;
  alias: string | null;
  engine: string;
  contextWindow: number;
  capabilities: string[];
  ref: string;
}

export interface SessionModelInfo {
  provider: string;
  modelId: string;
  alias: string | null;
  engine: string;
  contextWindow: number;
  source: 'session-override' | 'persona-default';
  override: string | null;
  personaDefault: string | null;
}

export interface ResetResult {
  archivedId: string | null;
  reason?: string;
  dreamSpawned?: boolean;
}

// Mirrors the server's TuiConfig schema. Keep in sync with
// src/config/types.ts → TuiConfigSchema. We don't import the server type
// directly so the TUI stays decoupled from server modules.
export interface TuiConfig {
  show: {
    memory: boolean;
    tools: boolean;
  };
  verbose: {
    tools: boolean;
    memory: boolean;
    system: boolean;
  };
}

// Per-session pending user-turn waiting for its lock. Lives in app
// state (not in the Static-flushed `turns` array) because Static
// items are committed once and can't mutate later — and a queued
// turn needs to transition from "queued · N ahead" to "running" to
// "done" over its lifetime. When the matching user_message SSE
// event arrives the entry is removed from pendingQueued and a
// normal `Turn { kind: 'user' }` is appended to the scrollback.
export interface PendingQueuedTurn {
  /** Local-only id; the Turn appended later gets a fresh id. */
  localId: string;
  /** Server-issued turnId, set after POST /chat/send returns. Used
   *  to pair with turn_queued + user_message SSE events. */
  turnId?: string;
  text: string;
  ts: number;
  /** Set when a turn_queued SSE event arrived. `ahead` = number of
   *  turns this one must wait for (>=1, including current). */
  queued?: { ahead: number };
}

// All Turn-kinds that the scrollback can render. Kept flat (discriminated
// union) so React reducers don't need a class hierarchy.
export type Turn =
  | {
      kind: 'user';
      id: string;
      text: string;
      fromAgent?: string;
      /** Set on synthesized inbounds (today: 'sentinel'). TUI
       *  renders the row as a compact system-trigger line instead
       *  of a user turn. */
      fromSystem?: 'sentinel' | 'tmux' | 'subagent';
    }
  | { kind: 'agent'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      phase: 'call' | 'result' | 'error';
      // Server pre-formats both lines into renderable strings. The TUI
      // never sees raw input/output — see src/server/tool-format.ts.
      summary?: string;
      error?: string;
      // Pretty-printed full payload (for /verbose tools).
      details?: string;
    }
  | {
      kind: 'memory';
      id: string;
      count: number;
      topScore: number | null;
      refs: string[];
      // Full inject text (for /verbose memory).
      fullText?: string;
    }
  | {
      // engine-internal side-channel (codex todo_list, future engines
      // may add more). Visibility piggybacks on show.tools — same
      // bucket conceptually. Detail line for /verbose tools.
      kind: 'engine_meta';
      id: string;
      engine: string;
      itemType: string;
      label: string;
      summary?: string;
      details?: string;
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'warn' | 'error' }
  /**
   * Media an agent produced during the turn. A terminal can't show a
   * picture, so this is the PATH — which is the more useful half here
   * anyway: it can be copied, opened, piped. Deliberately not an
   * inline-image escape sequence: only some terminals speak one, and
   * Ink measures such output wrongly enough to shift the cursor.
   */
  | {
      kind: 'media';
      id: string;
      items: Array<{ type: 'image' | 'video'; filename: string; durationSec?: number }>;
    };

// Server-Sent Events from /chat/stream, normalized.
export type StreamEvent =
  | { kind: 'connected' }
  | { kind: 'agent-start'; thinking?: ThinkingState }
  | {
      kind: 'agent-end';
      usage?: {
        tokens_in?: number;
        tokens_in_cached?: number;
        tokens_out?: number;
        tokens_out_reasoning?: number;
      };
      contextWindow?: number;
      provider?: string;
      model?: string;
      thinking?: ThinkingState;
    }
  | { kind: 'chat-delta'; text: string }
  | {
      kind: 'assistant-media';
      items: Array<{ type: 'image' | 'video'; filename: string; durationSec?: number }>;
    }
  | { kind: 'chat-final'; text: string }
  | { kind: 'memory'; count: number; topScore: number | null; refs: string[]; fullText?: string }
  | {
      kind: 'tool';
      tool: string;
      phase: 'call' | 'result' | 'error' | string;
      summary?: string;
      error?: string;
      details?: string;
    }
  | {
      // Engine internal side-channel (codex todo_list etc.). Rendered
      // by the TUI when show.tools is on, with a slightly dimmer style
      // and a distinct `engine ·` prefix so it's clear it didn't come
      // from somora's tool layer.
      kind: 'engine_meta';
      engine: string;
      itemType: string;
      label: string;
      summary?: string;
      payload: unknown;
    }
  | {
      // Live A2A user_message: another agent wrote into the session
      // we're watching. Rendered with the sender's name as a marker
      // instead of the local user icon.
      //
      // Self-typed sends from other clients (e.g. a web tab open
      // on the same session as the TUI) also come through this
      // event WITHOUT fromAgent — the consumer dedupes its own
      // optimistic copy by recent-text and renders the rest as
      // normal user turns.
      kind: 'user-message';
      text: string;
      turnId?: string;
      fromAgent?: string;
      fromSystem?: 'sentinel' | 'tmux' | 'subagent';
      callId?: string;
    }
  | {
      // POST /chat/send was accepted but the lock is busy — server
      // pushed this turn into the queue. Carries the turnId that
      // POST /chat/send returned (echoed back) plus how many turns
      // we have to wait for. Driver state owns the per-turnId
      // mapping; renderer just shows "queued · N ahead" until the
      // matching user-message event arrives.
      kind: 'turn-queued';
      turnId: string;
      ahead: number;
    }
  | {
      // Project focus change broadcast (HTTP-route initiated). MCP-routed
      // agent project_focus tool calls don't reach SSE — clients catch
      // those up via fetch on next chat:final.
      kind: 'project';
      from: string | null;
      to: string | null;
      via: 'tool' | 'slash_command';
    };
