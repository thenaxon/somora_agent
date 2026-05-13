// SSE consumer for /chat/stream. Yields normalized StreamEvent values via
// an async iterator so the React side can pull events with a simple for-await
// loop. Auto-reconnect with exponential backoff lives here too.
//
// Uses loopbackFetch so undici's default 5-min headersTimeout doesn't
// kill the initial response wait when the server takes a while to flush
// the first SSE frame (slow models, busy session lock, etc.). Body
// streaming is chunk-based and doesn't have an undici body timeout.

import { loopbackFetch } from '../../server/loopback-fetch.ts';
import type { StreamEvent } from './types.ts';

export interface StreamHandle {
  events: AsyncIterable<StreamEvent>;
  close(): void;
}

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function openStream(
  url: string,
  onNotice: (text: string, tone: 'info' | 'warn' | 'error') => void,
): StreamHandle {
  let abort: AbortController | null = null;
  let reconnectMs = RECONNECT_INITIAL_MS;
  let closed = false;

  // Promise-queue async iterator: we push events as they arrive, consumer
  // pulls via `for await`. Resolves the next pending promise when we have an
  // event ready, or buffers if no consumer is waiting yet.
  const queue: StreamEvent[] = [];
  const waiters: Array<(e: IteratorResult<StreamEvent>) => void> = [];

  function push(e: StreamEvent): void {
    if (closed) return;
    const w = waiters.shift();
    if (w) w({ value: e, done: false });
    else queue.push(e);
  }
  function resolveDone(): void {
    closed = true;
    while (waiters.length) {
      const w = waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  }

  const events: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<StreamEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  async function consume(): Promise<void> {
    if (closed) return;
    abort = new AbortController();
    let res: Response;
    try {
      res = await loopbackFetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: abort.signal,
      });
    } catch (err) {
      if (abort.signal.aborted || closed) return;
      onNotice(`stream-connect failed: ${(err as Error).message} — retry in ${reconnectMs}ms`, 'warn');
      schedule();
      return;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      // 4xx means "won't be fixed by retrying" (unknown agent/session,
      // bad query, etc). Surface it once and stop reconnecting; the user
      // can switch to a valid target. 5xx + transport errors keep the
      // backoff loop because those are typically transient.
      if (res.status >= 400 && res.status < 500) {
        onNotice(`stream-connect ${res.status}: ${body} — giving up; switch with /agent or /session`, 'error');
        resolveDone();
        return;
      }
      onNotice(`stream-connect ${res.status}: ${body}`, 'error');
      schedule();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const parsed = parseFrame(raw);
          if (parsed) push(parsed);
        }
      }
      if (!abort.signal.aborted && !closed) {
        onNotice(`stream closed by server — reconnect in ${reconnectMs}ms`, 'warn');
        schedule();
      }
    } catch (err) {
      if (abort.signal.aborted || closed) return;
      onNotice(`stream error: ${(err as Error).message} — reconnect in ${reconnectMs}ms`, 'warn');
      schedule();
    }
  }

  function schedule(): void {
    const delay = reconnectMs;
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
    setTimeout(() => {
      if (closed) return;
      void consume();
    }, delay);
  }

  function parseFrame(raw: string): StreamEvent | null {
    let evName = 'message';
    let dataStr = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) evName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return null;
    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return null;
    }
    switch (evName) {
      case 'chat':
        if (data.state === 'delta') return { kind: 'chat-delta', text: data.text };
        if (data.state === 'final') return { kind: 'chat-final', text: data.text };
        return null;
      case 'agent':
        if (data.phase === 'start') {
          return {
            kind: 'agent-start',
            thinking:
              data.thinking && typeof data.thinking === 'object'
                ? {
                    level: data.thinking.level,
                    active: Boolean(data.thinking.active),
                  }
                : undefined,
          };
        }
        if (data.phase === 'end') {
          return {
            kind: 'agent-end',
            usage: data.usage,
            contextWindow: data.contextWindow,
            provider: data.provider,
            model: data.model,
            thinking:
              data.thinking && typeof data.thinking === 'object'
                ? {
                    level: data.thinking.level,
                    active: Boolean(data.thinking.active),
                  }
                : undefined,
          };
        }
        return null;
      case 'memory':
        return {
          kind: 'memory',
          count: data.count ?? 0,
          topScore: typeof data.topScore === 'number' ? data.topScore : null,
          refs: Array.isArray(data.refs) ? data.refs : [],
          fullText: typeof data.fullText === 'string' ? data.fullText : undefined,
        };
      case 'tool':
        return {
          kind: 'tool',
          tool: data.tool ?? '',
          phase: data.phase ?? '?',
          summary: typeof data.summary === 'string' ? data.summary : undefined,
          error: typeof data.error === 'string' ? data.error : undefined,
          details: typeof data.details === 'string' ? data.details : undefined,
        };
      case 'status':
        if (data.msg === 'connected') {
          reconnectMs = RECONNECT_INITIAL_MS;
          return { kind: 'connected' };
        }
        return null;
      case 'user_message':
        if (typeof data.text !== 'string') return null;
        return {
          kind: 'user-message',
          text: data.text,
          // from_agent is optional — server now echoes self-typed
          // turns too so other clients (web tab, TUI tail) see
          // them live. Self-echoes carry no from_agent; consumer
          // dedupes by recent-text against its own optimistic copy.
          ...(typeof data.from_agent === 'string' ? { fromAgent: data.from_agent } : {}),
          callId: typeof data.agent_ask_call_id === 'string' ? data.agent_ask_call_id : undefined,
        };
      case 'project':
        return {
          kind: 'project',
          from: typeof data.from === 'string' ? data.from : null,
          to: typeof data.to === 'string' ? data.to : null,
          via: data.via === 'tool' ? 'tool' : 'slash_command',
        };
      default:
        return null;
    }
  }

  void consume();

  return {
    events,
    close() {
      closed = true;
      if (abort) abort.abort();
      resolveDone();
    },
  };
}
