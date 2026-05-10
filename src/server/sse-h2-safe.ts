// HTTP/2-safe SSE helper. Hono's built-in streamSSE() unconditionally
// sets `Transfer-Encoding: chunked` and `Connection: keep-alive` —
// both forbidden in HTTP/2, so the @hono/node-server adapter throws
// `ERR_HTTP2_INVALID_CONNECTION_HEADERS` at writeHead time and the
// connection dies before any event reaches the client.
//
// This wrapper mirrors Hono's streamSSE() shape (so call-sites stay
// identical) but only sets the SSE-essential headers: Content-Type
// and Cache-Control. Headers that HTTP/2 forbids are left out;
// HTTP/1.1 clients still see correct semantics because the
// underlying Node response writer adds Transfer-Encoding: chunked
// automatically when no Content-Length is set.

import type { Context } from 'hono';
import { SSEStreamingApi } from 'hono/streaming';

interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export function streamSSEH2Safe(
  c: Context,
  cb: (stream: { writeSSE: (m: SSEMessage) => Promise<void>; close: () => void; closed: boolean; onAbort: (h: () => void) => void }) => Promise<void>,
): Response {
  const { readable, writable } = new TransformStream();
  const stream = new SSEStreamingApi(writable, readable);

  // Match Hono's streamSSE flow but skip Transfer-Encoding /
  // Connection. The adapter's chunked path is only triggered when
  // Transfer-Encoding is set, so omitting it routes us through the
  // streaming-without-chunked branch — which is HTTP/2-clean.
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('X-Accel-Buffering', 'no');

  // Run the user-supplied callback in the background — same pattern
  // as Hono's streamSSE. Errors get logged, the stream closes either
  // way so the client's EventSource sees a clean EOF.
  void (async () => {
    try {
      await cb({
        writeSSE: (m) => stream.writeSSE(m),
        close: () => stream.close(),
        get closed() {
          return stream.closed;
        },
        onAbort: (h) => stream.onAbort(h),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[somora-sse]', err);
    } finally {
      stream.close();
    }
  })();

  return c.body(stream.responseReadable);
}
