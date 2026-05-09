// Per-session AbortController registry for in-flight chat turns.
// /chat/send creates a controller, stores it under <agent>/<session>,
// passes the signal through runChatTurn → engine adapters. /chat/abort
// looks the controller up + aborts. Cleanup on turn-end via the
// release() callback (analog to session-queue's release pattern).
//
// In-memory only — server restart drops controllers. Any in-flight
// turn at restart-time is already gone (the engine subprocess died
// with somora). Fresh state on boot is correct.

import { logger } from './logger.ts';

interface ActiveTurn {
  controller: AbortController;
  startedAt: number;
}

const active = new Map<string, ActiveTurn>();

function key(agent: string, session: string): string {
  return `${agent}/${session}`;
}

/**
 * Register a fresh controller for this turn and return its signal +
 * a release() callback. Call release() in a finally to clean up.
 * If a previous turn for the same session is still registered (which
 * shouldn't happen given the session-lock, but defense in depth),
 * abort it first to prevent leaks.
 */
export function registerChatAbort(
  agent: string,
  session: string,
): { signal: AbortSignal; release: () => void } {
  const k = key(agent, session);
  const existing = active.get(k);
  if (existing) {
    existing.controller.abort();
    logger.warn({
      msg: 'chat.abort.replaced_prior',
      agent,
      session,
      hint: 'second turn registered while a previous controller still active — aborting old',
    });
  }
  const controller = new AbortController();
  active.set(k, { controller, startedAt: Date.now() });
  return {
    signal: controller.signal,
    release: () => {
      const cur = active.get(k);
      if (cur && cur.controller === controller) {
        active.delete(k);
      }
    },
  };
}

/**
 * Trigger the abort signal for an in-flight turn. Returns whether
 * there was something to abort. Idempotent — second call when
 * nothing's running returns false.
 */
export function triggerChatAbort(agent: string, session: string): {
  aborted: boolean;
  ms_running?: number;
} {
  const k = key(agent, session);
  const entry = active.get(k);
  if (!entry) return { aborted: false };
  entry.controller.abort();
  const ms_running = Date.now() - entry.startedAt;
  // Leave the entry in place — the runChatTurn finally-block calls
  // release() to remove it. Removing here would race with the
  // release-after-abort detection.
  logger.info({
    msg: 'chat.abort.triggered',
    agent,
    session,
    ms_running,
  });
  return { aborted: true, ms_running };
}
