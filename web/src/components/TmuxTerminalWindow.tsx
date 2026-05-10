// xterm.js attached to a `tmux attach-session -d -t <name>` PTY via
// our /tmux/attach WebSocket bridge. Phase 1.5.
//
// Layout: the terminal fills the full window body. PTY → WS frames
// arrive as binary Buffer payloads (UTF-8 bytes); we feed them to
// xterm.term.write directly. Keystrokes from xterm fire onData →
// we send back as binary frames. Window resize fires via FitAddon
// → cols/rows → text frame "{type:'resize',cols,rows}" so the PTY
// follows the visible terminal grid.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  /** Tmux session name to attach to. Comes from the list-window's
   *  click handler via the window manager. */
  tmuxName: string;
}

export function TmuxTerminalWindow({ tmuxName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>(
    'connecting',
  );
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

    // Build a wss:// URL relative to the page origin so we work both
    // through vite's proxy (with ws:true) and against the somora
    // server directly.
    const origin = window.location.origin;
    const wsOrigin = origin.replace(/^http/, 'ws');
    const url = `${wsOrigin}/tmux/attach?session=${encodeURIComponent(tmuxName)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    function sendResize(): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }),
        );
      } catch {
        /* socket closed mid-write */
      }
    }

    ws.addEventListener('open', () => {
      setStatus('open');
      setStatusDetail(null);
      // First resize immediately so the PTY matches the visible grid
      // instead of staying at the default 80×24.
      sendResize();
    });
    ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        term.write(new Uint8Array(data));
      } else if (typeof data === 'string') {
        term.write(data);
      }
    });
    ws.addEventListener('close', (ev) => {
      setStatus('closed');
      setStatusDetail(ev.reason || `code ${ev.code}`);
      term.write(`\r\n\x1b[33m[somora] tmux attach closed: ${ev.reason || `code ${ev.code}`}\x1b[0m\r\n`);
    });
    ws.addEventListener('error', () => {
      setStatus('error');
      setStatusDetail('connection failed');
    });

    const dataDisposable = term.onData((data: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(new TextEncoder().encode(data));
      } catch {
        /* socket closed mid-write */
      }
    });

    // ResizeObserver fires when the surrounding window is dragged
    // bigger / smaller. We refit xterm to the new container size and
    // forward the new cols/rows to the PTY.
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
      ro.disconnect();
      dataDisposable.dispose();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [tmuxName]);

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
              status === 'error' || status === 'closed'
                ? 'var(--danger)'
                : 'var(--bg-3)',
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
