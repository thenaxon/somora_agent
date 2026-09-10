import { useState } from 'react';
import { api, type BrowserInfo } from '../lib/api';

export function BrowserHandoffNotice({ browser, connected, onOpen }: {
  browser: BrowserInfo; connected: boolean; onOpen: (id: string, title: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      if (browser.state === 'stopped') await api.browserRestart(browser.view_id);
      onOpen(browser.view_id, browser.agent);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="browser-handoff-notice" role="status">
    <strong>Browser · {browser.handoff?.agent} · {browser.state === 'stopped' ? 'browser stopped' : browser.control === 'human_control' ? 'waiting for you to hand back' : 'waiting for you'}</strong>
    <span>{browser.handoff?.reason}</span>
    {browser.state === 'stopped' && <span>Reopen the browser to continue. The previous page will not be replayed.</span>}
    {!connected && <span>Reconnecting — checking browser state…</span>}
    <button type="button" disabled={busy || !connected} onClick={() => void open()}>{busy ? 'Opening…' : browser.state === 'stopped' ? 'Reopen browser' : 'Open browser'}</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
