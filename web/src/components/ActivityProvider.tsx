// Thin context bridge for the activity-stream state so ChatWindow +
// SessionsWindow (deeply nested under Desktop) can call postSeen and
// read marks without prop-drilling through Window/wm machinery.
//
// The hook itself (useActivityStream) is instantiated once at Desktop
// level so there is exactly one EventSource for /activity/stream
// across the whole app, regardless of how many windows are open.

import { createContext, useContext, type ReactNode } from 'react';
import type { ActivityState } from '../hooks/useActivityStream';

const ActivityCtx = createContext<ActivityState | null>(null);

export function ActivityProvider({
  value,
  children,
}: {
  value: ActivityState;
  children: ReactNode;
}) {
  return <ActivityCtx.Provider value={value}>{children}</ActivityCtx.Provider>;
}

/** Returns the activity state, or null if the consumer is outside the
 *  provider (e.g. dev-only standalone storybook). Callers must
 *  handle the null case gracefully. */
export function useActivity(): ActivityState | null {
  return useContext(ActivityCtx);
}
