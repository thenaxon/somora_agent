// Loopback fetch for somora's in-process A2A / spawn / status calls
// back into its own HTTPS server.
//
// The plain global fetch() picks undici's default Agent, whose
// headersTimeout and bodyTimeout are both 5 min. Long A2A turns (up to
// agentLoop.longTaskMaxTimeoutMs = 30 min) outlive that and get killed
// by undici as `TypeError: fetch failed` (cause: UND_ERR_BODY_TIMEOUT
// or UND_ERR_HEADERS_TIMEOUT) — visible from the caller as the same
// opaque `fetch failed` message regardless of the underlying class.
//
// Before HTTPS migration the server was plain HTTP/1.1 over loopback,
// and pre-h2 sockets had similar caps but the failure surface was
// different — keepalive kept the connection warm and stale-pool
// recovery hid the timeout. With HTTP/2-over-TLS to a Tailscale
// hostname, the connection is a real cross-process TCP+TLS one and
// undici's defaults bite in.
//
// Fix: dedicated undici Agent with timeouts disabled for loopback,
// plus an error classifier so callers can surface useful diagnostics
// instead of the bare `fetch failed`.

import { Agent, fetch as undiciFetch } from 'undici';

let dispatcher: Agent | undefined;

function getDispatcher(): Agent {
  if (!dispatcher) {
    dispatcher = new Agent({
      // 0 disables the timeout entirely. Caller-side AbortControllers
      // (ask.ts, status.ts) remain the source of truth for "how long".
      headersTimeout: 0,
      bodyTimeout: 0,
      // Keep-alive so we don't repay TLS handshake on every loopback
      // call. h2 multiplexes streams over one session anyway, but the
      // h1 fallback path benefits.
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 600_000,
    });
  }
  return dispatcher;
}

export async function loopbackFetch(url: string, init?: RequestInit): Promise<Response> {
  // undici's RequestInit accepts `dispatcher`; node's lib.dom types
  // don't expose it, so cast through.
  const withDispatcher = { ...(init ?? {}), dispatcher: getDispatcher() } as Parameters<
    typeof undiciFetch
  >[1];
  // undici's Response is structurally compatible with the global one
  // for our usage (ok, status, text, json). Cast for the rest of the
  // codebase which expects DOM-typed Response.
  return undiciFetch(url, withDispatcher) as unknown as Response;
}

export type A2AErrorCategory =
  | 'transport'
  | 'timeout'
  | 'aborted'
  | 'target-busy'
  | 'tls'
  | 'unknown';

export interface ClassifiedFetchError {
  category: A2AErrorCategory;
  code?: string;
  message: string;
  hint?: string;
}

export function classifyFetchError(err: unknown): ClassifiedFetchError {
  if (err instanceof Error && err.name === 'AbortError') {
    return { category: 'aborted', message: err.message };
  }
  const e = err as {
    name?: string;
    message?: string;
    code?: string;
    cause?: { code?: string; message?: string };
  };
  const code = e.cause?.code ?? e.code;
  const causeMsg = e.cause?.message;
  const baseMsg = e.message ?? 'fetch failed';
  const fullMsg = `${baseMsg}${causeMsg ? ` (cause: ${causeMsg})` : ''}${code ? ` [${code}]` : ''}`;

  switch (code) {
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'UND_ERR_REQ_TIMEOUT':
      return {
        category: 'timeout',
        code,
        message: fullMsg,
        hint:
          'undici client-side timeout. If this happens for legitimately long A2A turns, the ' +
          'loopback dispatcher should already disable headers/bodyTimeout — check ' +
          'src/server/loopback-fetch.ts',
      };
    case 'UND_ERR_SOCKET':
    case 'ECONNRESET':
    case 'EPIPE':
      return {
        category: 'transport',
        code,
        message: fullMsg,
        hint:
          'connection dropped by server (likely h2 session/idle timeout, GOAWAY frame, or ' +
          'process restart). Check server-side Http2Server timeouts in src/server/index.ts.',
      };
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
      return {
        category: 'transport',
        code,
        message: fullMsg,
        hint: 'target unreachable — server down, port wrong, or DNS broken.',
      };
    case 'EPROTO':
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return {
        category: 'tls',
        code,
        message: fullMsg,
        hint: 'TLS handshake failed — check Tailscale cert validity and SOMORA_HOST hostname.',
      };
    default:
      return { category: 'unknown', code, message: fullMsg };
  }
}
