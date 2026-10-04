// The open session's model, read from
// GET /agents/:agent/sessions/:session/model. Thin client: fetch when
// the session changes, refetch when the server says the model was
// switched (`session_model`, from any client or an agent), set or
// clear through the same route the desktop uses.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionModelInfo } from '../../../web/src/lib/api';

export function useSessionModel(
  agent: string | null,
  session: string,
  subscribeModelEvents: (handler: () => void) => () => void,
): {
  info: SessionModelInfo | null;
  refresh: () => void;
  /** `ref` = alias or provider/id; null clears the session's own
   *  choice (the agent's default applies again). Resolves with an
   *  error text, or null when it worked. */
  setModel: (ref: string | null) => Promise<string | null>;
} {
  const [info, setInfo] = useState<SessionModelInfo | null>(null);
  const currentRef = useRef({ agent, session });
  currentRef.current = { agent, session };
  // Only the newest request may write — a slow reply for the model
  // before a switch must not overwrite the one after it.
  const seqRef = useRef(0);

  const refresh = useCallback(() => {
    const { agent: a, session: s } = currentRef.current;
    if (!a) return;
    const seq = ++seqRef.current;
    fetch(`/agents/${encodeURIComponent(a)}/sessions/${encodeURIComponent(s)}/model`)
      .then((r) => (r.ok ? (r.json() as Promise<SessionModelInfo>) : null))
      .then((m) => {
        if (seq !== seqRef.current) return;
        if (currentRef.current.agent !== a || currentRef.current.session !== s) return;
        // A failed read keeps the last known model rather than blanking it.
        if (m) setInfo(m);
      })
      .catch(() => {
        /* network blip — the next event or switch refetches */
      });
  }, []);

  useEffect(() => {
    setInfo(null);
    seqRef.current += 1;
    refresh();
  }, [agent, session, refresh]);

  useEffect(() => subscribeModelEvents(refresh), [subscribeModelEvents, refresh]);

  const setModel = useCallback(
    async (ref: string | null): Promise<string | null> => {
      const { agent: a, session: s } = currentRef.current;
      if (!a) return 'No agent selected';
      const url = `/agents/${encodeURIComponent(a)}/sessions/${encodeURIComponent(s)}/model`;
      try {
        const res =
          ref === null
            ? await fetch(url, { method: 'DELETE' })
            : await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: ref }),
              });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          return body.error ?? `Could not switch the model (HTTP ${res.status})`;
        }
        refresh();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [refresh],
  );

  return { info, refresh, setModel };
}
