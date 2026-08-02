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
  from_system?: 'sentinel' | 'tmux';
  attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
  /** Set on `kind: 'assistant_audio'` history rows. Tracks the
   *  generated TTS artifact so the client can re-render a Play-button
   *  for past turns on history load. */
  audio?: { url: string; mime: string; durationMs?: number; cacheKey: string };
  /** Set on `kind: 'engine_meta'` history rows. itemType is the raw
   *  engine-emitted label (e.g. 'todo_list'); payload is opaque. */
  itemType?: string;
  payload?: unknown;
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
  hostStats: () =>
    getJson<{
      cpu: { loadAvg1: number; cores: number; percent: number };
      mem: { totalBytes: number; availableBytes: number; usedBytes: number; percent: number };
    }>('/host-stats'),
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
    voice?: { inputModality?: 'voice'; autoPlayRequested?: boolean; sttProvider?: string },
  ): Promise<{ turnId: string }> => {
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
        ...(voice?.inputModality === 'voice' ? { input_modality: 'voice' as const } : {}),
        ...(voice?.sttProvider ? { stt_provider: voice.sttProvider } : {}),
        ...(voice?.autoPlayRequested ? { auto_play_requested: true } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`chat/send ${res.status}: ${body.slice(0, 200)}`);
    }
    // turnId is echoed by the server so the caller can tag its
    // optimistic user-bubble for matching with future SSE events
    // (turn_queued, user_message). Older servers don't return it —
    // empty string is the safe fallback (no queue indicator possible).
    const body = (await res.json().catch(() => ({}))) as { turnId?: string };
    return { turnId: typeof body.turnId === 'string' ? body.turnId : '' };
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
  /** Cancel in-flight turn. Returns server body so the UI can surface
   *  `aborted:false` (nothing running) instead of silently no-oping.
   *  Throws on network / non-2xx so callers can toast the failure. */
  abort: async (
    agent: string,
    session: string,
  ): Promise<{ aborted: boolean; ms_running?: number; agent?: string; session?: string }> => {
    let res: Response;
    try {
      res = await fetch(
        `/chat/abort?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
        { method: 'POST' },
      );
    } catch (err) {
      throw new Error(
        `abort request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`abort ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return (await res.json()) as {
      aborted: boolean;
      ms_running?: number;
      agent?: string;
      session?: string;
    };
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
  /** Build the URL for /export with the chosen format. Used by
   *  SessionsWindow's <a download> buttons — the browser triggers the
   *  file save based on the server's Content-Disposition header. */
  sessionExportUrl: (agent: string, session: string, format: 'json' | 'markdown'): string =>
    `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/export?format=${format}`,

  // ─── Projects ──────────────────────────────────────────────────────

  /** Feature-flag probe — always 200, no ambiguity. Clients use this
   *  at boot to decide whether to render project UI (chip, sessions
   *  column, slash commands). */
  projectsFeature: async (): Promise<{ enabled: boolean; entityCount: number }> => {
    try {
      const res = await fetch('/projects/feature');
      if (!res.ok) return { enabled: false, entityCount: 0 };
      return (await res.json()) as { enabled: boolean; entityCount: number };
    } catch {
      return { enabled: false, entityCount: 0 };
    }
  },

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
  // ── Sentinel ────────────────────────────────────────────────────
  sentinelList: (opts?: { owner?: string; status?: string }) => {
    const q = new URLSearchParams();
    if (opts?.owner) q.set('owner', opts.owner);
    if (opts?.status) q.set('status', opts.status);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    return getJson<{ count: number; triggers: SentinelTrigger[] }>(
      `/sentinel/triggers${suffix}`,
    );
  },
  sentinelGet: (id: string) =>
    getJson<{ trigger: SentinelTrigger }>(
      `/sentinel/triggers/${encodeURIComponent(id)}`,
    ).then((r) => r.trigger),
  sentinelHistory: (id: string, limit: number = 50) =>
    getJson<{ count: number; entries: SentinelFireEntry[] }>(
      `/sentinel/triggers/${encodeURIComponent(id)}/history?limit=${limit}`,
    ).then((r) => r.entries),
  sentinelPause: async (id: string): Promise<void> => {
    const res = await fetch(`/sentinel/triggers/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`sentinel pause ${res.status}`);
  },
  sentinelResume: async (id: string): Promise<void> => {
    const res = await fetch(`/sentinel/triggers/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`sentinel resume ${res.status}`);
  },
  sentinelDelete: async (id: string): Promise<void> => {
    const res = await fetch(`/sentinel/triggers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`sentinel delete ${res.status}`);
  },
  sentinelTest: async (id: string): Promise<void> => {
    const res = await fetch(`/sentinel/triggers/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`sentinel test ${res.status}`);
  },

  // ─── Wiki explorer (read-only) ─────────────────────────────────────
  wikiStatus: () => getJson<{ enabled: boolean; root?: string }>('/wiki/status'),
  wikiTree: () => getJson<WikiTreeResponse>('/wiki/tree'),
  wikiPage: (slug: string) => getJson<WikiPageResponse>(`/wiki/page?slug=${encodeURIComponent(slug)}`),
  wikiGraph: (scope: 'local' | 'global', slug?: string) =>
    getJson<WikiGraphResponse>(
      scope === 'global'
        ? '/wiki/graph?scope=global'
        : `/wiki/graph?scope=local&slug=${encodeURIComponent(slug ?? '')}`,
    ),
  wikiRefresh: async (): Promise<void> => {
    const res = await fetch('/wiki/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(`wiki refresh ${res.status}`);
  },
} as const;

// ─── Wiki types — mirror src/wiki/explorer.ts ────────────────────────

export interface WikiTreeDir {
  type: 'dir';
  name: string;
  path: string;
  children: WikiTreeNode[];
}

export interface WikiTreePage {
  type: 'page';
  name: string;
  slug: string;
  title: string;
  description: string;
  mtimeMs: number;
}

export type WikiTreeNode = WikiTreeDir | WikiTreePage;

export interface WikiTreeResponse {
  root: string;
  pages: number;
  builtAt: number;
  nodes: WikiTreeNode[];
}

export interface WikiPageRef {
  slug: string;
  title: string;
}

export interface WikiPageResponse {
  slug: string;
  title: string;
  folder: string;
  mtimeMs: number;
  /** Body only — the YAML block is parsed off and returned separately,
   *  or a markdown renderer turns `---` into a rule with YAML spilled
   *  underneath as prose. */
  markdown: string;
  frontmatter: Record<string, unknown>;
  links: WikiPageRef[];
  /** Link targets in the body that match no page. Rendered as broken. */
  unresolved: string[];
  backlinks: WikiPageRef[];
  /** Raw `[[target]]` string → resolved slug, or null when unresolvable.
   *  Resolution lives on the server so Obsidian's matching rules exist
   *  in exactly one place. */
  linkTargets: Record<string, string | null>;
}

export interface WikiGraphNode {
  id: string;
  label: string;
  folder: string;
  degree: number;
}

export interface WikiGraphEdge {
  from: string;
  to: string;
  type: 'wikilink' | 'related';
}

export interface WikiGraphResponse {
  scope: 'local' | 'global';
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  truncated: boolean;
}

// Sentinel types — kept in sync with src/sentinel/types.ts on the server.
export interface SentinelTrigger {
  id: string;
  name: string;
  intent?: string;
  ownerAgent: string;
  source: {
    type: 'time';
    spec:
      | { type: 'at'; iso: string }
      | { type: 'every'; interval: string }
      | { type: 'daily'; time: string }
      | { type: 'weekly'; day: string; time: string }
      | { type: 'cron'; expression: string };
  };
  evaluator: { type: 'none' };
  dispatch: { agent: string; session: string; prompt: string };
  policy?: { cooldownMs?: number; maxFiresPerDay?: number };
  createdAt: string;
  status: 'active' | 'paused' | 'error' | 'completed';
  statusReason?: string;
  fireCount: number;
  lastFireAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  errorStreak: number;
  nextFireAt?: string;
}

export interface SentinelFireEntry {
  firedAt: string;
  scheduledFor: string;
  outcome: 'success' | 'error' | 'skipped';
  skipReason?: string;
  error?: string;
  taskId?: string;
  catchUp?: boolean;
  testMode?: boolean;
}

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
  /** ISO timestamp of the latest unread-candidate event (A2A in,
   *  sentinel in, assistant final). Null if none. Compare with
   *  `seenAt` to decide whether to show an unread badge. */
  unreadAt?: string | null;
  /** ISO timestamp when any client last opened this session. */
  seenAt?: string | null;
}
