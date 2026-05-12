import { useEffect, useState } from 'react';
import { api, type DreamStates } from '../lib/api';

const EMPTY: DreamStates = { rem: {}, deep: { active: false }, lucid: { active: false } };

/** Poll /dream-states every 30s. Dream phases don't change second-by-
 *  second — REM runs are minutes, DEEP fires every 12h, LUCID every 7d.
 *  30s is a comfortable refresh: fresh enough that "done" reflects within
 *  half a minute, infrequent enough not to burn cycles. */
export function useDreamStates(intervalMs = 30_000) {
  const [state, setState] = useState<DreamStates>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      api
        .dreamStates()
        .then((s) => {
          if (!cancelled) setState(s);
        })
        .catch(() => {
          // Silent — server may be restarting. Keep last-known state.
        });
    };
    tick();
    timer = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [intervalMs]);

  return state;
}
