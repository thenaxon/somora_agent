// A builder session's task list, acceptance list and running turn, read
// from GET /agents/:agent/sessions/:session/builder for the activity
// block (docs/mobile.md "Tool activity"). Read once when the session
// opens and every few seconds while a turn runs, so the count, the
// current task and "running for" stay current even when the phone
// joined the turn late and saw only part of its calls.

import { useEffect, useRef, useState } from 'react';

export interface BuilderTodo {
  content: string;
  status: string;
}

export interface BuilderAcceptanceItem {
  id: string;
  requirement: string;
  status: string;
  review?: { verdict: string };
}

export interface BuilderTurnInfo {
  todos: BuilderTodo[];
  acceptance: BuilderAcceptanceItem[];
  /** The running turn, null when none runs. */
  turn: { startedAt: number; toolCalls: number; lastTool?: string; lastToolAt?: number } | null;
}

const LIVE_POLL_MS = 5000;

export function useBuilderTurn(agent: string | null, session: string, isBuilder: boolean, live: boolean): BuilderTurnInfo | null {
  const [info, setInfo] = useState<BuilderTurnInfo | null>(null);
  const keyRef = useRef('');

  useEffect(() => {
    setInfo(null);
  }, [agent, session]);

  useEffect(() => {
    if (!agent || !isBuilder) return;
    const key = `${agent}\u0000${session}`;
    keyRef.current = key;
    let alive = true;
    const read = () =>
      fetch(`/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/builder`)
        .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : null))
        .then((d) => {
          if (!alive || !d || keyRef.current !== key) return;
          const state = (d.state ?? {}) as { todos?: unknown };
          const acc = (d.acceptance ?? {}) as { items?: unknown };
          const turn = d.turn as BuilderTurnInfo['turn'] | undefined;
          setInfo({
            todos: Array.isArray(state.todos) ? (state.todos as BuilderTodo[]) : [],
            acceptance: Array.isArray(acc.items) ? (acc.items as BuilderAcceptanceItem[]) : [],
            turn: turn && typeof turn.startedAt === 'number' ? turn : null,
          });
        })
        .catch(() => undefined);
    void read();
    if (!live) return () => { alive = false; };
    const t = setInterval(read, LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agent, session, isBuilder, live]);

  return info;
}
