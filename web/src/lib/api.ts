// Typed wrapper around the somora HTTP server. Routes mirror what
// the existing TUI (src/cli/tui/api.ts) consumes — same backend,
// different client surface.
//
// All calls go to relative paths so they work both in dev (Vite
// proxy → :18737) and in production (same-origin under :18737/web).

export interface AgentInfo {
  name: string;
  description: string;
  icon?: string;
  /** Per-agent display color, hex string. May be unset on older
   *  servers or older AGENTS.md frontmatter — UI falls back to a
   *  deterministic palette by name. */
  color?: string;
  /** Optional short role-tag shown under the agent name in the dock
   *  ("Orchestrator", "Coder", "Researcher" etc.). Falls back to
   *  the literal "agent" when unset. */
  role?: string;
}

export interface SessionSummary {
  id: string;
  slug: string;
  isMain: boolean;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
}

export interface LoopState {
  active: boolean;
  agent?: string;
  dreamId?: string;
  startedAt?: string;
  lastActivityAt?: string;
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

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface SessionThinkingInfo {
  effective: ThinkingLevel | null;
  override: ThinkingLevel | null;
  personaDefault: ThinkingLevel | null;
  source: 'session-override' | 'persona-default' | 'engine-default';
  modelSupportsReasoning: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface HistoryEvent {
  kind: string;
  ts: number;
  engine?: string;
  text?: string;
  callId?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  turnId?: string;
  usage?: {
    tokens_in?: number;
    tokens_in_cached?: number;
    tokens_out?: number;
    tokens_out_reasoning?: number;
  };
  ephemeral?: string;
  from_agent?: string;
}

export interface HistoryResponse {
  events: HistoryEvent[];
}

export const api = {
  agents: () => getJson<AgentInfo[]>('/agents'),
  sessions: (agent: string) =>
    getJson<SessionSummary[]>(`/agents/${encodeURIComponent(agent)}/sessions`),
  loopState: () => getJson<LoopState>('/dream/loop-state'),
  sessionModel: (agent: string, session: string) =>
    getJson<SessionModelInfo>(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
    ),
  sessionThinking: (agent: string, session: string) =>
    getJson<SessionThinkingInfo>(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`,
    ),
  history: (agent: string, session: string) =>
    getJson<HistoryResponse>(
      `/chat/history?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
    ),
  send: async (agent: string, session: string, text: string): Promise<void> => {
    const res = await fetch('/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, session, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`chat/send ${res.status}: ${body.slice(0, 200)}`);
    }
  },
  abort: async (agent: string, session: string): Promise<void> => {
    await fetch(
      `/chat/abort?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
      { method: 'POST' },
    ).catch(() => {
      // best-effort — the UI shouldn't break on abort failure.
    });
  },
  streamUrl: (agent: string, session: string) =>
    `/chat/stream?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
} as const;
