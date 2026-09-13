// The session's work queue, read from GET …/sessions/:session/work.
//
// Thin client: this hook only fetches and refetches. It refreshes on
// mount, on every queue-moving SSE event the ChatProvider relays
// (turn_queued / turn_dequeued / turn_started / turn end) and, while
// the popover is open (`live`), every 3 s so the wait times keep
// counting. No queue logic lives here — the badge and the popover
// draw what the server sends.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionWorkResponse } from '../lib/api';
import { useChatContext } from '../components/ChatProvider';

const LIVE_POLL_MS = 3000;

export interface SessionWork {
  work: SessionWorkResponse | null;
  refresh: () => void;
}

export function useSessionWork(agent: string, session: string, live: boolean): SessionWork {
  const { subscribeTurnEvents } = useChatContext();
  const [work, setWork] = useState<SessionWorkResponse | null>(null);
  // One request in flight at a time; a burst of SSE events (dequeue +
  // N turn_queued frames) collapses into a single follow-up fetch.
  const inFlightRef = useRef(false);
  const againRef = useRef(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(() => {
    if (inFlightRef.current) {
      againRef.current = true;
      return;
    }
    inFlightRef.current = true;
    api
      .sessionWork(agent, session)
      .then((w) => {
        if (aliveRef.current) setWork(w);
      })
      .catch(() => {
        /* the badge simply keeps its last snapshot; an older server
           without the route answers 404 and the badge stays hidden */
      })
      .finally(() => {
        inFlightRef.current = false;
        if (againRef.current) {
          againRef.current = false;
          refresh();
        }
      });
  }, [agent, session]);

  useEffect(() => {
    aliveRef.current = true;
    setWork(null);
    refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  useEffect(() => subscribeTurnEvents(agent, session, () => refresh()), [subscribeTurnEvents, agent, session, refresh]);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(refresh, LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [live, refresh]);

  return { work, refresh };
}
