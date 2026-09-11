// Keep the phone's screen awake while the PWA is in use.
//
// Rene, 2026-09-11: "ich hab ein aktuelles iphone" — the mobile client
// should stop the display from going to sleep mid-conversation.
//
// Three facts shape this hook:
//
//  1. A wake lock is released by the browser whenever the page is
//     hidden (tab switch, home button, screen lock). It is NOT restored
//     on return, so every implementation has to re-acquire on
//     visibilitychange or the lock silently stops working after the
//     first switch away.
//  2. On iOS the API exists in a Safari TAB since 16.4, but a
//     Home-Screen web app only got a working one in **18.4** — before
//     that `request()` resolved happily and the screen slept anyway
//     (WebKit bug 254545, fixed per the Safari 18.4 release notes).
//     Resolving therefore proves nothing on older iPhones, which is
//     why the UI says "your iOS may be too old" rather than "on".
//  3. `request()` rejects when the document is not visible or the user
//     has not interacted yet. That is normal, not an error worth
//     shouting about — the next foreground re-acquires.
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'somora.mobile.wakeLock';

type SentinelLike = { released?: boolean; release: () => Promise<void>; addEventListener?: (t: string, cb: () => void) => void };
type WakeLockLike = { request: (type: 'screen') => Promise<SentinelLike> };

function wakeLockApi(): WakeLockLike | null {
  const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
  return nav.wakeLock ?? null;
}

/** True when the browser exposes the API at all. */
export function wakeLockSupported(): boolean {
  return wakeLockApi() !== null;
}

/**
 * iOS versions before 18.4 accept the request inside a Home-Screen web
 * app and then let the screen sleep anyway. The version is the only
 * way to tell, since the promise resolves either way.
 */
export function iosWakeLockBroken(ua: string = navigator.userAgent): boolean {
  const m = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(ua);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major < 18 || (major === 18 && minor < 4);
}

export interface WakeLockState {
  /** What the user asked for (sticky per browser). */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** A lock is held right now. */
  active: boolean;
  /** The API is missing in this browser. */
  unsupported: boolean;
  /** The API is there but this iOS is too old to honour it. */
  unreliable: boolean;
}

export function useWakeLock(): WakeLockState {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [active, setActive] = useState(false);
  const sentinel = useRef<SentinelLike | null>(null);
  const unsupported = !wakeLockSupported();
  const unreliable = !unsupported && iosWakeLockBroken();

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* private mode — the toggle still works for this visit */
    }
  }, []);

  useEffect(() => {
    if (unsupported) return;
    let cancelled = false;

    const release = async (): Promise<void> => {
      const s = sentinel.current;
      sentinel.current = null;
      setActive(false);
      if (s && !s.released) {
        try {
          await s.release();
        } catch {
          /* already gone */
        }
      }
    };

    const acquire = async (): Promise<void> => {
      if (cancelled || !enabled) return;
      if (sentinel.current && !sentinel.current.released) return;
      if (document.visibilityState !== 'visible') return;
      try {
        const s = await wakeLockApi()!.request('screen');
        if (cancelled || !enabled) {
          void s.release().catch(() => {});
          return;
        }
        sentinel.current = s;
        setActive(true);
        // The browser drops the lock on its own when the page hides;
        // reflect that instead of claiming the screen is still held.
        s.addEventListener?.('release', () => {
          if (sentinel.current === s) sentinel.current = null;
          setActive(false);
        });
      } catch {
        // Not visible yet, or no user gesture so far. The next
        // foreground tries again.
        setActive(false);
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void acquire();
      else setActive(false);
    };

    if (enabled) void acquire();
    else void release();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void release();
    };
  }, [enabled, unsupported]);

  return { enabled, setEnabled, active, unsupported, unreliable };
}
