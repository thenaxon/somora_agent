import { useEffect, useState } from 'react';
import { api, type AgentInfo } from '../lib/api';

/** Fetch the agent list once on mount. Phase 1 keeps it minimal —
 *  no polling, no SSE, no live status. The list rarely changes
 *  during a single browser session; a manual reload covers the
 *  edge case where the user adds an agent server-side. */
export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .agents()
      .then((list) => {
        if (cancelled) return;
        setAgents(list);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { agents, loading, error };
}
