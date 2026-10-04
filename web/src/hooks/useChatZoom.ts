// Chat text zoom, per session.
//
// The zoom belongs to one conversation: two sessions of the same agent
// side by side (a project session large, `main` small) are set
// independently, and the size survives closing and reopening that chat.
// The key is `<agent>/<session>`. A value stored under the bare agent
// name — the per-agent zoom of earlier builds — is the starting size for
// that agent's sessions that have no value of their own yet.
//
// State lives in a module-level store rather than per-hook useState so
// two windows showing the SAME session stay in sync instead of drifting
// apart and racing each other into localStorage.

import { useCallback, useSyncExternalStore } from 'react';

/** Discrete steps rather than a free float — every stop is a round,
 *  reproducible size, and the buttons can hard-stop at the ends. */
export const ZOOM_LEVELS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_ZOOM = 1;
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1] as number;

const STORAGE_KEY = 'somora-chat-zoom';

export type ZoomMap = Record<string, number>;

/** Next step up (+1) or down (-1). Snaps to the nearest level first, so
 *  a value restored from an older build that is no longer in the list
 *  still steps somewhere sensible instead of getting stuck. */
export function stepZoom(current: number, direction: 1 | -1): number {
  let idx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    const dist = Math.abs((ZOOM_LEVELS[i] as number) - current);
    if (dist < bestDist) {
      bestDist = dist;
      idx = i;
    }
  }
  const next = Math.min(Math.max(idx + direction, 0), ZOOM_LEVELS.length - 1);
  return ZOOM_LEVELS[next] as number;
}

function readStored(): ZoomMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ZoomMap = {};
    for (const [agent, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Clamp rather than drop: a stored 4x from a hand-edited storage
      // should degrade to the max, not silently reset to 100%.
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      out[agent] = Math.min(Math.max(value, MIN_ZOOM as number), MAX_ZOOM);
    }
    return out;
  } catch {
    // Missing, blocked (Safari private mode) or corrupt — all default.
    return {};
  }
}

let state: ZoomMap = readStored();
const listeners = new Set<() => void>();

/** Stable empty snapshot for server rendering — useSyncExternalStore
 *  requires a referentially stable value here. */
const SERVER_STATE: ZoomMap = {};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** At most this many per-session entries are kept; the oldest go first.
 *  Sessions come and go, the blob should not grow with them. */
const MAX_SESSION_ENTRIES = 200;

export function zoomKey(agent: string, session: string): string {
  return `${agent}/${session}`;
}

/** What a window shows: the session's own value, else the agent's
 *  earlier per-agent value, else 100 %. */
export function zoomFor(map: ZoomMap, agent: string, session: string): number {
  return map[zoomKey(agent, session)] ?? map[agent] ?? DEFAULT_ZOOM;
}

/** The map after one session's zoom changed. 100 % is stored explicitly
 *  when the agent has an inherited value (otherwise "reset" would fall
 *  back to it), and as absence when not. */
export function withSessionZoom(map: ZoomMap, agent: string, session: string, zoom: number): ZoomMap {
  const key = zoomKey(agent, session);
  const next: ZoomMap = { ...map };
  delete next[key];
  if (zoom !== DEFAULT_ZOOM || next[agent] !== undefined) next[key] = zoom; // re-inserted last = newest
  const sessionKeys = Object.keys(next).filter((k) => k.includes('/'));
  for (const old of sessionKeys.slice(0, Math.max(0, sessionKeys.length - MAX_SESSION_ENTRIES))) delete next[old];
  return next;
}

function setSessionZoom(agent: string, session: string, zoom: number) {
  const next = withSessionZoom(state, agent, session, zoom);
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or blocked storage — zoom holds for this session only.
  }
  for (const listener of listeners) listener();
}

export function useChatZoom(agentName: string, sessionId: string) {
  const all = useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
  const zoom = zoomFor(all, agentName, sessionId);

  const zoomIn = useCallback(
    () => setSessionZoom(agentName, sessionId, stepZoom(zoom, 1)),
    [agentName, sessionId, zoom],
  );
  const zoomOut = useCallback(
    () => setSessionZoom(agentName, sessionId, stepZoom(zoom, -1)),
    [agentName, sessionId, zoom],
  );
  const resetZoom = useCallback(() => setSessionZoom(agentName, sessionId, DEFAULT_ZOOM), [agentName, sessionId]);

  return {
    zoom,
    zoomIn,
    zoomOut,
    resetZoom,
    canZoomIn: zoom < MAX_ZOOM,
    canZoomOut: zoom > (MIN_ZOOM as number),
  };
}
