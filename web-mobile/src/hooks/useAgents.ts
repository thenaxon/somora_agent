// Poll the somora /agents endpoint for the registered-agent list.
// Returns the list + loading/error states. Re-polls every 30s so
// newly-added agents show up without a manual reload.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyAgentOrder } from './agent-order';

export interface AgentInfo {
  name: string;
  icon?: string;
  color?: string;
  role?: string;
  description?: string;
  enabled?: boolean;
  /** agent.yaml `steering:` — default for a message typed while a turn
   *  runs: into that turn (true) or queued behind it. */
  steering?: boolean;
  /** 'external' for an agent of another system (docs/external-agents.md). */
  kind?: string;
  /** What to show about an external agent's system. */
  external?: { system: string; label: string; badge: string; badgeImage: string | null; version: string | null };
}

const POLL_INTERVAL_MS = 30_000;

export function useAgents() {
  const [all, setAll] = useState<AgentInfo[]>([]);
  // The tile order, the same on every device (GET/PUT /mobile-agent-order).
  const [order, setOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [res, saved] = await Promise.all([
          fetch('/agents'),
          fetch('/mobile-agent-order').then((r) => (r.ok ? (r.json() as Promise<{ order?: string[] }>) : null)).catch(() => null),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()) as AgentInfo[];
        if (cancelled) return;
        // Disabled agents are filtered server-side already; defensive
        // filter here just in case. The order is applied below.
        setAll(list.filter((a) => a.enabled !== false));
        if (saved?.order) setOrder(saved.order);
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

  // Memoised: effects downstream depend on the list's identity.
  const agents = useMemo(() => applyAgentOrder(all, order), [all, order]);

  /** Save a new order for every device. Shown at once; an error text
   *  (and the old order back) when the server refuses. */
  const saveOrder = useCallback(async (next: string[]): Promise<string | null> => {
    const before = order;
    setOrder(next);
    try {
      const res = await fetch('/mobile-agent-order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: next }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      return null;
    } catch (err) {
      setOrder(before);
      return `Order not saved: ${(err as Error).message}`;
    }
  }, [order]);

  return { agents, loading, error, saveOrder };
}
