// HTTP client for the somora server. Keeps fetch-shaped code out of
// components — they just await these.
//
// Uses loopbackFetch (undici dispatcher with no headers/body timeout)
// because the TUI client polls and posts into the same somora server
// over loopback, and several routes (`/chat/send-sync`, `/chat/history`
// when long, `send` during a long turn) can legitimately keep the
// connection idle for many minutes. With plain fetch undici would kill
// these at 5 minutes once HTTPS is the transport.

import { loopbackFetch } from '../../server/loopback-fetch.ts';
import type {
  AgentInfo,
  ModelInfo,
  ProjectEntityInfo,
  ProjectInfo,
  ResetResult,
  SamplingPatch,
  SessionModelInfo,
  SessionProjectInfo,
  SessionSamplingInfo,
  SessionSummary,
  SessionThinkingInfo,
  ThinkingLevel,
  TuiConfig,
} from './types.ts';

export class Api {
  constructor(private readonly base: string) {}

  async fetchAgents(): Promise<AgentInfo[]> {
    const res = await loopbackFetch(`${this.base}/agents`);
    return (await res.json()) as AgentInfo[];
  }

  async fetchTuiConfig(): Promise<TuiConfig> {
    const res = await loopbackFetch(`${this.base}/tui-config`);
    if (!res.ok) throw new Error(`tui-config ${res.status}`);
    return (await res.json()) as TuiConfig;
  }

  async fetchSystemPrompt(agent: string): Promise<string | null> {
    const res = await loopbackFetch(`${this.base}/agents/${encodeURIComponent(agent)}/system-prompt`);
    if (!res.ok) return null;
    const data = (await res.json()) as { systemPrompt?: string };
    return typeof data.systemPrompt === 'string' ? data.systemPrompt : null;
  }

