// Single SSE subscription for the active agent's main session. Auto-
// unsubscribes when the agent changes and resubscribes to the new one.
// Loads history on agent-switch so the chat surface shows the existing
// conversation immediately, then streams new events on top.
//
// SSE event protocol (must match what the server's createTurnSerializer
// + run-turn.ts publish() actually emit — see ChatProvider in web/ for
// the desktop equivalent):
//   - 'chat' { state: 'delta', text }  — running cumulative text
//   - 'chat' { state: 'final', text }  — final assistant text for the turn
//   - 'agent' { phase: 'start'|'end', usage?: ... } — turn lifecycle
//   - 'status' { msg }                  — error / connection messages
//   - 'tool' { phase, tool, summary }   — tool call/result (ignored in
//                                          default mobile view)
//   - 'memory' { ... }                  — memory inject (ignored by default)
//   - 'project' ...                     — project pin (ignored by mobile)
//
// User-message events are NOT broadcast over SSE — the user knows what
// they sent (we add it optimistically client-side on send() success).

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
}

export interface ChatStream {
  messages: ChatMessage[];
  /** True from the moment the user sends until the server emits
   *  agent.phase='end'. */
  streaming: boolean;
  /** Send a user message via POST /chat/send. Optimistically appends
   *  to local messages so the bubble shows up without waiting for
   *  the server. */
  send: (text: string) => Promise<void>;
  /** Last connection error if the SSE link dropped. Null when healthy. */
  connectionError: string | null;
}

let msgIdCounter = 0;
function newId(prefix: string): string {
  msgIdCounter++;
  return `${prefix}-${Date.now()}-${msgIdCounter}`;
}

export function useChatStream(agent: string | null): ChatStream {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  // Track the currently-streaming agent message id outside React state
  // so successive deltas can find it without re-render races.
  const streamingIdRef = useRef<string | null>(null);
  const agentRef = useRef<string | null>(agent);

  useEffect(() => {
    agentRef.current = agent;
    if (!agent) return;

    let cancelled = false;
    setMessages([]);
    setStreaming(false);
    setConnectionError(null);
    streamingIdRef.current = null;

    // 1. Hydrate from /chat/history (most-recent N events).
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

    const onOpen = () => {
      if (cancelled) return;
      setConnectionError(null);
    };
    const onError = () => {
      if (cancelled) return;
      setConnectionError('Verbindung wackelt — versuche neu zu verbinden…');
    };

    const onChat = (e: MessageEvent) => {
      let d: { state?: string; text?: string } | null = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || typeof d.text !== 'string') return;
      const text = d.text;

      if (d.state === 'delta') {
        let id = streamingIdRef.current;
        if (!id) {
          id = newId('a');
          streamingIdRef.current = id;
        }
        const trackedId = id;
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== trackedId);
          return [
            ...filtered,
            { id: trackedId, role: 'agent', ts: Date.now(), text, streaming: true },
          ];
        });
      } else if (d.state === 'final') {
        const id = streamingIdRef.current ?? newId('a');
        streamingIdRef.current = null;
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== id);
          return [
            ...filtered,
            { id, role: 'agent', ts: Date.now(), text },
          ];
        });
      }
    };

    const onAgent = (e: MessageEvent) => {
      let d: { phase?: string } | null = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d) return;
      if (d.phase === 'start') {
        setStreaming(true);
      } else if (d.phase === 'end') {
        setStreaming(false);
        streamingIdRef.current = null;
      }
    };

    const onStatus = (e: MessageEvent) => {
      let d: { msg?: string } | null = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || !d.msg) return;
      if (d.msg.startsWith('error') || d.msg.startsWith('turn failed')) {
        setConnectionError(d.msg);
        setStreaming(false);
        streamingIdRef.current = null;
      }
    };

    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    es.addEventListener('chat', onChat);
    es.addEventListener('agent', onAgent);
    es.addEventListener('status', onStatus);

    return () => {
      cancelled = true;
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.removeEventListener('chat', onChat);
      es.removeEventListener('agent', onAgent);
      es.removeEventListener('status', onStatus);
      es.close();
    };
  }, [agent]);

  const send = async (text: string) => {
    if (!agent) return;
    // Optimistically add the user's message so the bubble appears
    // instantly — the server doesn't broadcast user_message back to
    // SSE subscribers, so without this the message would only show
    // up on the next history-reload.
    const userMsg: ChatMessage = {
      id: newId('u'),
      role: 'user',
      ts: Date.now(),
      text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    try {
      await fetch('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, session: 'main', text }),
      });
    } catch (err) {
      console.warn('[somora-mobile] /chat/send failed:', err);
      setStreaming(false);
    }
  };

  return { messages, streaming, send, connectionError };
}

function eventToMessage(ev: HistoryEvent): ChatMessage | null {
  if (ev.kind === 'user_message') {
    return {
      id: `u-${ev.ts ?? 0}-${msgIdCounter++}`,
      role: 'user',
      text: ev.text ?? '',
      ts: ev.ts ?? 0,
    };
  }
  if (ev.kind === 'assistant_message') {
    return {
      id: `a-${ev.ts ?? 0}-${msgIdCounter++}`,
      role: 'agent',
      text: ev.text ?? '',
      ts: ev.ts ?? 0,
    };
  }
  return null;
}
