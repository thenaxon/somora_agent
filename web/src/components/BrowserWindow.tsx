// Live view of one managed browser (docs/browser.md, stage 2).
//
// Header: control state + "Take over" / "Hand back", tab bar,
// URL bar with back/forward/reload. Stage: the JPEG screencast as an
// <img>, one object URL at a time (revoked when the next frame lands).
// Input goes to the server only while THIS viewer holds human control;
// otherwise you watch.
//
// Coordinates: the server streams the page at its CSS viewport size
// (header cssWidth/cssHeight); the image is scaled to fit the stage,
// so a click at (x, y) on the image maps to (x / scale, y / scale).
// Typing: a hidden, focused textarea catches composed text (umlauts,
// dead keys, paste, IME) and sends it as one `text` message; special
// keys and shortcuts go as `key` messages. Resize: the stage size is
// sent (debounced) as the new remote viewport — only by the human
// controller, so two viewers never fight over the size.
//
// Frames tagged with an older generation than the last `ready`/`tabs`
// info are still drawn (they are the newest picture we have), but the
// generation is shown in the header so a stale picture after a
// navigation is recognisable; the server's eviction handles denied
// pages.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Hand, Plus, RotateCw, X } from 'lucide-react';
import { api, type BrowserInfo } from '../lib/api';
import { browserTitle, controlLabel } from './BrowserListWindow';

interface Props {
  browserId: string;
}

type Status = 'connecting' | 'open' | 'closed';

const RESIZE_DEBOUNCE_MS = 250;
const STALE_MS = 80_000;

interface FrameMeta {
  tabId: string;
  generation: number;
  seq: number;
  url: string;
  cssWidth: number;
  cssHeight: number;
}

