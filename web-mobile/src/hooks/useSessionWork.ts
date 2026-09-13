// The active agent's main-session work queue, read from
// GET /agents/:agent/sessions/main/work. Thin client: fetch on mount,
// refetch on every queue-moving SSE event the chat stream relays, and
// every 3 s while the sheet is open so the wait times keep counting.
// The shape is the one the desktop client types (web/src/lib/api.ts).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionWorkResponse } from '../../../web/src/lib/api';
import type { TurnQueueEvent } from './useChatStream';

export type { SessionWorkResponse, WorkItemDto } from '../../../web/src/lib/api';

const LIVE_POLL_MS = 3000;

export function useSessionWork(
  agent: string | null,
  subscribeTurnEvents: (handler: (event: TurnQueueEvent) => void) => () => void,
  live: boolean,
): { work: SessionWorkResponse | null; refresh: () => void } {
  const [work, setWork] = useState<SessionWorkResponse | null>(null);
  const inFlightRef = useRef(false);
  const againRef = useRef(false);
  const agentRef = useRef(agent);
  agentRef.current = agent;

  const refresh = useCallback(() => {
    const a = agentRef.current;
    if (!a) return;
    if (inFlightRef.current) {
      againRef.current = true;
      return;
    }
    inFlightRef.current = true;
    fetch(`/agents/${encodeURIComponent(a)}/sessions/main/work`)
      .then((r) => (r.ok ? (r.json() as Promise<SessionWorkResponse>) : null))
      .then((w) => {
        // A reply for the agent the user already left is dropped.
        if (w && agentRef.current === a) setWork(w);
      })
      .catch(() => {
        /* keep the last snapshot; an older server without the route
           answers 404 and the badge simply stays hidden */
      })
      .finally(() => {
        inFlightRef.current = false;
        if (againRef.current) {
          againRef.current = false;
          refresh();
        }
      });
  }, []);

  useEffect(() => {
    setWork(null);
    refresh();
  }, [agent, refresh]);

  useEffect(() => subscribeTurnEvents(() => refresh()), [subscribeTurnEvents, refresh]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(refresh, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [live, refresh]);

  return { work, refresh };
}
