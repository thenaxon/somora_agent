// HTTP client for the somora server. Keeps fetch-shaped code out of
// components — they just await these.

import type {
  AgentInfo,
  ModelInfo,
  ResetResult,
  SessionModelInfo,
  SessionSummary,
  SessionThinkingInfo,
  ThinkingLevel,
  TuiConfig,
} from './types.ts';

export class Api {
  constructor(private readonly base: string) {}

  async fetchAgents(): Promise<AgentInfo[]> {
    const res = await fetch(`${this.base}/agents`);
    return (await res.json()) as AgentInfo[];
  }

  async fetchTuiConfig(): Promise<TuiConfig> {
    const res = await fetch(`${this.base}/tui-config`);
    if (!res.ok) throw new Error(`tui-config ${res.status}`);
    return (await res.json()) as TuiConfig;
  }

  async fetchSessions(agent: string): Promise<SessionSummary[]> {
    const res = await fetch(`${this.base}/agents/${encodeURIComponent(agent)}/sessions`);
    if (!res.ok) return [];
    return (await res.json()) as SessionSummary[];
  }

  async createSession(agent: string, slug: string): Promise<string> {
    const res = await fetch(`${this.base}/agents/${encodeURIComponent(agent)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  async resetSession(agent: string, session: string): Promise<ResetResult> {
    const res = await fetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/reset`,
      { method: 'POST' },
    );
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as ResetResult;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    const res = await fetch(`${this.base}/models`);
    if (!res.ok) return [];
    return (await res.json()) as ModelInfo[];
  }

  async fetchSessionModel(agent: string, session: string): Promise<SessionModelInfo | null> {
    const res = await fetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
    );
    if (!res.ok) return null;
    return (await res.json()) as SessionModelInfo;
  }

  async setSessionModel(agent: string, session: string, ref: string): Promise<void> {
    const res = await fetch(
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
    const res = await fetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/model`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async fetchSessionThinking(agent: string, session: string): Promise<SessionThinkingInfo | null> {
    const res = await fetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`,
    );
    if (!res.ok) return null;
    return (await res.json()) as SessionThinkingInfo;
  }

  async setSessionThinking(agent: string, session: string, level: ThinkingLevel): Promise<void> {
    const res = await fetch(
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
    const res = await fetch(
      `${this.base}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/thinking`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error(await res.text());
  }

  async send(agent: string, session: string, text: string): Promise<void> {
    const res = await fetch(`${this.base}/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, session, text }),
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  }

  streamUrl(agent: string, session: string): string {
    return `${this.base}/chat/stream?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}`;
  }
}
