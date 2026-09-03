// Liveness for SSE streams and the transport under them.
//
// Report 2026-09-03 ("16 zombie streams after 25 minutes"): a browser
// on jittery WLAN drops off without a FIN/RST, the h2 session had
// `sessionTimeout: 0` (deliberately — long A2A turns must not be cut),
// no TCP keepalive was set (kernel default: first probe after 2 h),
// and a heartbeat write that never completes was only debug-logged.
// So /chat/stream subscribers of dead tabs stayed registered until
// the next restart, publish() kept writing into them, and the
// sse.connect/disconnect log could not tell who was still there.
//
// Three layers, mirroring what the tmux WebSockets already had:
//  1. h2 PING per session on an interval; no ACK within the timeout →
//     the session is destroyed, every stream on it aborts, the normal
//     disconnect path runs. Independent of socket buffers, so a
//     silent peer is caught in ~interval + timeout.
//  2. TCP keepalive on every accepted socket (belt and braces, and the
//     only signal for HTTP/1.1 clients that send nothing).
//  3. Heartbeat writes are watched: a write that rejects or does not
//     resolve within `deadAfterMs` marks the stream dead → the handler
//     tears it down and destroys the socket.

import type { Server as HttpServer } from 'node:http';
import type { Http2SecureServer, Http2Server, ServerHttp2Session } from 'node:http2';
import type { Socket } from 'node:net';
import type { Context } from 'hono';
import { logger } from './logger.ts';

export interface SseWriter {
  writeSSE: (m: { event?: string; data: string }) => Promise<void>;
}

export interface HeartbeatOptions {
  intervalMs: number;
  /** A heartbeat write still pending after this long marks the stream dead. */
  deadAfterMs: number;
  onDead: (reason: 'write_timeout' | 'write_error', detail?: string) => void;
  /** Injectable clock/timers for tests. */
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * Start the heartbeat and watch each write. Returns a stop function.
 * Only the FIRST dead verdict is reported; the caller stops the
 * heartbeat from its teardown.
 */
export function startSseHeartbeat(stream: SseWriter, opts: HeartbeatOptions): () => void {
  const now = opts.now ?? Date.now;
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? clearInterval;
  let pendingSince: number | null = null;
  let reported = false;
  let stopped = false;
  const dead = (reason: 'write_timeout' | 'write_error', detail?: string) => {
    if (reported || stopped) return;
    reported = true;
    opts.onDead(reason, detail);
  };
  const timer = setI(() => {
    if (stopped) return;
    if (pendingSince !== null) {
      if (now() - pendingSince >= opts.deadAfterMs) dead('write_timeout', `heartbeat write pending ${now() - pendingSince} ms`);
      return; // don't stack writes on a stalled stream
    }
    pendingSince = now();
    stream
      .writeSSE({ event: 'heartbeat', data: String(now()) })
      .then(() => {
        pendingSince = null;
      })
      .catch((err) => {
        pendingSince = null;
        dead('write_error', String(err));
      });
  }, opts.intervalMs);
  return () => {
    stopped = true;
    clearI(timer);
  };
}

/** Remote peer of the request behind a Hono context (node adapter). */
export function remoteOf(c: Context): { ip: string; port: number } | null {
  const env = c.env as { incoming?: { socket?: Socket } } | undefined;
  const s = env?.incoming?.socket;
  if (!s || !s.remoteAddress) return null;
  return { ip: s.remoteAddress.replace(/^::ffff:/, ''), port: s.remotePort ?? 0 };
}

/** Destroy the socket under a Hono request — used when a stream is
 *  declared dead so the kernel buffers stop absorbing writes. */
export function destroySocketOf(c: Context): void {
  const env = c.env as { incoming?: { socket?: Socket } } | undefined;
  try {
    env?.incoming?.socket?.destroy();
  } catch {
    /* already gone */
  }
}

export interface TransportLivenessOptions {
  keepAliveDelayMs: number;
  h2PingIntervalMs: number;
  h2PingTimeoutMs: number;
}

/**
 * TCP keepalive on every accepted socket; for an HTTP/2 server
 * additionally a PING per session with a timeout. Returns a summary
 * for the start log.
 */
export function installTransportLiveness(
  server: HttpServer | Http2Server | Http2SecureServer,
  opts: TransportLivenessOptions,
): { keepAlive: boolean; h2Ping: boolean } {
  (server as HttpServer).on('connection', (socket: Socket) => {
    try {
      socket.setKeepAlive(true, opts.keepAliveDelayMs);
    } catch {
      /* not a TCP socket */
    }
  });
  const isH2 = 'updateSettings' in server;
  if (!isH2) return { keepAlive: true, h2Ping: false };
  (server as Http2SecureServer).on('session', (session: ServerHttp2Session) => {
    const remote = session.socket?.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
    let pending: ReturnType<typeof setTimeout> | null = null;
    const timer = setInterval(() => {
      if (session.destroyed || session.closed) return;
      if (pending) return; // previous ping still outstanding — its timeout decides
      pending = setTimeout(() => {
        pending = null;
        logger.info({ msg: 'transport.h2_session_dead', remote, hint: `no PING ack within ${opts.h2PingTimeoutMs} ms — destroying session, its SSE streams disconnect` });
        session.destroy();
      }, opts.h2PingTimeoutMs);
      try {
        const ok = session.ping((err) => {
          if (pending) clearTimeout(pending);
          pending = null;
          if (err) logger.debug({ msg: 'transport.h2_ping_error', remote, err: String(err) });
        });
        if (!ok) {
          // ping queue full — treat as pending until the timeout fires
        }
      } catch (err) {
        if (pending) clearTimeout(pending);
        pending = null;
        logger.debug({ msg: 'transport.h2_ping_error', remote, err: String(err) });
      }
    }, opts.h2PingIntervalMs);
    const cleanup = () => {
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      pending = null;
    };
    session.once('close', cleanup);
    session.once('error', cleanup);
  });
  return { keepAlive: true, h2Ping: true };
}
