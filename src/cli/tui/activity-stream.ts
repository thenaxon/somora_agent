// Cross-agent activity stream consumer for the TUI.
//
// Lightweight standalone reader for /activity/stream. Unlike
// openStream() which yields chat-events, this one reduces straight
// into a callback because the consumer just wants to update state.
// Auto-reconnect with exponential backoff mirrors openStream so a
// transient network blip recovers transparently.

import { loopbackFetch } from '../../server/loopback-fetch.ts';

export type ActivityEvent =
  | { kind: 'streaming'; agent: string; session: string; phase: 'start' | 'end' }
  | { kind: 'turn'; agent: string; session: string; unreadAt: string }
  | { kind: 'seen'; agent: string; session: string; seenAt: string };

export interface ActivityHandle {
  close(): void;
}

const RECONNECT_INITIAL_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function openActivityStream(
  url: string,
  onEvent: (e: ActivityEvent) => void,
): ActivityHandle {
  let abort: AbortController | null = null;
  let reconnectMs = RECONNECT_INITIAL_MS;
  let closed = false;

  async function consume(): Promise<void> {
    if (closed) return;
    abort = new AbortController();
    let res: Response;
    try {
      res = await loopbackFetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: abort.signal,
      });
    } catch {
      if (abort.signal.aborted || closed) return;
      schedule();
      return;
    }
    if (!res.ok || !res.body) {
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
          if (parsed) onEvent(parsed);
        }
      }
      if (!abort.signal.aborted && !closed) schedule();
    } catch {
      if (abort.signal.aborted || closed) return;
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

  function parseFrame(raw: string): ActivityEvent | null {
    let evName = 'message';
    let dataStr = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) evName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) return null;
    let data: { agent?: string; session?: string; phase?: string; unreadAt?: string; seenAt?: string };
    try {
      data = JSON.parse(dataStr);
    } catch {
      return null;
    }
    if (!data.agent || !data.session) return null;
    switch (evName) {
      case 'streaming':
        if (data.phase === 'start' || data.phase === 'end') {
          return { kind: 'streaming', agent: data.agent, session: data.session, phase: data.phase };
        }
        return null;
      case 'turn':
        if (typeof data.unreadAt !== 'string') return null;
        return { kind: 'turn', agent: data.agent, session: data.session, unreadAt: data.unreadAt };
      case 'seen':
        if (typeof data.seenAt !== 'string') return null;
        return { kind: 'seen', agent: data.agent, session: data.session, seenAt: data.seenAt };
      default:
        return null;
    }
  }

  void consume();

  return {
    close(): void {
      closed = true;
      abort?.abort();
    },
  };
}
