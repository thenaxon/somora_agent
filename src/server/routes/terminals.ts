// Moved unchanged from src/server/index.ts, which calls registerTerminalRoutes()
// where these routes stood, so the registration order is the same.
// Names index.ts shares come in through `routeDeps`; TERMINAL_WS_DEAD_MS, TERMINAL_WS_PING_MS are read from it
// per request (index.ts sets them up later or changes them).

import type { Hono } from 'hono';
import type * as Server from '../index.ts';
import { listTmuxSessions } from '../../tmux/list.ts';
import { getTmuxOrigin } from '../../tmux/origin-store.ts';
import { logger } from '../logger.ts';
import { config } from '../server-state.ts';
import { upgradeWebSocket } from '@hono/node-server';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

export interface TerminalRoutesDeps {
  readonly TERMINAL_WS_DEAD_MS: typeof Server.TERMINAL_WS_DEAD_MS;
  readonly TERMINAL_WS_PING_MS: typeof Server.TERMINAL_WS_PING_MS;
}

export function registerTerminalRoutes(app: Hono, routeDeps: TerminalRoutesDeps): void {
  // Tmux session listing for the web tmux-app. Joins live `tmux ls`
  // output with somora's origin store. Empty list when no tmux server
  // is running — that's a normal state, not an error.
  app.get('/tmux/sessions', async (c) => {
    const sessions = await listTmuxSessions();
    return c.json({ sessions });
  });

  interface PtyWsBag {
    __pty?: { write(s: string): void; resize(cols: number, rows: number): void; kill(): void };
    __hbTimer?: ReturnType<typeof setInterval>;
    __lastSeenAt?: number;
    /** onClose ran: a PTY started after it (onOpen awaits an import or
     *  the tmux list first) is killed at once instead of living on with
     *  its heartbeat (Fable review 2026-11-10 Nr. 26). */
    __closed?: boolean;
    /** The client's size, when it arrived before the PTY was there
     *  (onOpen awaits an import or the tmux list first): applied once
     *  the PTY starts. Dropping it left the view at 80x24 for good —
     *  the client only sends again when its window changes. */
    __size?: { cols: number; rows: number };
  }

  /** Remember a resize that came before the PTY. */
  function stashEarlySize(raw: PtyWsBag | undefined, data: unknown): void {
    if (!raw || typeof data !== 'string') return;
    try {
      const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
      if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        raw.__size = { cols: Math.max(2, msg.cols), rows: Math.max(2, msg.rows) };
      }
    } catch {
      /* not a control frame */
    }
  }

  /** Give a just-started PTY the size its client sent before it existed. */
  function applyEarlySize(raw: PtyWsBag): void {
    if (raw.__pty && raw.__size) raw.__pty.resize(raw.__size.cols, raw.__size.rows);
  }

  function armTerminalHeartbeat(
    ws: { send(d: string): void; close(code?: number, reason?: string): void; raw?: unknown },
    bag: PtyWsBag,
    label: string,
  ): void {
    bag.__lastSeenAt = Date.now();
    bag.__hbTimer = setInterval(() => {
      const idle = Date.now() - (bag.__lastSeenAt ?? 0);
      if (idle > routeDeps.TERMINAL_WS_DEAD_MS) {
        logger.info({ msg: `${label}.heartbeat_timeout`, idleMs: idle });
        try {
          ws.close(4000, 'heartbeat timeout');
        } catch {
          /* already closed */
        }
        // close() needs the peer to answer the closing handshake — a dead
        // peer never does. terminate() drops the socket immediately and
        // fires onClose locally (kills the PTY, clears this timer).
        try {
          (ws.raw as { terminate?: () => void } | undefined)?.terminate?.();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        ws.send('{"type":"ping"}');
      } catch {
        /* socket closed */
      }
    }, routeDeps.TERMINAL_WS_PING_MS);
  }

  // Plain shell terminal: WebSocket bridge to a fresh `$SHELL` PTY
  // rooted in the configured workspace (`config.workspace.default`,
  // usually `~/somoraworkspace`). One terminal per WS connection —
  // closing the WS kills the shell, opening multiple windows gets you
  // multiple independent shells. No session-id concept; nothing
  // persistent to attach to.
  app.get(
    '/terminal/attach',
    upgradeWebSocket(() => {
      return {
        async onOpen(_evt, ws) {
          try {
            const pty = await import('node-pty');
            const shell = process.env.SHELL || '/bin/bash';
            const cwdRaw = config.workspace.default;
            const cwd = cwdRaw.startsWith('~/')
              ? resolvePath(homedir(), cwdRaw.slice(2))
              : resolvePath(cwdRaw);
            const term = pty.spawn(shell, [], {
              name: 'xterm-256color',
              cols: 80,
              rows: 24,
              cwd,
              env: { ...process.env, TERM: 'xterm-256color' },
            });
            term.onData((data: string) => {
              try {
                ws.send(Buffer.from(data, 'utf8'));
              } catch {
                /* socket closed */
              }
            });
            term.onExit(({ exitCode }) => {
              try {
                ws.close(1000, `shell exited (${exitCode})`);
              } catch {
                /* ignore */
              }
            });
            const raw = ws.raw as PtyWsBag | undefined;
            if (raw) {
              if (raw.__closed) {
                term.kill();
                return;
              }
              raw.__pty = term;
              applyEarlySize(raw);
              armTerminalHeartbeat(ws, raw, 'terminal.attach');
            }
            logger.info({ msg: 'terminal.attach.open', shell, cwd });
          } catch (err) {
            logger.error({
              msg: 'terminal.attach.spawn_failed',
              err: (err as Error).message,
            });
            ws.close(1011, `failed to spawn shell: ${(err as Error).message}`);
          }
        },
        onMessage(evt, ws) {
          const raw = ws.raw as PtyWsBag | undefined;
          if (raw) raw.__lastSeenAt = Date.now();
          const term = raw?.__pty;
          if (!term) {
            stashEarlySize(raw, evt.data);
            return;
          }
          const data = evt.data;
          if (typeof data === 'string') {
            // Text frame = control message (JSON): resize, or the pong
            // reply to our heartbeat ping (liveness stamped above).
            try {
              const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
              if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
                term.resize(Math.max(2, msg.cols), Math.max(2, msg.rows));
              }
            } catch {
              /* ignore */
            }
          } else if (data instanceof ArrayBuffer) {
            term.write(Buffer.from(data).toString('utf8'));
          } else if (data instanceof Uint8Array) {
            term.write(Buffer.from(data).toString('utf8'));
          } else if (Buffer.isBuffer(data)) {
            term.write((data as Buffer).toString('utf8'));
          }
        },
        onClose(_evt, ws) {
          const raw = ws.raw as PtyWsBag | undefined;
          if (raw) raw.__closed = true;
          if (raw?.__hbTimer) clearInterval(raw.__hbTimer);
          try {
            raw?.__pty?.kill();
          } catch {
            /* already dead */
          }
          logger.info({ msg: 'terminal.attach.close' });
        },
      };
    }),
  );

  // Tmux attach: WebSocket bridge to a `tmux attach-session -d -t <name>`
  // PTY. Bidirectional binary frames carry tmux's terminal stream;
  // text frames carry control messages (resize). Sessions only —
  // remote tmux is not browse-able from here yet.
  //
  // Flow:
  //   1. Client opens WSS .../tmux/attach?session=<name>
  //   2. Server spawns `tmux attach-session -d -t <name>` in a PTY
  //      sized 80×24 (refined immediately by the first resize msg)
  //   3. PTY stdout → WS binary frames
  //   4. WS binary frames → PTY stdin
  //   5. WS text frames "{type:'resize',cols,rows}" → PTY resize
  //   6. PTY exit → WS close, or WS close → kill PTY
  app.get(
    '/tmux/attach',
    upgradeWebSocket((c) => {
      const session = c.req.query('session') ?? '';
      return {
        async onOpen(_evt, ws) {
          if (!session || !/^[A-Za-z0-9_./-]+$/.test(session)) {
            ws.close(1008, 'invalid session name');
            return;
          }
          const sessions = await listTmuxSessions();
          const found = sessions.find((s) => s.name === session);
          if (!found) {
            ws.close(1008, `tmux session '${session}' not found`);
            return;
          }
          try {
            const pty = await import('node-pty');
            const term = pty.spawn(
              'tmux',
              // A session somora created holds a coding agent whose screen
              // is read: a viewer must not change its size. -f ignore-size
              // (tmux 3.2+) keeps typing and scrolling, only the size is
              // the session's own. A session made by hand follows the
              // viewer as before.
              getTmuxOrigin(session)
                ? ['attach-session', '-d', '-f', 'ignore-size', '-t', session]
                : ['attach-session', '-d', '-t', session],
              {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd: process.env.HOME,
                env: { ...process.env, TERM: 'xterm-256color' },
              },
            );
            // Which session this is: a client that sees it end can tell a
            // session started anew under the same name (new id) from the
            // same one taken over by another client.
            try {
              ws.send(JSON.stringify({ type: 'attached', sessionId: found.sessionId ?? null, createdEpoch: found.createdEpoch }));
            } catch {
              /* socket closed mid-write */
            }
            // PTY → WS. node-pty data is a string; we send as binary so
            // xterm.js decodes the bytes verbatim (tmux emits UTF-8).
            term.onData((data: string) => {
              try {
                ws.send(Buffer.from(data, 'utf8'));
              } catch {
                /* socket closed mid-write */
              }
            });
            term.onExit(({ exitCode }) => {
              try {
                ws.close(1000, `tmux exited (${exitCode})`);
              } catch {
                /* ignore */
              }
            });
            // Stash the term on the raw ws so onMessage / onClose can
            // reach it — WSContext.raw is the underlying node `ws`
            // instance (via @hono/node-server). Hand-rolled property
            // bag because hono's WSContext doesn't expose its own
            // closure scope.
            const raw = ws.raw as PtyWsBag | undefined;
            if (raw) {
              if (raw.__closed) {
                term.kill();
                return;
              }
              raw.__pty = term;
              applyEarlySize(raw);
              armTerminalHeartbeat(ws, raw, 'tmux.attach');
            }
            logger.info({ msg: 'tmux.attach.open', session });
          } catch (err) {
            logger.error({
              msg: 'tmux.attach.spawn_failed',
              session,
              err: (err as Error).message,
            });
            ws.close(1011, `failed to spawn tmux: ${(err as Error).message}`);
          }
        },
        onMessage(evt, ws) {
          const raw = ws.raw as PtyWsBag | undefined;
          if (raw) raw.__lastSeenAt = Date.now();
          const term = raw?.__pty;
          if (!term) {
            stashEarlySize(raw, evt.data);
            return;
          }
          const data = evt.data;
          if (typeof data === 'string') {
            // Text frame = control message (JSON): resize, or the pong
            // reply to our heartbeat ping (liveness stamped above).
            try {
              const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
              if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
                term.resize(Math.max(2, msg.cols), Math.max(2, msg.rows));
              }
            } catch {
              // unparseable text → ignore; binary path handles real input
            }
          } else if (data instanceof ArrayBuffer) {
            term.write(Buffer.from(data).toString('utf8'));
          } else if (data instanceof Uint8Array) {
            term.write(Buffer.from(data).toString('utf8'));
          } else if (Buffer.isBuffer(data)) {
            term.write((data as Buffer).toString('utf8'));
          }
        },
        onClose(_evt, ws) {
          const raw = ws.raw as PtyWsBag | undefined;
          if (raw) raw.__closed = true;
          if (raw?.__hbTimer) clearInterval(raw.__hbTimer);
          try {
            raw?.__pty?.kill();
          } catch {
            /* already dead */
          }
          logger.info({ msg: 'tmux.attach.close', session });
        },
      };
    }),
  );
}
