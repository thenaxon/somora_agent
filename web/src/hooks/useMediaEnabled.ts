import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface MediaAvailability {
  images: boolean;
  video: boolean;
  /** Either one. What the desktop tile hangs off. */
  any: boolean;
}

/**
 * Which media surfaces are configured.
 *
 * Both are asked, not just images: the window covers both, and gating
 * the tile on images alone made a video-only install unable to reach it
 * at all. Same posture as before — the tile matches the server's 503
 * gate, so a tile that could only open a window saying "not configured"
 * never appears, and an older server without the routes leaves it
 * hidden rather than erroring.
 */
export function useMediaEnabled(): MediaAvailability {
  const [state, setState] = useState<MediaAvailability>({
    images: false,
    video: false,
    any: false,
  });
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([api.imagesStatus(), api.videoStatus()]).then(([img, vid]) => {
      if (cancelled) return;
      const images = img.status === 'fulfilled' && img.value.enabled === true;
      const video = vid.status === 'fulfilled' && vid.value.enabled === true;
      setState({ images, video, any: images || video });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
