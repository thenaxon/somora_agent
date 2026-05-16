// Single SSE subscription for the active agent's main session. Auto-
// unsubscribes when the agent changes and resubscribes to the new one.
// Loads history on agent-switch so the chat surface shows the existing
// conversation immediately, then streams new events on top.
//
// Mobile-data-friendly: at most one open SSE connection per app instance.
// When the app is backgrounded the browser may pause the EventSource,
// resuming it on foreground (we don't try to "catch up" missed events
// — the next history fetch on agent-switch picks them up naturally,
// and within a session the message stream is idempotent enough that
// minor drops are acceptable).

import { useEffect, useRef, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
  /** True while the agent's response is still streaming. */
  streaming?: boolean;
}

interface HistoryEvent {
  kind: string;
  ts?: number;
  text?: string;
  callId?: string;
  tool?: string;
  // tool_result + others — we discard for mobile-default view
}

export interface ChatStream {
  messages: ChatMessage[];
  /** Currently streaming an agent reply? */
  streaming: boolean;
  /** Send a user message via POST /chat/send. The streamed reply lands
   *  back over the SSE subscription. */
  send: (text: string) => Promise<void>;
  /** Last connection error if the SSE link dropped. Null when healthy. */
  connectionError: string | null;
}

export function useChatStream(agent: string | null): ChatStream {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const streamingRef = useRef<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!agent) return;

    let cancelled = false;
    setMessages([]);
    setStreaming(false);
    streamingRef.current = null;

    // 1. Hydrate from /chat/history (most-recent N events). Server
    //    paginates; for mobile we just take the default tail and trust
    //    it's enough — long-history scroll-back can be a future polish.
    void fetch(
      `/chat/history?agent=${encodeURIComponent(agent)}&session=main`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { events?: HistoryEvent[] };
        if (cancelled) return;
        const hydrated = (body.events ?? [])
          .map(eventToMessage)
          .filter((m): m is ChatMessage => m !== null);
        setMessages(hydrated);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[somora-mobile] history load failed:', err);
      });

    // 2. Subscribe to SSE for live events.
    const url = `/chat/stream?agent=${encodeURIComponent(agent)}&session=main`;
    const es = new EventSource(url);

    es.addEventListener('open', () => {
      if (cancelled) return;
      setConnectionError(null);
    });

    es.addEventListener('error', () => {
      if (cancelled) return;
      // EventSource auto-reconnects; surface only if it stays down by
      // setting connectionError. Browser's default is to retry every
      // few seconds, which is fine over Tailscale.
      setConnectionError('Verbindung wackelt — versuche neu zu verbinden…');
    });

    const handleEvent = (kind: string, data: string) => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!parsed) return;

      if (kind === 'user_message') {
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now();
        setMessages((prev) => [
          ...prev,
          { id: `u-${ts}-${Math.random().toString(36).slice(2, 6)}`, role: 'user', text, ts },
        ]);
        return;
      }

      if (kind === 'assistant_delta') {
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now();
        const cur = streamingRef.current;
        if (!cur) {
          const id = `a-${ts}-${Math.random().toString(36).slice(2, 6)}`;
          streamingRef.current = { id, text };
          setStreaming(true);
          setMessages((prev) => [
            ...prev,
            { id, role: 'agent', text, ts, streaming: true },
          ]);
        } else {
          cur.text = text;
          setMessages((prev) =>
            prev.map((m) => (m.id === cur.id ? { ...m, text } : m)),
          );
        }
        return;
      }

      if (kind === 'assistant_message') {
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now();
        const cur = streamingRef.current;
        if (cur) {
          // Flatten the streaming bubble into the final message
          setMessages((prev) =>
            prev.map((m) =>
              m.id === cur.id ? { ...m, text, streaming: false } : m,
            ),
          );
          streamingRef.current = null;
        } else {
          setMessages((prev) => [
            ...prev,
            { id: `a-${ts}-${Math.random().toString(36).slice(2, 6)}`, role: 'agent', text, ts },
          ]);
        }
        return;
      }

      if (kind === 'turn_end') {
        const cur = streamingRef.current;
        if (cur) {
          setMessages((prev) =>
            prev.map((m) => (m.id === cur.id ? { ...m, streaming: false } : m)),
          );
          streamingRef.current = null;
        }
        setStreaming(false);
      }
    };

    const handlers = ['user_message', 'assistant_delta', 'assistant_message', 'turn_end'];
    const listeners = handlers.map((kind) => {
      const fn = (e: MessageEvent) => handleEvent(kind, e.data);
      es.addEventListener(kind, fn);
      return [kind, fn] as const;
    });

    return () => {
      cancelled = true;
      for (const [kind, fn] of listeners) es.removeEventListener(kind, fn);
      es.close();
    };
  }, [agent]);

  const send = async (text: string) => {
    if (!agent) return;
    await fetch('/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, session: 'main', text }),
    });
  };

  return { messages, streaming, send, connectionError };
}

function eventToMessage(ev: HistoryEvent): ChatMessage | null {
  if (ev.kind === 'user_message') {
    return {
      id: `u-${ev.ts ?? 0}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'user',
      text: ev.text ?? '',
      ts: ev.ts ?? 0,
    };
  }
  if (ev.kind === 'assistant_message') {
    return {
      id: `a-${ev.ts ?? 0}-${Math.random().toString(36).slice(2, 6)}`,
      role: 'agent',
      text: ev.text ?? '',
      ts: ev.ts ?? 0,
    };
  }
  return null;
}
