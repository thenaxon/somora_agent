// Shared types between Ink components and the network layer.
// Kept in plain .ts so non-React code (api.ts, stream.ts) can import them
// without dragging React into modules that don't need it.

export interface TurnStats {
  tokensIn: number;
  tokensInCached: number | null;
  tokensOut: number;
  contextWindow: number | null;
  provider: string | null;
  model: string | null;
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

// All Turn-kinds that the scrollback can render. Kept flat (discriminated
// union) so React reducers don't need a class hierarchy.
export type Turn =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      phase: 'call' | 'result' | 'error';
      input?: string;
      output?: string;
      error?: string;
    }
  | {
      kind: 'memory';
      id: string;
      count: number;
      topScore: number | null;
      refs: string[];
    }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'warn' | 'error' };

// Server-Sent Events from /chat/stream, normalized.
export type StreamEvent =
  | { kind: 'connected' }
  | { kind: 'agent-start' }
  | { kind: 'agent-end'; usage?: { tokens_in?: number; tokens_in_cached?: number; tokens_out?: number }; contextWindow?: number; provider?: string; model?: string }
  | { kind: 'chat-delta'; text: string }
  | { kind: 'chat-final'; text: string }
  | { kind: 'memory'; count: number; topScore: number | null; refs: string[] }
  | {
      kind: 'tool';
      tool: string;
      phase: 'call' | 'result' | 'error' | string;
      input?: unknown;
      output?: unknown;
      error?: string;
    };
