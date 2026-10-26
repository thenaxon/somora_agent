// The open question of a session (an external agent asking "may I run
// this?"), for the card in the chat. Thin client, like useBuilderSession:
// fetched on mount, on every turn event, and every 1.5 s while a turn
// runs — a question only ever comes up during one.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SessionQuestion } from '../lib/api';
import { useChatContext } from '../components/ChatProvider';

const POLL_MS = 1500;
/** A read that failed on the network (the event came, the fetch did not)
 *  is tried again this often, this far apart — else the card stays
 *  unseen until the next turn event (review 2026-10-26). */
const RETRIES = 4;
const RETRY_MS = 2500;

export function useSessionQuestion(agent: string, session: string, enabled: boolean, streaming: boolean): { question: SessionQuestion | null; refresh: () => void } {
  const { subscribeTurnEvents } = useChatContext();
  const [question, setQuestion] = useState<SessionQuestion | null>(null);
  const alive = useRef(true);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (!enabled) return;
    if (retry.current) clearTimeout(retry.current);
    const attempt = (left: number) => {
      api
        .sessionQuestion(agent, session)
        .then((q) => {
          if (alive.current) setQuestion(q);
        })
        .catch((err: unknown) => {
          // A network failure (TypeError from fetch) is tried again; an
          // HTTP error means an older server without the route.
          if (!(err instanceof TypeError) || left <= 0 || !alive.current) return;
          retry.current = setTimeout(() => attempt(left - 1), RETRY_MS);
        });
    };
    attempt(RETRIES);
  }, [agent, session, enabled]);
  useEffect(() => {
    alive.current = true;
    setQuestion(null);
    refresh();
    return () => {
      alive.current = false;
      if (retry.current) clearTimeout(retry.current);
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
