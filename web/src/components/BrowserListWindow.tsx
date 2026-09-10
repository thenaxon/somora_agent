// Browser list — the body of the "browser sessions" app window. One row
// per open window: which agent owns it, which profile it runs in, how
// many tabs, what the active tab shows, and the control state — "agent
// controls", "waiting for you", "you control". A shared profile is ONE
// Chromium but one row per agent (docs/browser.md). Click a row → the
// live browser window. Shares the authoritative change stream with chat
// and taskbar. Layout follows the tmux session list next door.

import { useState } from 'react';
import { Globe, RefreshCw } from 'lucide-react';
import { api, type BrowserInfo } from '../lib/api';
import { useBrowsers } from './BrowserProvider';

interface Props {
  onOpen: (viewId: string, title: string) => void;
}

export function controlLabel(b: Pick<BrowserInfo, 'control' | 'state'>): { text: string; tone: 'ok' | 'warn' | 'info' | 'muted' } {
  if (b.state === 'stopped') return { text: 'stopped', tone: 'muted' };
  switch (b.control) {
    case 'handoff_requested':
      return { text: 'waiting for you', tone: 'warn' };
    case 'human_control':
      return { text: 'human controls', tone: 'info' };
    case 'paused':
      return { text: 'paused', tone: 'muted' };
    default:
      return { text: 'agent controls', tone: 'ok' };
  }
}

/** The window's name: the agent, because that is whose window it is. */
export function browserTitle(b: Pick<BrowserInfo, 'agent' | 'ephemeral'>): string {
  return b.ephemeral ? `${b.agent} (temporary)` : b.agent;
}

/** Where the window runs: its own profile, or one it shares. */
export function browserProfileLabel(b: Pick<BrowserInfo, 'agent' | 'profile' | 'browser_id'>): string {
  return b.browser_id.startsWith('profile:') ? `shared profile ${b.profile}` : `own profile`;
}

const TONE: Record<string, string> = {
  ok: 'var(--ok, #3fb950)',
  warn: 'var(--warn, #d29922)',
  info: 'var(--accent, #58a6ff)',
  muted: 'var(--text-3)',
};

export function BrowserListWindow({ onOpen }: Props) {
  const state = useBrowsers();
  const browsers = state.loaded ? state.browsers : null;
  const warnings = state.warnings ?? [];
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const refresh = state.refresh;
  const open = async (b: BrowserInfo) => {
    setOpening(b.view_id);
    setError(null);
    try {
      if (b.state === 'stopped') await api.browserRestart(b.view_id);
      onOpen(b.view_id, browserTitle(b));
    } catch (e) { setError((e as Error).message); }
    finally { setOpening(null); }
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
              : `${browsers.length} browser session${browsers.length === 1 ? '' : 's'}`}
        </span>
        <button type="button" onClick={() => void refresh()} title="refresh" style={{ all: 'unset', cursor: 'pointer', color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <RefreshCw size={11} />
        </button>
      </div>
      {!state.connected && <div role="status" style={{ padding: 12, fontSize: 11, color: 'var(--text-3)' }}>Reconnecting to browser status…</div>}
      {error && <div style={{ padding: 12, color: 'var(--danger, #f85149)', fontSize: 11 }}>{error}</div>}
      {warnings.map((w) => (
        <div key={w} style={{ padding: '8px 12px', color: 'var(--warn, #d29922)', fontSize: 11, borderBottom: '1px solid var(--line)' }}>
          {w}
        </div>
      ))}
      <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
        {(browsers ?? []).map((b) => (
          <BrowserRow
            key={b.view_id}
            browser={b}
            busy={opening !== null}
            opening={opening === b.view_id}
            disabled={!state.connected}
            onOpen={() => void open(b)}
          />
        ))}
      </div>
    </div>
  );
}

function BrowserRow({ browser, busy, opening, disabled, onOpen }: {
  browser: BrowserInfo; busy: boolean; opening: boolean; disabled: boolean; onOpen: () => void;
}) {
  const label = controlLabel(browser);
  const active = browser.tabs[0];
  const status = opening ? 'opening…' : browser.state === 'stopped' ? 'stopped · reopen' : label.text;
  return (
    <div
      onClick={disabled || busy ? undefined : onOpen}
      title={`open ${browser.view_id}`}
      style={{
        cursor: disabled || busy ? 'default' : 'pointer',
        padding: '8px 10px',
        borderRadius: 4,
        marginBottom: 4,
        background: 'var(--bg-3)',
        border: '1px solid var(--line-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        opacity: browser.state === 'running' ? 1 : 0.6,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-2)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-3)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Globe size={12} style={{ color: TONE[label.tone] }} />
        <span style={{ color: 'var(--text-1)', fontSize: 12, fontWeight: 600 }}>{browserTitle(browser)}</span>
        <span style={{ color: 'var(--text-3)', fontSize: 10 }}>
          · {browser.tabs.length} tab{browser.tabs.length === 1 ? '' : 's'}
        </span>
        <span style={{ marginLeft: 'auto', color: TONE[label.tone], fontSize: 10, whiteSpace: 'nowrap' }}>{status}</span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        ↳ {browserProfileLabel(browser)}
        {active ? ` · ${active.title || active.url}` : ''}
        {browser.handoff ? ` · ${browser.handoff.reason}` : ''}
      </div>
    </div>
  );
}