export function BrowserWindow({ browserId }: Props) {
  const [status, setStatus] = useState<Status>('connecting');
  const [detail, setDetail] = useState<string | null>(null);
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [viewerId] = useState(() => `v-${Math.random().toString(36).slice(2, 8)}`);
  const [urlInput, setUrlInput] = useState('');
  const [frame, setFrame] = useState<{ url: string; meta: FrameMeta } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastMetaRef = useRef<FrameMeta | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const iControl = info?.control === 'human_control';

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }, []);

  // ── socket ──────────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let lastMsgAt = Date.now();
    const wsOrigin = window.location.origin.replace(/^http/, 'ws');

    function schedule(): void {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
      attempt++;
      setStatus('connecting');
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect(): void {
      if (disposed) return;
      const tabQ = tabId ? `&tab=${encodeURIComponent(tabId)}` : '';
      const sock = new WebSocket(`${wsOrigin}/browser/attach?browser=${encodeURIComponent(browserId)}${tabQ}&viewer=${viewerId}`);
      sock.binaryType = 'arraybuffer';
      ws = sock;
      wsRef.current = sock;
      sock.onopen = () => {
        if (disposed || ws !== sock) return;
        attempt = 0;
        lastMsgAt = Date.now();
        setStatus('open');
        setDetail(null);
      };
      sock.onmessage = (ev) => {
        if (ws !== sock) return;
        lastMsgAt = Date.now();
        if (ev.data instanceof ArrayBuffer) {
          const view = new DataView(ev.data);
          const hlen = view.getUint32(0);
          const header = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 4, hlen))) as FrameMeta;
          const blob = new Blob([new Uint8Array(ev.data, 4 + hlen)], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = url;
          lastMetaRef.current = header;
          setFrame({ url, meta: header });
          return;
        }
        if (typeof ev.data !== 'string') return;
        let msg: { type?: string; [k: string]: unknown };
        try {
          msg = JSON.parse(ev.data) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === 'ping') {
          sock.send('{"type":"pong"}');
          return;
        }
        if (msg.type === 'ready' || msg.type === 'tabs') {
          const b = msg.browser as BrowserInfo;
          setInfo(b);
          if (typeof msg.tabId === 'string') setTabId(msg.tabId);
          return;
        }
        if (msg.type === 'control') {
          setInfo((cur) => (cur ? { ...cur, control: (msg.control as { mode: BrowserInfo['control'] }).mode } : cur));
          return;
        }
        if (msg.type === 'notice' || msg.type === 'error') {
          setNotice(String(msg.text ?? ''));
          setTimeout(() => setNotice(null), 4000);
        }
      };
      sock.onclose = (ev) => {
        if (disposed || ws !== sock) return;
        ws = null;
        wsRef.current = null;
        if (ev.code === 1008 || ev.code === 4001) {
          setStatus('closed');
          setDetail(ev.reason || `code ${ev.code}`);
          return;
        }
        schedule();
      };
      sock.onerror = () => {
        if (disposed || ws !== sock) return;
        setDetail('connection failed');
      };
    }
    connect();
    // Stale check: the server pings every 25 s; silence means a dead path.
    const stale = setInterval(() => {
      if (ws && Date.now() - lastMsgAt > STALE_MS) {
        const old = ws;
        ws = null;
        wsRef.current = null;
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try {
          old.close();
        } catch {
          /* ignore */
        }
        schedule();
      }
    }, 10_000);
    return () => {
      disposed = true;
      clearInterval(stale);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const old = ws;
      ws = null;
      wsRef.current = null;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try {
          old.close();
        } catch {
          /* ignore */
        }
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
    // The socket is bound to the browser, not the tab: tab switches go over the open socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserId, viewerId]);

  // URL bar follows the streamed tab unless the user is editing.
  const editingUrl = useRef(false);
  useEffect(() => {
    if (editingUrl.current) return;
    const t = info?.tabs.find((x) => x.tab_id === tabId);
    if (t) setUrlInput(t.url);
  }, [info, tabId]);

  // ── resize → remote viewport (controller only) ──────────────────
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (!iControl) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 100) send({ type: 'resize', width: Math.round(r.width), height: Math.round(r.height) });
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [iControl, send]);

  // ── pointer mapping ─────────────────────────────────────────────
  const remotePoint = useCallback((e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const img = imgRef.current;
    const meta = lastMetaRef.current;
    if (!img || !meta) return null;
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = ((e.clientX - r.left) / r.width) * meta.cssWidth;
    const y = ((e.clientY - r.top) / r.height) * meta.cssHeight;
    if (x < 0 || y < 0 || x > meta.cssWidth || y > meta.cssHeight) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  const onStageClick = (e: React.MouseEvent) => {
    inputRef.current?.focus();
    if (!iControl) return;
    const p = remotePoint(e);
    if (!p) return;
    send({ type: 'click', ...p, button: e.button === 2 ? 'right' : 'left', clickCount: e.detail || 1 });
  };
  const onStageMove = (e: React.MouseEvent) => {
    if (!iControl) return;
    const p = remotePoint(e);
    if (p) send({ type: 'mousemove', ...p });
  };
  const lastWheel = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (!iControl) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheel.current < 40) return;
    lastWheel.current = now;
    const p = remotePoint(e) ?? { x: 10, y: 10 };
    send({ type: 'wheel', ...p, deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY) });
  };

  // ── keyboard: composed text vs. special keys ────────────────────
  const composing = useRef(false);
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!iControl) return;
    if (composing.current) return;
    const k = e.key;
    const printable = k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable) return; // arrives via onInput as text
    // Paste stays local: preventing default on Ctrl/Cmd+V would suppress
    // the paste event, and the remote page's clipboard is empty anyway —
    // onPaste sends the clipboard text as one `text` message.
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'v') return;
    if (k === 'Unidentified' || k === 'Dead' || k === 'Process') return;
    e.preventDefault();
    send({ type: 'key', key: k, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
  };
  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (composing.current) return;
    const text = el.value;
    el.value = '';
    if (!iControl || !text) return;
    send({ type: 'text', text });
  };
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!iControl) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    if (text) send({ type: 'text', text });
  };

  // ── control ─────────────────────────────────────────────────────
  const takeOver = async () => {
    try {
      await api.browserControl(browserId, 'human');
      inputRef.current?.focus();
    } catch (err) {
      setNotice((err as Error).message);
    }
  };
  const handBack = async () => {
    try {
      await api.browserControl(browserId, 'agent', info?.handoff?.id);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const label = info ? controlLabel(info) : null;
  const tabs = info?.tabs ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', height: '100%', minHeight: 0, background: 'var(--bg-2)' }}>
      {/* header: state + control buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderBottom: '1px solid var(--line)', fontSize: 11, fontFamily: '"JetBrains Mono", monospace' }}>
        <span style={{ color: 'var(--text-2)' }}>{info ? browserTitle(info) : browserId}</span>
        {label && (
          <span style={{ color: label.tone === 'warn' ? 'var(--warn, #d29922)' : label.tone === 'info' ? 'var(--accent, #58a6ff)' : 'var(--text-3)' }}>
            · {label.text}
          </span>
        )}
        {info?.handoff && info.control !== 'human_control' && (
          <span style={{ color: 'var(--warn, #d29922)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }} title={info.handoff.reason}>
            {info.handoff.agent}: {info.handoff.reason}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: status === 'open' ? 'var(--ok, #3fb950)' : 'var(--text-3)' }}>{status === 'open' ? '● live' : status === 'connecting' ? '○ connecting…' : `○ ${detail ?? 'closed'}`}</span>
        {iControl ? (
          <button type="button" onClick={() => void handBack()} className="browser-btn browser-btn-primary" title="Give control back to the agent (wakes it if it asked for you or if you changed something)">
            <Hand size={12} /> Hand back
          </button>
        ) : (
          <button type="button" onClick={() => void takeOver()} className="browser-btn" title="Take control: your clicks and typing go to the page; the agent is paused">
            <Hand size={12} /> Take over
          </button>
        )}
      </div>
      {/* tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: '1px solid var(--line)', overflowX: 'auto', fontSize: 11 }}>
        {tabs.map((t) => (
          <span key={t.tab_id} className={`browser-tab${t.tab_id === tabId ? ' active' : ''}`} onClick={() => send({ type: 'tab', tabId: t.tab_id })} title={t.url}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{t.title || t.url || 'about:blank'}</span>
            {iControl && (
              <X
                size={11}
                style={{ marginLeft: 4, opacity: 0.6 }}
                onClick={(e) => {
                  e.stopPropagation();
                  send({ type: 'closetab', tabId: t.tab_id });
                }}
              />
            )}
          </span>
        ))}
        {iControl && (
          <button type="button" className="browser-btn" onClick={() => send({ type: 'newtab' })} title="New tab" style={{ padding: '2px 6px' }}>
            <Plus size={12} />
          </button>
        )}
      </div>
      {/* url bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          editingUrl.current = false;
          if (!iControl) {
            setNotice('Take over the browser first to navigate.');
            return;
          }
          const url = /^[a-z]+:\/\//i.test(urlInput) ? urlInput : `https://${urlInput}`;
          send({ type: 'navigate', url });
        }}
        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderBottom: '1px solid var(--line)' }}
      >
        <button type="button" className="browser-btn" disabled={!iControl} onClick={() => send({ type: 'back' })} title="Back"><ArrowLeft size={13} /></button>
        <button type="button" className="browser-btn" disabled={!iControl} onClick={() => send({ type: 'forward' })} title="Forward"><ArrowRight size={13} /></button>
        <button type="button" className="browser-btn" disabled={!iControl} onClick={() => send({ type: 'reload' })} title="Reload"><RotateCw size={13} /></button>
        <input
          value={urlInput}
          onChange={(e) => {
            editingUrl.current = true;
            setUrlInput(e.target.value);
          }}
          onBlur={() => {
            editingUrl.current = false;
          }}
          readOnly={!iControl}
          spellCheck={false}
          style={{ flex: 1, font: '12px "JetBrains Mono", monospace', padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg-1)', color: 'var(--text-1)' }}
        />
      </form>
      {/* stage */}
      <div
        ref={stageRef}
        className={`browser-stage${iControl ? ' controlling' : ''}`}
        onClick={onStageClick}
        onContextMenu={(e) => e.preventDefault()}
        onMouseMove={onStageMove}
        onWheel={onWheel}
      >
        {frame ? (
          <img ref={imgRef} src={frame.url} alt="" draggable={false} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }} />
        ) : (
          <div style={{ color: 'var(--text-3)', fontSize: 12, padding: 20 }}>{status === 'closed' ? (detail ?? 'closed') : 'waiting for the first frame…'}</div>
        )}
        <textarea
          ref={inputRef}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onPaste={onPaste}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            const text = e.currentTarget.value;
            e.currentTarget.value = '';
            if (iControl && text) send({ type: 'text', text });
          }}
          aria-label="browser keyboard input"
          style={{ position: 'absolute', left: -9999, top: 0, width: 1, height: 1, opacity: 0 }}
        />
        {notice && <div className="browser-notice">{notice}</div>}
      </div>
      <div style={{ padding: '3px 10px', borderTop: '1px solid var(--line)', fontSize: 10, color: 'var(--text-3)', fontFamily: '"JetBrains Mono", monospace', display: 'flex', gap: 12 }}>
        <span>{tabId ?? '–'}</span>
        {frame && <span>{frame.meta.cssWidth}×{frame.meta.cssHeight} · gen {frame.meta.generation} · #{frame.meta.seq}</span>}
        <span style={{ flex: 1 }} />
        <span>{iControl ? 'you control · click the picture, type, paste' : 'watching · take over to interact'}</span>
      </div>
    </div>
  );
}
