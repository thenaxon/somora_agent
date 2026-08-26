import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/** Whether image generation is configured (imageGen.enabled plus at
 *  least one model).
 *
 *  Same posture as useWikiEnabled: the desktop tile matches the
 *  server's 503 gate, so a tile that could only open a window saying
 *  "not configured" never appears. Older servers without the route
 *  simply leave it hidden. */
export function useImagesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api
      .imagesStatus()
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
