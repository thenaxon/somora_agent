// Per-session model + thinking-level snapshot. Used by ChatWindow's
// header meta line to show what the agent is currently configured
// with. Both endpoints are cheap snapshots (no LLM call), polled
// when the session id changes — no continuous polling, the data
// changes only when the user runs /model or /think (or in step 4
// when we add inline UI for it).
//
// Returns nullable values so the header can render "—" / fall back
// when an endpoint hasn't responded yet or returned 404 (e.g. fresh
// session with no override and no persona default).

import { useEffect, useState } from 'react';
import { api, type SessionModelInfo, type SessionThinkingInfo } from '../lib/api';

export interface SessionInfo {
  model: SessionModelInfo | null;
  thinking: SessionThinkingInfo | null;
  loading: boolean;
}

export function useSessionInfo(agent: string, session: string): SessionInfo {
  const [model, setModel] = useState<SessionModelInfo | null>(null);
  const [thinking, setThinking] = useState<SessionThinkingInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.sessionModel(agent, session).catch(() => null),
      api.sessionThinking(agent, session).catch(() => null),
    ]).then(([m, t]) => {
      if (cancelled) return;
      setModel(m);
      setThinking(t);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [agent, session]);

  return { model, thinking, loading };
}
