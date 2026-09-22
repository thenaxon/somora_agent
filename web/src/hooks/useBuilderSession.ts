// A builder session's panel data, read from GET …/sessions/:session/builder.
//
// Thin client, same shape as useSessionWork: fetch on mount, refetch on
// every turn event the ChatProvider relays, and poll every 2 s while
// mounted — the panel is always open for a builder, and the task list
// and an open question move while a turn runs. The SSE events
// (todo_updated, question_asked, …) exist for other clients; this hook
// simply re-reads the truth.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BuilderSessionResponse } from '../lib/api';
import { useChatContext } from '../components/ChatProvider';

const POLL_MS = 2000;

export interface BuilderSession {
  data: BuilderSessionResponse | null;
  refresh: () => void;
}

export function useBuilderSession(agent: string, session: string, enabled: boolean): BuilderSession {
  const { subscribeTurnEvents } = useChatContext();
  const [data, setData] = useState<BuilderSessionResponse | null>(null);
  const inFlightRef = useRef(false);
  const againRef = useRef(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(() => {
    if (!enabled) return;
    if (inFlightRef.current) {
      againRef.current = true;
      return;
    }
    inFlightRef.current = true;
    api
      .builderSession(agent, session)
      .then((d) => {
        if (aliveRef.current) setData(d);
      })
      .catch(() => {
        /* keep the last snapshot; an older server answers 404 */
      })
      .finally(() => {
        inFlightRef.current = false;
        if (againRef.current) {
          againRef.current = false;
          refresh();
        }
      });
  }, [agent, session, enabled]);

  useEffect(() => {
    aliveRef.current = true;
    setData(null);
    refresh();
    return () => {
      aliveRef.current = false;
    };
  }, [refresh]);

  useEffect(() => subscribeTurnEvents(agent, session, () => refresh()), [subscribeTurnEvents, agent, session, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, refresh]);

  return { data, refresh };
}
