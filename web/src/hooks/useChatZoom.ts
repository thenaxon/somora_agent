// Per-agent chat text zoom.
//
// Scoped to the agent, not to the window: "make my conversation with
// nova bigger" should survive closing and reopening that chat, and
// should not leak into other agents or the rest of the desktop.
//
// State lives in a module-level store rather than per-hook useState so
// two windows showing the SAME agent (e.g. two sessions side by side)
// stay in sync instead of drifting apart and racing each other into
// localStorage.

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

function setAgentZoom(agent: string, zoom: number) {
  const next: ZoomMap = { ...state };
  // 100% is the default, so it is stored as absence — keeps the blob
  // small and makes "never touched" and "reset to normal" identical.
  if (zoom === DEFAULT_ZOOM) delete next[agent];
  else next[agent] = zoom;
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or blocked storage — zoom holds for this session only.
  }
  for (const listener of listeners) listener();
}

export function useChatZoom(agentName: string) {
  const all = useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
  const zoom = all[agentName] ?? DEFAULT_ZOOM;

  const zoomIn = useCallback(
    () => setAgentZoom(agentName, stepZoom(zoom, 1)),
    [agentName, zoom],
  );
  const zoomOut = useCallback(
    () => setAgentZoom(agentName, stepZoom(zoom, -1)),
    [agentName, zoom],
  );
  const resetZoom = useCallback(() => setAgentZoom(agentName, DEFAULT_ZOOM), [agentName]);

  return {
    zoom,
    zoomIn,
    zoomOut,
    resetZoom,
    canZoomIn: zoom < MAX_ZOOM,
    canZoomOut: zoom > (MIN_ZOOM as number),
  };
}
