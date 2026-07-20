// Generic xterm.js + WebSocket bridge. Two callers today: the tmux
// attach window and the plain-shell terminal window. The behaviour
// is identical — server spawns a PTY, binary frames carry the
// terminal stream both ways, JSON text frames carry control messages
// (resize, heartbeat ping/pong). The only difference is the WS URL.
//
// Liveness: an idle pane moves zero bytes, so a silently dead path
// (Tailscale idle drop, laptop sleep, network switch) leaves the
// browser socket looking open forever. The server pings every 25s;
// we pong back, and when pings stop arriving (or the socket closes)
// we reconnect automatically — tmux redraws on re-attach, a plain
// shell comes back as a fresh shell.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  /** Path on the somora server to upgrade. The component prepends
   *  the current page origin and rewrites http→ws. Example:
   *  `/tmux/attach?session=foo` or `/terminal/attach`. */
  attachPath: string;
  /** Status pill text to render when the WS hasn't reached `open`
   *  yet — usually "tmux" or "shell" so the user knows what's
   *  spinning up. Defaults to "terminal". */
  busyLabel?: string;
}

type Status = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

// Server pings every 25s; two missed pings + slack = stale. Checked
// on a 10s tick and immediately when the tab becomes visible again.
const STALE_AFTER_MS = 60_000;
const STALE_CHECK_MS = 10_000;
const RECONNECT_MAX_DELAY_MS = 15_000;

export function XTermBridge({ attachPath, busyLabel = 'terminal' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: '#0a0e15',
        foreground: '#e7ecf2',
        cursor: '#5cf2d6',
        selectionBackground: '#3a4250',
      },
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const wsOrigin = window.location.origin.replace(/^http/, 'ws');
    const url = `${wsOrigin}${attachPath}`;

    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let lastMsgAt = 0;
    let announcedDrop = false;

    function sendResize(): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      } catch {
        /* socket closed mid-write */
      }
    }

    function scheduleReconnect(): void {
      if (disposed || reconnectTimer) return;
      if (!announcedDrop) {
        announcedDrop = true;
        term.write(`\r\n\x1b[33m[somora] ${busyLabel} connection lost — reconnecting…\x1b[0m\r\n`);
      }
      setStatus('reconnecting');
      const delay = Math.min(1000 * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    /** Drop the current socket (without triggering its handlers) and
     *  go through the reconnect path. Used by the staleness check —
     *  a wedged socket may never fire `close` on its own. */
    function forceReconnect(): void {
      if (disposed) return;
      const old = ws;
      ws = null;
      if (old) {
        old.onopen = old.onmessage = old.onclose = old.onerror = null;
        try {
          old.close();
        } catch {
          /* ignore */
        }
      }
      scheduleReconnect();
    }

    function connect(): void {
      if (disposed) return;
      const sock = new WebSocket(url);
      sock.binaryType = 'arraybuffer';
      ws = sock;

      sock.onopen = () => {
        if (disposed || ws !== sock) return;
        attempt = 0;
        announcedDrop = false;
        lastMsgAt = Date.now();
        setStatus('open');
        setStatusDetail(null);
        sendResize();
      };
      sock.onmessage = (ev) => {
        if (ws !== sock) return;
        lastMsgAt = Date.now();
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
          term.write(new Uint8Array(data));
        } else if (typeof data === 'string') {
          // Text frame = control message (heartbeat). Answer pings so
          // the server knows we're alive; never render control frames.
          try {
            const msg = JSON.parse(data) as { type?: string };
            if (msg.type === 'ping') {
              try {
                sock.send('{"type":"pong"}');
              } catch {
                /* socket closed mid-write */
              }
            }
            if (typeof msg.type === 'string') return;
          } catch {
            /* not JSON — fall through and render */
          }
          term.write(data);
        }
      };
      sock.onclose = (ev) => {
        if (disposed || ws !== sock) return;
        ws = null;
        // Deliberate server close (PTY exit, invalid session, spawn
        // failure) → stay closed; anything else is a transport drop →
        // reconnect.
        if (ev.code === 1000 || ev.code === 1008 || ev.code === 1011) {
          setStatus('closed');
          setStatusDetail(ev.reason || `code ${ev.code}`);
          term.write(`\r\n\x1b[33m[somora] ${busyLabel} closed: ${ev.reason || `code ${ev.code}`}\x1b[0m\r\n`);
          return;
        }
        scheduleReconnect();
      };
      sock.onerror = () => {
        if (disposed || ws !== sock) return;
        setStatusDetail('connection failed');
        // `close` follows and drives the reconnect.
      };
    }

    const staleTimer = setInterval(() => {
      if (disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMsgAt > STALE_AFTER_MS) forceReconnect();
    }, STALE_CHECK_MS);

    function onVisible(): void {
      if (document.visibilityState !== 'visible' || disposed) return;
      // Coming back from a background tab / sleep: reconnect a dead or
      // stale socket immediately instead of waiting out the backoff.
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsgAt <= STALE_AFTER_MS) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      forceReconnect();
    }
    document.addEventListener('visibilitychange', onVisible);

    connect();

    const dataDisposable = term.onData((data: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(new TextEncoder().encode(data));
      } catch {
        /* socket closed mid-write */
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* dimensions briefly invalid during animation */
      }
    });
    ro.observe(el);

    term.focus();

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(staleTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ro.disconnect();
      dataDisposable.dispose();
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
    // attachPath is a string and bursting it triggers a reconnect —
    // intentional, the parent decides when to remount.
  }, [attachPath, busyLabel]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#0a0e15',
        position: 'relative',
      }}
    >
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          padding: 6,
        }}
      />
      {status !== 'open' && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 12,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            background:
              status === 'error' || status === 'closed' ? 'var(--danger)' : 'var(--bg-3)',
            color: status === 'error' || status === 'closed' ? '#fff' : 'var(--text-2)',
            border: '1px solid var(--line-2)',
            pointerEvents: 'none',
          }}
        >
          {status}
          {statusDetail ? ` · ${statusDetail}` : ''}
        </div>
      )}
    </div>
  );
}
