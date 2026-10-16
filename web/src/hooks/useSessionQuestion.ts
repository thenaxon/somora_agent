// The open question of a session (an external agent asking "may I run
// this?"), for the card in the chat. Thin client, like useBuilderSession:
// fetched on mount, on every turn event, and every 1.5 s while a turn
// runs — a question only ever comes up during one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionQuestion } from '../lib/api';
import { useChatContext } from '../components/ChatProvider';

const POLL_MS = 1500;

export function useSessionQuestion(agent: string, session: string, enabled: boolean, streaming: boolean): { question: SessionQuestion | null; refresh: () => void } {
  const { subscribeTurnEvents } = useChatContext();
  const [question, setQuestion] = useState<SessionQuestion | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    if (!enabled) return;
    api
      .sessionQuestion(agent, session)
      .then((q) => {
        if (alive.current) setQuestion(q);
      })
      .catch(() => {
        /* an older server has no such route */
      });
  }, [agent, session, enabled]);
  useEffect(() => {
    alive.current = true;
    setQuestion(null);
    refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  useEffect(() => subscribeTurnEvents(agent, session, () => refresh()), [subscribeTurnEvents, agent, session, refresh]);
  useEffect(() => {
    if (!enabled || !streaming) return;
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [enabled, streaming, refresh]);
  return { question, refresh };
}
