import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Whether the wiki is configured (wiki.enabled + obsidian.vault).
 *
 *  The wiki is opt-in, and a dock tile that opens a window which can
 *  only say "not configured" is worse than no tile — so the UI gate
 *  matches the server's 503 gate. Older servers without the route just
 *  leave the tile hidden. */
export function useWikiEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .wikiStatus()
      .then((s) => {
        if (!cancelled) setEnabled(s.enabled);
      })
      .catch(() => {
        // Older server without the route — leave the tile hidden.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}
