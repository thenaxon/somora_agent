// Per-session chat state. Owns the message list, the SSE
// subscription, the streaming/thinking flags, the running token
// snapshot, and the most recent memory-inject hit set.
//
// Architecture:
//   1. On (agent, session) change: clear state, fetch history,
//      open EventSource at /chat/stream?agent=&session=. History
//      and SSE race silently — events from the stream that
//      duplicate history events are de-duped by ts+kind.
//   2. Message list mutations are immutable so React's memo on
//      MessageItem cuts re-renders during streaming to O(1).
//   3. Streaming assistant text accumulates via chat-delta events;
//      a final chat-final / agent-end finalizes the message and
//      flips streaming to false.
//   4. send() POSTs to /chat/send — the response is fire-and-
//      forget; the actual user_message + agent reply arrive via
//      the SSE stream.
//   5. abort() POSTs to /chat/abort which signals the running
//      engine; the SSE drops a chat-final + agent-end with the
//      partial text.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type HistoryEvent } from '../lib/api';
import type {
  ChatMessage,
  ChatUsage,
  MemoryHitsSnapshot,
  StreamEvent,
} from '../types/chat';

let messageIdSeq = 0;
function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++messageIdSeq}`;
}

export interface ChatSessionState {
  messages: ChatMessage[];
  streaming: boolean;
  thinking: boolean;
  loading: boolean;
  usage: ChatUsage | null;
  memory: MemoryHitsSnapshot | null;
  /** Connection state for the SSE stream — drives the header dot. */
  connected: boolean;
  /** Send a fresh user message. Does NOT optimistically append; the
   *  user_message comes back via SSE so we stay single-sourced. */
  send: (text: string) => Promise<void>;
  abort: () => Promise<void>;
}

export function useChatSession(agent: string, session: string): ChatSessionState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [memory, setMemory] = useState<MemoryHitsSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  // The id of the in-flight assistant message that chat-delta events
  // append to. Cleared on agent-end.
  const streamingAssistantIdRef = useRef<string | null>(null);

  // Load history + open stream on (agent, session) change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setUsage(null);
    setMemory(null);
    setStreaming(false);
    setThinking(false);
    streamingAssistantIdRef.current = null;

    api
      .history(agent, session)
      .then((res) => {
        if (cancelled) return;
        setMessages(res.events.flatMap(historyEventToMessages));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn('[somora-web] history load failed', err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const url = api.streamUrl(agent, session);
    const es = new EventSource(url);

    const onConnected = () => setConnected(true);
    const onError = () => setConnected(false);

    es.addEventListener('open', onConnected);
    es.addEventListener('error', onError);

    // Each named event from the server. We listen explicitly because
    // EventSource defaults to `message` events only.
    const handle = (kind: StreamEvent['kind']) => (ev: MessageEvent) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        // some events (heartbeat) carry plain numbers / strings
      }
      applyStreamEvent({ kind, ...parsed } as StreamEvent);
    };

    function applyStreamEvent(e: StreamEvent) {
      if (cancelled) return;
      if (e.kind === 'status') {
        setConnected(true);
        return;
      }
      if (e.kind === 'agent-start') {
        setStreaming(true);
        setThinking(true);
        return;
      }
      if (e.kind === 'agent-end') {
        setStreaming(false);
        setThinking(false);
        if (e.usage) setUsage(e.usage);
        // Mark the streaming message as no longer streaming.
        const id = streamingAssistantIdRef.current;
        if (id) {
          setMessages((ms) =>
            ms.map((m) =>
              m.role === 'assistant' && m.id === id ? { ...m, streaming: false } : m,
            ),
          );
          streamingAssistantIdRef.current = null;
        }
        return;
      }
      if (e.kind === 'chat-delta') {
        setThinking(false);
        setMessages((ms) => {
          const id = streamingAssistantIdRef.current;
          if (id) {
            return ms.map((m) =>
              m.role === 'assistant' && m.id === id
                ? { ...m, text: m.text + e.text }
                : m,
            );
          }
          const newId_ = newId('msg');
          streamingAssistantIdRef.current = newId_;
          return [
            ...ms,
            {
              id: newId_,
              role: 'assistant',
              ts: Date.now(),
              text: e.text,
              streaming: true,
            },
          ];
        });
        return;
      }
      if (e.kind === 'chat-final') {
        setMessages((ms) => {
          const id = streamingAssistantIdRef.current;
          if (id) {
            return ms.map((m) =>
              m.role === 'assistant' && m.id === id ? { ...m, text: e.text, streaming: false } : m,
            );
          }
          return [
            ...ms,
            { id: newId('msg'), role: 'assistant', ts: Date.now(), text: e.text },
          ];
        });
        streamingAssistantIdRef.current = null;
        return;
      }
      if (e.kind === 'memory') {
        setMemory({ count: e.count, topScore: e.topScore, refs: e.refs });
        return;
      }
      if (e.kind === 'tool') {
        if (e.phase === 'call') {
          setMessages((ms) => [
            ...ms,
            {
              id: newId('tc'),
              role: 'tool_call',
              ts: Date.now(),
              toolCall: {
                callId: e.callId ?? '',
                tool: e.tool,
                input: e.input ?? {},
              },
            },
          ]);
        } else if (e.phase === 'result') {
          setMessages((ms) => [
            ...ms,
            {
              id: newId('tr'),
              role: 'tool_result',
              ts: Date.now(),
              toolResult: {
                callId: e.callId ?? '',
                output: e.output,
              },
            },
          ]);
        } else if (e.phase === 'error') {
          setMessages((ms) => [
            ...ms,
            {
              id: newId('tr'),
              role: 'tool_result',
              ts: Date.now(),
              toolResult: {
                callId: e.callId ?? '',
                output: { error: e.error ?? 'tool failed' },
              },
            },
          ]);
        }
        return;
      }
      if (e.kind === 'user-message') {
        // Echo of the user's own message (or A2A from another agent).
        setMessages((ms) => [
          ...ms,
          {
            id: newId('um'),
            role: 'user',
            ts: e.ts ?? Date.now(),
            text: e.text,
          },
        ]);
      }
    }

    const eventNames: StreamEvent['kind'][] = [
      'status',
      'agent-start',
      'agent-end',
      'chat-delta',
      'chat-final',
      'memory',
      'tool',
      'user-message',
    ];
    const listeners: Array<[string, EventListener]> = [];
    for (const name of eventNames) {
      const l = handle(name) as EventListener;
      es.addEventListener(name, l);
      listeners.push([name, l]);
    }

    return () => {
      cancelled = true;
      for (const [n, l] of listeners) es.removeEventListener(n, l);
      es.removeEventListener('open', onConnected);
      es.removeEventListener('error', onError);
      es.close();
      setConnected(false);
    };
  }, [agent, session]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      await api.send(agent, session, text);
    },
    [agent, session],
  );

  const abort = useCallback(async () => {
    await api.abort(agent, session);
  }, [agent, session]);

  return { messages, streaming, thinking, loading, usage, memory, connected, send, abort };
}

/** Convert a server history event into 0+ chat messages. Some
 *  events (turn_start, turn_end) don't render as messages but do
 *  carry useful telemetry — turn_end usage is applied via the
 *  caller's handler if needed. For Phase 1 we only emit
 *  user/assistant/tool_call/tool_result rows. */
function historyEventToMessages(e: HistoryEvent): ChatMessage[] {
  if (e.kind === 'user_message' && typeof e.text === 'string') {
    return [{ id: newId('h-um'), role: 'user', ts: e.ts, text: e.text }];
  }
  if (e.kind === 'assistant_message' && typeof e.text === 'string') {
    return [{ id: newId('h-am'), role: 'assistant', ts: e.ts, text: e.text }];
  }
  if (e.kind === 'tool_call' && e.tool && e.callId) {
    return [
      {
        id: newId('h-tc'),
        role: 'tool_call',
        ts: e.ts,
        toolCall: { callId: e.callId, tool: e.tool, input: e.input ?? {} },
      },
    ];
  }
  if (e.kind === 'tool_result' && e.callId) {
    return [
      {
        id: newId('h-tr'),
        role: 'tool_result',
        ts: e.ts,
        toolResult: { callId: e.callId, output: e.output },
      },
    ];
  }
  return [];
}
