// Poll the somora /agents endpoint for the registered-agent list.
// Returns the list + loading/error states. Re-polls every 30s so
// newly-added agents show up without a manual reload.

import { useEffect, useState } from 'react';

export interface AgentInfo {
  name: string;
  icon?: string;
  color?: string;
  role?: string;
  description?: string;
  enabled?: boolean;
}

const POLL_INTERVAL_MS = 30_000;

export function useAgents() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/agents');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()) as AgentInfo[];
        if (cancelled) return;
        // Sort alphabetically for stable avatar-row order. Disabled agents
        // filtered server-side already; defensive filter here just in case.
        const sorted = [...list]
          .filter((a) => a.enabled !== false)
          .sort((a, b) => a.name.localeCompare(b.name));
        setAgents(sorted);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(`Failed to load agents: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { agents, loading, error };
}
