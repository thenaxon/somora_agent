// Browser list — the body of the "browsers" app window. One row per
// running managed Chromium (= per agent profile): who, how many tabs,
// what the active tab shows, and above all the control state — "agent
// controls", "waiting for you", "you control". Click a row → the live
// browser window. Polls /browser/status every 3 s; stage 3 replaces the
// polling with the change stream.

import { useCallback, useEffect, useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import { api, type BrowserInfo } from '../lib/api';

interface Props {
  onOpen: (browserId: string, title: string) => void;
}

export function controlLabel(b: Pick<BrowserInfo, 'control' | 'state'>): { text: string; tone: 'ok' | 'warn' | 'info' | 'muted' } {
  if (b.state === 'stopped') return { text: 'stopped', tone: 'muted' };
  switch (b.control) {
    case 'handoff_requested':
      return { text: 'waiting for you', tone: 'warn' };
    case 'human_control':
      return { text: 'you control', tone: 'info' };
    case 'paused':
      return { text: 'paused', tone: 'muted' };
    default:
      return { text: 'agent controls', tone: 'ok' };
  }
}

export function browserTitle(b: Pick<BrowserInfo, 'browser_id' | 'profile' | 'ephemeral'>): string {
  const base = b.browser_id.startsWith('profile:') ? `profile ${b.profile}` : b.profile;
  return b.ephemeral ? `${base} (temporary)` : base;
}

export function BrowserListWindow({ onOpen }: Props) {
  const [browsers, setBrowsers] = useState<BrowserInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.browserStatus();
      setBrowsers(r.browsers);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const toneColor: Record<string, string> = {
    ok: 'var(--ok, #3fb950)',
    warn: 'var(--warn, #d29922)',
    info: 'var(--accent, #58a6ff)',
    muted: 'var(--text-3)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: '"JetBrains Mono", monospace' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
          fontSize: 11,
          color: 'var(--text-2)',
        }}
      >
        <span>
          {browsers === null
            ? 'loading…'
            : browsers.length === 0
              ? 'no browser running — an agent starts one with the browser tool'
              : `${browsers.length} browser${browsers.length === 1 ? '' : 's'}`}
        </span>
        <button type="button" onClick={() => void refresh()} title="refresh" style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-3)', display: 'inline-flex' }}>
          <RefreshCw size={11} />
        </button>
      </div>
      {error && <div style={{ padding: 12, color: 'var(--danger, #f85149)', fontSize: 12 }}>{error}</div>}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {(browsers ?? []).map((b) => {
          const label = controlLabel(b);
          const active = b.tabs[0];
          return (
            <button
              type="button"
              key={b.browser_id}
              onClick={() => b.state === 'running' && onOpen(b.browser_id, browserTitle(b))}
              disabled={b.state !== 'running'}
              style={{
                all: 'unset',
                display: 'grid',
                gridTemplateColumns: '20px 1fr auto',
                gap: 10,
                alignItems: 'center',
                width: 'calc(100% - 24px)',
                padding: '10px 12px',
                cursor: b.state === 'running' ? 'pointer' : 'default',
                borderBottom: '1px solid var(--line)',
                opacity: b.state === 'running' ? 1 : 0.6,
              }}
            >
              <Globe size={16} style={{ color: toneColor[label.tone] }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: 'var(--text-1)' }}>{browserTitle(b)}</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {b.tabs.length} tab{b.tabs.length === 1 ? '' : 's'}
                  {active ? ` · ${active.title || active.url}` : ''}
                  {b.handoff ? ` · ${b.handoff.reason}` : ''}
                </span>
              </span>
              <span style={{ fontSize: 11, color: toneColor[label.tone], whiteSpace: 'nowrap' }}>{label.text}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
