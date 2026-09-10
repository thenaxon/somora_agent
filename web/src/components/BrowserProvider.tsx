import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BrowserInfo } from '../lib/api';

export interface BrowserSnapshot { enabled: boolean; browsers: BrowserInfo[]; warnings?: string[] }
interface BrowserState extends BrowserSnapshot { connected: boolean; loaded: boolean; refresh: () => void }
const Context = createContext<BrowserState>({ enabled: false, browsers: [], connected: false, loaded: false, refresh: () => {} });

/** One change stream shared by chat notices, taskbar and browser list. Each
 * connection starts with a full snapshot; no polling or lost-notice replay. */
export function BrowserProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>({ enabled: false, browsers: [] });
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let alive = true;
    let last = Date.now();
    setConnected(false);
    const stream = new EventSource('/browser/stream');
    stream.addEventListener('browsers', (event) => {
      if (!alive) return;
      try {
        const next = JSON.parse((event as MessageEvent).data) as BrowserSnapshot;
        if (!Array.isArray(next.browsers) || typeof next.enabled !== 'boolean') return;
        setSnapshot(next);
        setLoaded(true);
        setConnected(true);
        last = Date.now();
      } catch { /* retain last valid snapshot until reconnection */ }
    });
    stream.addEventListener('heartbeat', () => { last = Date.now(); });
    stream.addEventListener('error', () => { if (alive) setConnected(false); });
    const resume = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > 45_000) setGeneration((n) => n + 1);
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    const watchdog = setInterval(resume, 15_000);
    return () => {
      alive = false;
      stream.close();
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [generation]);
  return <Context.Provider value={{ ...snapshot, connected, loaded, refresh: () => setGeneration((n) => n + 1) }}>{children}</Context.Provider>;
}

export const useBrowsers = () => useContext(Context);
