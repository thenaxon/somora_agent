// Which local file the file sheet shows, tied to the browser history so
// the phone's own back (Android back button, iOS swipe in the browser,
// the PWA's back gesture) closes the sheet and leaves the user in the
// chat, instead of leaving somora.
//
// Opening a file pushes one history entry. Opening another file from a
// link inside the sheet replaces that entry, so one back always returns
// to the chat, however many files were followed. The sheet's own back
// button goes through history.back() when the entry is ours, which keeps
// the two ways of going back identical.

import { useCallback, useEffect, useState } from 'react';

const STATE_KEY = 'somoraFile';

export function fileFromHistoryState(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[STATE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function useFileSheet(): { path: string | null; open: (path: string) => void; close: () => void } {
  const [path, setPath] = useState<string | null>(() => fileFromHistoryState(safeState()));

  useEffect(() => {
    const onPop = (e: PopStateEvent) => setPath(fileFromHistoryState(e.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const open = useCallback((next: string) => {
    setPath(next);
    try {
      const entry = { ...(asObject(safeState())), [STATE_KEY]: next };
      if (fileFromHistoryState(safeState())) window.history.replaceState(entry, '');
      else window.history.pushState(entry, '');
    } catch {
      /* no history (sandboxed frame): the sheet's back button still closes */
    }
  }, []);

  const close = useCallback(() => {
    if (fileFromHistoryState(safeState())) {
      try {
        window.history.back();
        return; // popstate clears the path
      } catch {
        /* fall through */
      }
    }
    setPath(null);
  }, []);

  return { path, open, close };
}

function safeState(): unknown {
  try {
    return window.history.state;
  } catch {
    return null;
  }
}

function asObject(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}