  async fetchLoopState(): Promise<{ active: boolean; agent?: string; dreamId?: string } | null> {
    try {
      const res = await loopbackFetch(`${this.base}/dream/loop-state`);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        active?: boolean;
        agent?: string;
        dreamId?: string;
      };
      return data && typeof data.active === 'boolean'
        ? {
            active: data.active,
            ...(data.agent ? { agent: data.agent } : {}),
            ...(data.dreamId ? { dreamId: data.dreamId } : {}),
          }
        : null;
    } catch {
      return null;
    }
  }

  async fetchSessions(agent: string): Promise<SessionSummary[]> {
    const res = await loopbackFetch(`${this.base}/agents/${encodeURIComponent(agent)}/sessions`);
    if (!res.ok) return [];
    return (await res.json()) as SessionSummary[];
  }

  async createSession(agent: string, slug: string): Promise<string> {
    const res = await loopbackFetch(`${this.base}/agents/${encodeURIComponent(agent)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  async resetSession(agent: string, session: string): Promise<ResetResult> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/reset`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ResetResult;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    const res = await loopbackFetch(`${this.base}/models`);
    if (!res.ok) return [];
    return (await res.json()) as ModelInfo[];
  }

  async fetchSessionModel(agent: string, session: string): Promise<SessionModelInfo | null> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
    );
    if (!res.ok) return null;
    return (await res.json()) as SessionModelInfo;
  }

  async setSessionModel(agent: string, session: string, ref: string): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ref }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async clearSessionModel(agent: string, session: string): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async fetchSessionThinking(agent: string, session: string): Promise<SessionThinkingInfo | null> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`,
    );
    if (!res.ok) return null;
    return (await res.json()) as SessionThinkingInfo;
  }

  async setSessionThinking(agent: string, session: string, level: ThinkingLevel): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async clearSessionThinking(agent: string, session: string): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async fetchSessionSampling(agent: string, session: string): Promise<SessionSamplingInfo | null> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/sampling`,
    );
    if (!res.ok) return null;
    return (await res.json()) as SessionSamplingInfo;
  }

  /** PUT merges into the existing override; a key set to null removes it. */
  async setSessionSampling(agent: string, session: string, patch: SamplingPatch): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/sampling`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  /** DELETE clears the whole session override. */
  async clearSessionSampling(agent: string, session: string): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/sampling`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async reloadConfig(): Promise<{ ok: boolean; changed?: string[]; restartRequired?: string[]; error?: string }> {
    const res = await loopbackFetch(`${this.base}/config/reload`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; changed?: string[]; restartRequired?: string[]; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `reload ${res.status}` };
    return { ok: true, changed: body.changed ?? [], restartRequired: body.restartRequired ?? [] };
  }

  async restartServer(): Promise<{ ok: boolean; error?: string; expectedDowntimeSeconds?: number }> {
    const res = await loopbackFetch(`${this.base}/server/restart`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; expectedDowntimeSeconds?: number };
    if (!res.ok) return { ok: false, error: body.error ?? `restart ${res.status}` };
    return { ok: true, expectedDowntimeSeconds: body.expectedDowntimeSeconds };
  }

  async send(agent: string, session: string, text: string): Promise<{ turnId: string }> {
    const res = await loopbackFetch(`${this.base}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, session, text }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    // turnId is echoed by the server so the TUI can pair the
    // pending-queued entry it just created with later SSE events
    // (turn_queued, user_message). Older servers don't return it —
    // empty string means no queue indicator possible (but the turn
    // still runs fine).
    const body = (await res.json().catch(() => ({}))) as { turnId?: string };
    return { turnId: typeof body.turnId === 'string' ? body.turnId : '' };
  }

  streamUrl(agent: string, session: string): string {
    return `${this.base}/chat/stream?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`;
  }

  activityStreamUrl(): string {
    return `${this.base}/activity/stream`;
  }

  /** Mark a session "seen" — the user is looking at this (agent,
   *  session) right now. Server clamps to max(currentSeenAt, ts) and
   *  broadcasts to sibling clients so their unread badges clear too. */
  async markSeen(agent: string, session: string): Promise<void> {
    try {
      await loopbackFetch(
        `${this.base}/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(session)}/seen`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
    } catch {
      /* network blip — next focus will retry */
    }
  }

  /**
   * Pull historical events for a session — used to repopulate the
   * scrollback when the TUI opens or switches to a session that
   * already has history. Returns the raw NormalizedEvent shape from
   * the JSONL; the TUI side filters + maps to its own Turn type.
   */
  async fetchHistory(
    agent: string,
    session: string,
  ): Promise<{ events: HistoryEvent[] }> {
    const res = await loopbackFetch(
      `${this.base}/chat/history?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
    );
    if (!res.ok) return { events: [] };
    return (await res.json()) as { agent: string; session: string; events: HistoryEvent[] };
  }

  /**
   * Tell the server to abort the in-flight chat turn for this
   * (agent, session). No-op if no turn is running.
   */
  async abortTurn(agent: string, session: string): Promise<void> {
    await loopbackFetch(
      `${this.base}/chat/abort?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`,
      { method: 'POST' },
    ).catch(() => {
      /* best-effort — UI shouldn't error on abort */
    });
  }

  /** Feature-flag probe for the projects feature. Always 200; clients
   *  use this at boot to decide whether to register the /projekt slash
   *  commands and render the project chip. */
  async fetchProjectsEnabled(): Promise<boolean> {
    try {
      const res = await loopbackFetch(`${this.base}/projects/feature`);
      if (!res.ok) return false;
      const data = (await res.json()) as { enabled?: boolean };
      return Boolean(data.enabled);
    } catch {
      return false;
    }
  }

  /** Phase Projects v1 — read controlled-vocab entity list. Returns []
   *  when projects.enabled is false (server returns 503 → treat as
   *  feature-off, no error). */
  async fetchProjectEntities(): Promise<ProjectEntityInfo[]> {
    const res = await loopbackFetch(`${this.base}/projects/entities`);
    if (!res.ok) return [];
    const data = (await res.json()) as { entities?: ProjectEntityInfo[] };
    return data.entities ?? [];
  }

  /** List all (non-archived by default) projects. Empty when projects
   *  feature is off. */
  async fetchProjects(includeArchived = false): Promise<ProjectInfo[]> {
    const url = includeArchived
      ? `${this.base}/projects?includeArchived=true`
      : `${this.base}/projects`;
    const res = await loopbackFetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { projects?: ProjectInfo[] };
    return data.projects ?? [];
  }

  /** Fetch current project focus for a session. Returns slug=null when
   *  nothing is pinned OR when the feature is disabled. */
  async fetchSessionProject(agent: string, session: string): Promise<SessionProjectInfo> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/project`,
    );
    if (!res.ok) return { slug: null, project: null };
    const data = (await res.json()) as {
      slug?: string | null;
      project?: ProjectInfo | null;
    };
    return {
      slug: data.slug ?? null,
      project: data.project ?? null,
    };
  }

  /** Pin a project to a session. */
  async setSessionProject(agent: string, session: string, slug: string): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/project`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  /** Clear the pinned project for a session. */
  async clearSessionProject(agent: string, session: string): Promise<void> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/project`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  /**
   * Fetch a session export as text. Server picks the renderer based on
   * `format` and sends back the full document body (markdown or
   * JSONL). The TUI persists this to a local file — there's no
   * progress reporting; sessions are small (single-digit MBs at
   * extreme), the HTTP response arrives in one go.
   */
  async exportSession(
    agent: string,
    session: string,
    format: 'json' | 'markdown',
  ): Promise<string> {
    const res = await loopbackFetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/export?format=${format}`,
    );
    if (!res.ok) throw new Error(`export failed: ${res.status} ${await res.text()}`);
    return await res.text();
  }
}

/**
 * Subset of the NormalizedEvent shape the history endpoint serves.
 * We don't import the server's full type — that pulls in too much
 * server-side dep tree into the CLI bundle. Just declare what the
 * TUI actually reads from history.
 */
export interface HistoryEvent {
  kind: string;
  ts: number;
  text?: string;
  from_agent?: string;
  from_system?: 'sentinel' | 'tmux' | 'subagent';
  agent_ask_call_id?: string;
  // tool_call / tool_result
  callId?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  // engine_meta
  engine?: string;
  itemType?: string;
  payload?: unknown;
}
