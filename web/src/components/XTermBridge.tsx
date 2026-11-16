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
  /** After the server closed the terminal on purpose (the tmux session
   *  ended or does not exist), ask every few seconds whether it is back
   *  and attach again when it is — an agent's session started anew
   *  under the same name shows up in the window that is still open.
   *  Without it a closed terminal stays closed (a plain shell). */
  isBack?: () => Promise<boolean>;
  /** Called when the server confirms the attach, with what it sent
   *  (tmux: `{type:'attached', sessionId, createdEpoch}`). */
  onAttached?: (msg: Record<string, unknown>) => void;
}

/** How often a closed terminal asks whether its session is back. */
const BACK_CHECK_MS = 3_000;

/** The terminal's font size, and the range used to fit a session of a
 *  fixed size into its window. */
const DEFAULT_FONT = 13;
const MIN_FONT = 5;
const MAX_FIXED_FONT = 16;

type Status = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

// Server pings every 25s; two missed pings + slack = stale. Checked
// on a 10s tick and immediately when the tab becomes visible again.
const STALE_AFTER_MS = 60_000;
const STALE_CHECK_MS = 10_000;
const RECONNECT_MAX_DELAY_MS = 15_000;

export function XTermBridge({ attachPath, busyLabel = 'terminal', isBack, onAttached }: Props) {
  // A ref, so a new function each render does not reconnect the terminal.
  const isBackRef = useRef(isBack);
  isBackRef.current = isBack;
  const onAttachedRef = useRef(onAttached);
  onAttachedRef.current = onAttached;
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [statusDetail, setStatusDetail] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: DEFAULT_FONT,
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

    // A session with a size of its own (an agent's session somora
    // created): show all of it — exactly its columns and rows, with the
    // font made as large as the window allows — instead of a cut-out.
    // null: the terminal follows the window (fit).
    let fixed: { cols: number; rows: number } | null = null;

    /** Font size at which `fixed` fills the box without spilling. */
    function fitFont(): void {
      if (!fixed) return;
      const screen = el!.querySelector('.xterm-screen') as HTMLElement | null;
      const box = el!.getBoundingClientRect();
      const style = getComputedStyle(el!);
      const w = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const h = box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (!screen || w <= 0 || h <= 0) return;
      const now = term.options.fontSize ?? DEFAULT_FONT;
      const r = screen.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // Cell size scales with the font: one measurement gives the factor.
      const next = Math.floor(Math.min((now * w) / r.width, (now * h) / r.height) * 4) / 4;
      const size = Math.max(MIN_FONT, Math.min(MAX_FIXED_FONT, next));
      if (Math.abs(size - now) >= 0.25) term.options.fontSize = size;
    }

    function layout(): void {
      // Below the smallest font the session no longer fits: the window
      // scrolls instead of hiding the rest.
      el!.style.overflow = fixed ? 'auto' : '';
      if (fixed) {
        if (term.cols !== fixed.cols || term.rows !== fixed.rows) term.resize(fixed.cols, fixed.rows);
        fitFont();
        // Rounding of the cell size: measure once more after the paint.
        requestAnimationFrame(() => {
          if (!disposed) fitFont();
        });
      } else {
        if ((term.options.fontSize ?? DEFAULT_FONT) !== DEFAULT_FONT) term.options.fontSize = DEFAULT_FONT;
        fit.fit();
      }
    }

    const wsOrigin = window.location.origin.replace(/^http/, 'ws');
    const url = `${wsOrigin}${attachPath}`;

    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backTimer: ReturnType<typeof setInterval> | null = null;

    /** Closed on purpose: wait for the session to come back, then
     *  attach again on a clean screen. */
    function waitForReturn(): void {
      if (disposed || backTimer || !isBackRef.current) return;
      let asking = false;
      backTimer = setInterval(() => {
        const check = isBackRef.current;
        if (disposed || asking || !check) return;
        asking = true;
        check()
          .then((back) => {
            if (!back || disposed || !backTimer) return;
            clearInterval(backTimer);
            backTimer = null;
            term.reset();
            setStatus('connecting');
            setStatusDetail(null);
            connect();
          })
          .catch(() => {
            /* server unreachable — ask again next time */
          })
          .finally(() => {
            asking = false;
          });
      }, BACK_CHECK_MS);
    }
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
        // Connected — whatever path got here, stop waiting for a return.
        if (backTimer) {
          clearInterval(backTimer);
          backTimer = null;
        }
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
            const msg = JSON.parse(data) as { type?: string } & Record<string, unknown>;
            if (msg.type === 'attached') {
              onAttachedRef.current?.(msg);
              const cols = Number(msg.fixedCols);
              const rows = Number(msg.fixedRows);
              fixed = cols >= 2 && rows >= 2 ? { cols, rows } : null;
              layout();
              // The server's terminal exists now: send the size again in
              // case the first one beat it (older servers dropped it).
              sendResize();
            }
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
          if (isBackRef.current) {
            term.write(`\x1b[33m[somora] attaches again when the session is started anew…\x1b[0m\r\n`);
            waitForReturn();
          }
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
      // Closed on purpose and waiting for the session's return: that
      // wait decides when to attach (attaching now could take the
      // session from the client that took it over).
      if (backTimer) return;
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
        layout();
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
      if (backTimer) clearInterval(backTimer);
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
