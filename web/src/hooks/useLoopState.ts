import { useEffect, useState } from 'react';
import { api, type LoopState } from '../lib/api';

/** Poll the server for the active dream_review loop holder. Polled
 *  every 2 s — cheap endpoint, no SSE for it on the server side, and
 *  the loop changes rarely enough that 2 s latency is fine. */
export function useLoopState() {
  const [state, setState] = useState<LoopState>({ active: false });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      api
        .loopState()
        .then((s) => {
          if (!cancelled) setState(s);
        })
        .catch(() => {
          // Silent — loop-state is optional info, server may be
          // restarting. Keep last-known state until next tick.
        });
    };
    tick();
    timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return state;
}
