import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Whether the shared browser is configured — gates the desktop tile
 *  the same way the media tile hangs off its status route, so the tile
 *  never opens a window that can only say "not configured". */
export function useBrowserEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .browserStatus()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}
