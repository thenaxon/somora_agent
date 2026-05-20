// Mirror of web/src/hooks/useDreamStates.ts adapted for the mobile
// client (no shared api.ts — direct fetch). Polls /dream-states every
// 30s. Dream phases don't change second-by-second (REM = minutes,
// DEEP = 12h, LUCID = 7d), so 30s is a comfortable refresh: stale
// state clears within half a minute without burning cycles.

import { useEffect, useState } from 'react';

/** Per-agent REM state + server-global DEEP/LUCID. Matches the shape
 *  served by `GET /dream-states` (see src/server/index.ts). */
export interface DreamStates {
  rem: Record<string, { active?: boolean; pendingCount?: number }>;
  deep: { active: boolean };
  lucid: { active: boolean; loopHolder?: string };
}

const EMPTY: DreamStates = { rem: {}, deep: { active: false }, lucid: { active: false } };

export function useDreamStates(intervalMs = 30_000): DreamStates {
  const [state, setState] = useState<DreamStates>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch('/dream-states')
        .then((r) => (r.ok ? r.json() : EMPTY))
        .then((s: DreamStates) => {
          if (!cancelled) setState(s ?? EMPTY);
        })
        .catch(() => {
          // Silent — server may be restarting. Keep last-known state.
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return state;
}

/** Determine which dream phase (if any) should pulse on this agent's
 *  avatar. Same priority as the desktop dock: LUCID > DEEP > REM. */
export function computeDreamPulse(
  agentName: string,
  dreamStates: DreamStates | undefined,
): 'rem' | 'deep' | 'lucid' | null {
  if (!dreamStates) return null;
  if (dreamStates.lucid.active && dreamStates.lucid.loopHolder === agentName) {
    return 'lucid';
  }
  if (dreamStates.deep.active) return 'deep';
  if (dreamStates.rem[agentName]?.active) return 'rem';
  return null;
}
