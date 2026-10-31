// The builder panel on the phone (docs/mobile.md "Builder panel"): the
// whole GET /agents/:agent/sessions/:session/builder answer, read when
// a builder session opens, every 5 s while a turn runs and every 2 s
// while the sheet is open, plus the calls behind its switches and
// buttons. Thin client: the server holds the state; a change is sent
// and then read back.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface BuilderPanelTodo {
  content: string;
  status: string;
}

export interface BuilderPanelAcceptanceItem {
  id: string;
  requirement: string;
  status: 'open' | 'passed' | 'failed' | 'not_run' | string;
  evidence?: string;
  review?: { verdict: 'accepted' | 'rejected' | string; by: string; note?: string };
}

export interface BuilderPanelData {
  state: { mode: 'attended' | 'unattended'; phase: 'plan' | 'build'; planPath?: string | null; todos: BuilderPanelTodo[] } | null;
  acceptance: { items: BuilderPanelAcceptanceItem[]; required: boolean };
  writeAllow: string[];
  question: { questionId: string; question: string } | null;
  turn: { startedAt: number; toolCalls: number; lastTool?: string; lastToolAt?: number } | null;
}

const POLL_MS = 2000;
const LIVE_POLL_MS = 5000;

function base(agent: string, session: string): string {
  return `/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}`;
}

async function send(url: string, method: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(d.error ?? `HTTP ${res.status}`);
  }
}

export function useBuilderPanel(agent: string | null, session: string, isBuilder: boolean, open: boolean, live: boolean) {
  const [data, setData] = useState<BuilderPanelData | null>(null);
  const keyRef = useRef('');

  const refresh = useCallback(() => {
    if (!agent) return;
    const key = `${agent}\u0000${session}`;
    keyRef.current = key;
    void fetch(`${base(agent, session)}/builder`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
      .then((d) => {
        if (!d || keyRef.current !== key) return;
        const acc = (d.acceptance ?? {}) as { items?: unknown; required?: unknown };
        const state = d.state as BuilderPanelData['state'] | undefined;
        setData({
          state: state ? { ...state, todos: Array.isArray(state.todos) ? state.todos : [] } : null,
          acceptance: { items: Array.isArray(acc.items) ? (acc.items as BuilderPanelAcceptanceItem[]) : [], required: acc.required === true },
          writeAllow: Array.isArray(d.writeAllow) ? (d.writeAllow as string[]) : [],
          question: (d.question as BuilderPanelData['question']) ?? null,
          turn: (d.turn as BuilderPanelData['turn']) ?? null,
        });
      })
      .catch(() => undefined);
  }, [agent, session]);

  useEffect(() => {
    setData(null);
  }, [agent, session]);

  // Once per builder session and every 5 s while a turn runs, for the
  // header count; every 2 s while the sheet is open.
  useEffect(() => {
    if (!isBuilder) return;
    refresh();
    if (!live || open) return;
    const t = setInterval(refresh, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [isBuilder, live, open, refresh]);

  useEffect(() => {
    if (!open || !isBuilder) return;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [open, isBuilder, refresh]);

  const actions = {
    patch: (p: { mode?: 'attended' | 'unattended'; phase?: 'plan' | 'build'; acceptanceRequired?: boolean }) =>
      send(`${base(agent!, session)}/builder`, 'PATCH', p),
    go: () => send(`${base(agent!, session)}/builder/go`, 'POST', {}),
    review: (id: string, verdict: 'accepted' | 'rejected', note?: string) =>
      send(`${base(agent!, session)}/acceptance/review`, 'POST', { id, verdict, ...(note ? { note } : {}) }),
  };
  return { data, refresh, actions };
}
