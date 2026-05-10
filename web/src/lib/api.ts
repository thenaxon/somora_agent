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

export interface ModelOption {
  provider: string;
  id: string;
  alias: string | null;
  engine: string;
  contextWindow: number;
  capabilities: string[];
  /** Stable ref for `/model <ref>` — alias if present, else provider/id. */
  ref: string;
}

/** Server's response from POST /attachments — refs the client then
 *  passes back to /chat/send under `attachments[]`. Bytes never travel
 *  again; the server resolves the hash → on-disk path. */
export interface AttachmentRef {
  hash: string;
  name: string;
  mime: string;
  kind: 'image' | 'pdf' | 'text';
  size: number;
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
  attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
}

export interface HistoryResponse {
  events: HistoryEvent[];
  /** Server-paginated lazy-load (Phase 1 web): when present, more
   *  older events exist beyond the slice returned. Client passes
   *  `before=oldestTs` on the next call to walk back. Older callers
   *  that didn't request paging see this absent or `false`. */
  hasMore?: boolean;
  /** Timestamp of the oldest event in this slice. Pass as `before`
   *  on the next call to fetch the previous page. */
  oldestTs?: number;
}

export const api = {
  agents: () => getJson<AgentInfo[]>('/agents'),
  sessions: (agent: string) =>
    getJson<SessionSummary[]>(`/agents/${encodeURIComponent(agent)}/sessions`),
  loopState: () => getJson<LoopState>('/dream/loop-state'),
  models: () => getJson<ModelOption[]>('/models'),
  sessionModel: (agent: string, session: string) =>
    getJson<SessionModelInfo>(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
    ),
  setSessionModel: async (agent: string, session: string, model: string): Promise<void> => {
    const res = await fetch(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`set-model ${res.status}: ${body.slice(0, 200)}`);
    }
  },
  createSession: async (agent: string, slug: string): Promise<{ id: string; slug: string }> => {
    const res = await fetch(`/agents/${encodeURIComponent(agent)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`create-session ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as { id: string; slug: string };
  },
  sessionThinking: (agent: string, session: string) =>
    getJson<SessionThinkingInfo>(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`,
    ),
  setSessionThinking: async (
    agent: string,
    session: string,
    level: 'off' | 'low' | 'medium' | 'high' | 'default',
  ): Promise<void> => {
    // 'default' isn't a real value — it removes the override and falls
    // back to persona / engine default. The server expresses that as
    // DELETE; PUT is for the explicit levels only.
    const url = `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`;
    const res =
      level === 'default'
        ? await fetch(url, { method: 'DELETE' })
        : await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ level }),
          });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`set-thinking ${res.status}: ${body.slice(0, 200)}`);
    }
  },
  history: (
    agent: string,
    session: string,
    opts?: { limit?: number; before?: number },
  ) => {
    const params = new URLSearchParams({ agent, session });
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.before !== undefined) params.set('before', String(opts.before));
    return getJson<HistoryResponse>(`/chat/history?${params.toString()}`);
  },
  send: async (
    agent: string,
    session: string,
    text: string,
    attachments?: AttachmentRef[],
  ): Promise<void> => {
    const res = await fetch('/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent,
        session,
        text,
        ...(attachments && attachments.length > 0
          ? {
              attachments: attachments.map(({ hash, name, mime, size }) => ({
                hash,
                name,
                mime,
                size,
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`chat/send ${res.status}: ${body.slice(0, 200)}`);
    }
  },
  uploadAttachment: async (file: File): Promise<AttachmentRef> => {
    // Stream raw bytes — multipart parsing on the server pulls
    // everything into RAM and would cap us at the body-size limit;
    // raw-body keeps the streaming-cap behaviour. Filename rides via
    // X-Somora-Filename header since raw bodies have no envelope.
    const res = await fetch('/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Somora-Filename': encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body) as { error?: string };
        if (parsed.error) msg = parsed.error;
      } catch {
        /* not JSON, keep raw */
      }
      throw new Error(`attachments ${res.status}: ${msg}`);
    }
    return (await res.json()) as AttachmentRef;
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
