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
  /** Currently-pinned project slug, if any (Phase Projects v1). */
  projectSlug?: string;
}

// ─── Projects (Phase Projects v1) ────────────────────────────────────

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
  archivedAt?: string;
  archiveReason?: string;
  created: string;
  updated: string;
  expires?: string | null;
}

export interface SessionProjectResponse {
  agent: string;
  session: string;
  slug: string | null;
  project: ProjectInfo | null;
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

/** A single live tmux session as the web tmux-app list-view consumes
 *  it. Joined server-side with somora's origin store, so `origin` is
 *  set when we know who created the session and absent otherwise
 *  ("orphan" — created from a host shell). */
export interface TmuxSessionInfo {
  name: string;
  windows: number;
  activeCommand: string | null;
  activeTitle: string | null;
  createdEpoch: number | null;
  lastActivityEpoch: number | null;
  origin?: {
    name: string;
    agent: string;
    session?: string;
    createdAt: string;
  };
}

export interface LoopState {
  active: boolean;
  agent?: string;
  dreamId?: string;
  startedAt?: string;
  lastActivityAt?: string;
}

export interface DreamStates {
  rem: Record<string, { active: boolean; pendingCount: number }>;
  deep: { active: boolean };
  lucid: { active: boolean; loopHolder?: string };
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

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
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
  version: () => getJson<{ version: string }>('/version'),
  agents: () => getJson<AgentInfo[]>('/agents'),
  tmuxSessions: () =>
    getJson<{ sessions: TmuxSessionInfo[] }>('/tmux/sessions').then((r) => r.sessions),
  sessions: (agent: string) =>
    getJson<SessionSummary[]>(`/agents/${encodeURIComponent(agent)}/sessions`),
  loopState: () => getJson<LoopState>('/dream/loop-state'),
  dreamStates: () => getJson<DreamStates>('/dream-states'),
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
  resetSession: async (
    agent: string,
    session: string,
  ): Promise<{ archivedId: string | null }> => {
    const res = await fetch(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/reset`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`reset ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as { archivedId: string | null };
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
    opts?: { limit?: number; before?: number; signal?: AbortSignal },
  ) => {
    const params = new URLSearchParams({ agent, session });
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.before !== undefined) params.set('before', String(opts.before));
    return getJson<HistoryResponse>(
      `/chat/history?${params.toString()}`,
      opts?.signal ? { signal: opts.signal } : undefined,
    );
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
  /** Cross-agent sessions list. Powers the web Sessions tool. */
  globalSessions: (opts?: { includeArchived?: boolean; signal?: AbortSignal }) => {
    const qs = opts?.includeArchived ? '?include_archived=true' : '';
    return getJson<{ sessions: GlobalSessionRow[] }>(
      `/sessions${qs}`,
      opts?.signal ? { signal: opts.signal } : undefined,
    ).then((r) => r.sessions);
  },
  archiveSession: async (agent: string, session: string, reason?: string): Promise<void> => {
    const res = await fetch(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/archive`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`archive ${res.status}: ${body.slice(0, 200)}`);
    }
  },
  unarchiveSession: async (agent: string, session: string): Promise<void> => {
    const res = await fetch(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/unarchive`,
      { method: 'POST' },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`unarchive ${res.status}: ${body.slice(0, 200)}`);
    }
  },

  // ─── Projects ──────────────────────────────────────────────────────

  /** Read the curated entity vocabulary from config. Empty array when
   *  projects.enabled is false on the server (we treat 503 as "feature
   *  off" rather than an error). */
  projectEntities: async (): Promise<ProjectEntityInfo[]> => {
    const res = await fetch('/projects/entities');
    if (!res.ok) return [];
    const data = (await res.json()) as { entities?: ProjectEntityInfo[] };
    return data.entities ?? [];
  },

  /** List configured projects. Includes archived only when explicitly
   *  asked. Empty array when feature is off. */
  projects: async (includeArchived = false): Promise<ProjectInfo[]> => {
    const url = includeArchived ? '/projects?includeArchived=true' : '/projects';
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { projects?: ProjectInfo[] };
    return data.projects ?? [];
  },

  /** Read the current focus for a session. Returns slug=null when no
   *  pin is set OR when the feature is disabled. */
  sessionProject: async (agent: string, session: string): Promise<SessionProjectResponse> => {
    const res = await fetch(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/project`,
    );
    if (!res.ok) {
      return { agent, session, slug: null, project: null };
    }
    return (await res.json()) as SessionProjectResponse;
  },

  /** Pin a project to a session. */
  setSessionProject: async (agent: string, session: string, slug: string): Promise<void> => {
    const res = await fetch(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/project`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`set-project ${res.status}: ${body.slice(0, 200)}`);
    }
  },

  /** Clear a session's pinned project. */
  clearSessionProject: async (agent: string, session: string): Promise<void> => {
    const res = await fetch(
      `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/project`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`clear-project ${res.status}: ${body.slice(0, 200)}`);
    }
  },
} as const;

/** Row shape returned by GET /sessions (cross-agent). The web Sessions
 *  tool consumes this directly; per-agent endpoints still return the
 *  thinner SessionSummary shape for backward compat. */
export interface GlobalSessionRow {
  agent: string;
  agentColor?: string;
  agentIcon?: string;
  sessionId: string;
  slug: string;
  isMain: boolean;
  isArchived: boolean;
  createdAt: string | null;
  lastActivity: string | null;
  messageCount: number;
  byteSize: number;
  engine?: string;
  liveSubscribers: number;
  dream: {
    status: 'dreamed' | 'partial' | 'never';
    coverageTs: number | null;
    lagEvents: number;
  };
  archivedAt?: string;
  archiveReason?: string;
  /** Currently-pinned project slug (Phase Projects v1). */
  projectSlug?: string;
}
