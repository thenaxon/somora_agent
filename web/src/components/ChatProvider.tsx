// Global chat state provider. Keyed per (agent, session), so
// multi-window UX is fully isolated: window A streaming doesn't
// touch window B's state, doesn't disable B's input, doesn't change
// B's button colors.
//
// Architecture mirrors Orbit's GatewayContext (proven over months
// of daily use) — Map<sessionKey, SessionState> as the single
// source of truth, one EventSource per active subscription, ref-
// counted so windows that close don't kill streams in the
// background. A per-session ChatWindow component subscribes on
// mount, the provider lazy-opens / lazy-closes the SSE.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, type HistoryEvent } from '../lib/api';
import type {
  ChatMessage,
  ChatUsage,
  MemoryHitsSnapshot,
} from '../types/chat';

let messageIdSeq = 0;
function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++messageIdSeq}`;
}

const sessionKey = (agent: string, session: string) => `${agent}:${session}`;

export interface SessionStreamState {
  streaming: boolean;
  thinking: boolean;
  loading: boolean;
  connected: boolean;
  usage: ChatUsage | null;
  memory: MemoryHitsSnapshot | null;
}

const initialStreamState: SessionStreamState = {
  streaming: false,
  thinking: false,
  loading: false,
  connected: false,
  usage: null,
  memory: null,
};

interface ChatContextValue {
  subscribe: (agent: string, session: string) => () => void;
  getMessages: (agent: string, session: string) => ChatMessage[];
  getStream: (agent: string, session: string) => SessionStreamState;
  /** All session-keys (agent::session) that are currently streaming.
   *  Drives the dock's per-agent streaming dot — Desktop derives a
   *  Set<agentName> from this snapshot. */
  streamingKeys: string[];
  send: (agent: string, session: string, text: string) => Promise<void>;
  abort: (agent: string, session: string) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue>({
  subscribe: () => () => {},
  getMessages: () => [],
  getStream: () => initialStreamState,
  streamingKeys: [],
  send: async () => {},
  abort: async () => {},
});

export function useChatContext(): ChatContextValue {
  return useContext(ChatContext);
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [streams, setStreams] = useState<Record<string, SessionStreamState>>({});

  // EventSource map (open per session). Ref-counted: a session is
  // opened on first subscribe, closed when refcount hits zero.
  const sourcesRef = useRef<Map<string, { es: EventSource; refs: number; loaded: boolean }>>(
    new Map(),
  );
  // Track the in-flight assistant message id per session — a delta
  // appends to that bubble, an agent.end finalizes it.
  const streamingIdRef = useRef<Map<string, string>>(new Map());
  // Pending texts we just sent — used to dedupe the server's
  // user_message echo against our optimistic local-user message so
  // we don't render the same text twice.
  const pendingSelfSendsRef = useRef<Map<string, string[]>>(new Map());

  const patchStream = useCallback((key: string, patch: Partial<SessionStreamState>) => {
    setStreams((prev) => {
      const cur = prev[key] ?? initialStreamState;
      const next = { ...cur, ...patch };
      let changed = false;
      for (const k of Object.keys(patch) as Array<keyof SessionStreamState>) {
        if (cur[k] !== next[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return prev;
      return { ...prev, [key]: next };
    });
  }, []);

  const appendMessage = useCallback((key: string, msg: ChatMessage) => {
    setMessages((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), msg] }));
  }, []);

  const updateAssistantText = useCallback(
    (key: string, msgId: string, patch: Partial<ChatMessage>) => {
      setMessages((prev) => {
        const list = prev[key];
        if (!list) return prev;
        const next = list.map((m) =>
          m.id === msgId && m.role === 'assistant' ? ({ ...m, ...patch } as ChatMessage) : m,
        );
        return { ...prev, [key]: next };
      });
    },
    [],
  );

  const openStream = useCallback(
    (agent: string, session: string) => {
      const key = sessionKey(agent, session);
      const existing = sourcesRef.current.get(key);
      if (existing) {
        existing.refs += 1;
        return;
      }

      const es = new EventSource(api.streamUrl(agent, session));
      sourcesRef.current.set(key, { es, refs: 1, loaded: false });
      patchStream(key, { connected: false, loading: true });

      // Load history once per session-key. Stream events that happen
      // between history-snapshot and EventSource-open could be missed
      // — the race is rare and the reload UX is just F5.
      api
        .history(agent, session)
        .then((res) => {
          const entry = sourcesRef.current.get(key);
          if (!entry) return;
          entry.loaded = true;
          setMessages((prev) => ({
            ...prev,
            [key]: res.events.flatMap(historyEventToMessages),
          }));
          patchStream(key, { loading: false });
        })
        .catch((err: Error) => {
          patchStream(key, { loading: false });
          // eslint-disable-next-line no-console
          console.warn('[somora-web] history load failed', key, err.message);
        });

      function parse<T>(ev: MessageEvent): T | null {
        try {
          return JSON.parse(ev.data) as T;
        } catch {
          return null;
        }
      }

      es.addEventListener('open', () => patchStream(key, { connected: true }));
      es.addEventListener('error', () => patchStream(key, { connected: false }));

      es.addEventListener('status', (ev) => {
        patchStream(key, { connected: true });
        const d = parse<{ msg?: string }>(ev as MessageEvent);
        if (d?.msg && d.msg !== 'connected') {
          // eslint-disable-next-line no-console
          console.info('[somora-web] status', key, d.msg);
        }
      });

      es.addEventListener('chat', (ev) => {
        const d = parse<{ state: 'delta' | 'final'; text: string }>(ev as MessageEvent);
        if (!d) return;
        if (d.state === 'delta') {
          patchStream(key, { thinking: false });
          const existingId = streamingIdRef.current.get(key);
          if (existingId) {
            updateAssistantText(key, existingId, { text: d.text });
          } else {
            const fresh = newId('msg');
            streamingIdRef.current.set(key, fresh);
            appendMessage(key, {
              id: fresh,
              role: 'assistant',
              ts: Date.now(),
              text: d.text,
              streaming: true,
            });
          }
        } else if (d.state === 'final') {
          const existingId = streamingIdRef.current.get(key);
          if (existingId) {
            updateAssistantText(key, existingId, { text: d.text, streaming: false });
            streamingIdRef.current.delete(key);
          } else {
            appendMessage(key, {
              id: newId('msg'),
              role: 'assistant',
              ts: Date.now(),
              text: d.text,
            });
          }
        }
      });

      es.addEventListener('agent', (ev) => {
        const d = parse<{ phase: 'start' | 'end'; usage?: ChatUsage }>(ev as MessageEvent);
        if (!d) return;
        if (d.phase === 'start') {
          patchStream(key, { streaming: true, thinking: true });
        } else if (d.phase === 'end') {
          patchStream(key, {
            streaming: false,
            thinking: false,
            ...(d.usage ? { usage: d.usage } : {}),
          });
          const existingId = streamingIdRef.current.get(key);
          if (existingId) {
            updateAssistantText(key, existingId, { streaming: false });
            streamingIdRef.current.delete(key);
          }
        }
      });

      es.addEventListener('memory', (ev) => {
        const d = parse<{
          count: number;
          topScore?: number;
          refs: string[];
          fullText?: string;
        }>(ev as MessageEvent);
        if (!d) return;
        patchStream(key, {
          memory: {
            count: d.count,
            topScore: d.topScore ?? null,
            refs: d.refs,
            ...(d.fullText !== undefined ? { fullText: d.fullText } : {}),
          },
        });
      });

      es.addEventListener('tool', (ev) => {
        const d = parse<{
          phase: 'call' | 'result' | 'error';
          tool: string;
          summary?: string;
          details?: string;
          error?: string;
        }>(ev as MessageEvent);
        if (!d) return;
        if (d.phase === 'call') {
          appendMessage(key, {
            id: newId('tc'),
            role: 'tool_call',
            ts: Date.now(),
            toolCall: {
              tool: d.tool,
              ...(d.summary ? { summary: d.summary } : {}),
              ...(d.details ? { details: d.details } : {}),
            },
          });
        } else if (d.phase === 'result') {
          appendMessage(key, {
            id: newId('tr'),
            role: 'tool_result',
            ts: Date.now(),
            toolResult: {
              tool: d.tool,
              ...(d.summary ? { summary: d.summary } : {}),
              ...(d.details ? { details: d.details } : {}),
            },
          });
        } else if (d.phase === 'error') {
          appendMessage(key, {
            id: newId('tr'),
            role: 'tool_result',
            ts: Date.now(),
            toolResult: { tool: d.tool, error: d.error ?? 'tool failed' },
          });
        }
      });

      es.addEventListener('user_message', (ev) => {
        const d = parse<{ text: string; ts: number; from_agent?: string }>(ev as MessageEvent);
        if (!d) return;
        // Dedupe self-send echo: if this exact text sits in our
        // pending-self-sends set for this session, the optimistic
        // local-user message already represents it. Drop the echo
        // and consume the pending entry so a real second send of
        // the same text down the line still echoes properly.
        if (!d.from_agent) {
          const pending = pendingSelfSendsRef.current.get(key) ?? [];
          const idx = pending.indexOf(d.text);
          if (idx >= 0) {
            pending.splice(idx, 1);
            pendingSelfSendsRef.current.set(key, pending);
            return;
          }
        }
        appendMessage(key, {
          id: newId('um'),
          role: 'user',
          ts: d.ts ?? Date.now(),
          text: d.text,
          ...(d.from_agent ? { fromAgent: d.from_agent } : {}),
        });
      });
    },
    [patchStream, appendMessage, updateAssistantText],
  );

  const closeStream = useCallback((agent: string, session: string) => {
    const key = sessionKey(agent, session);
    const entry = sourcesRef.current.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.es.close();
    sourcesRef.current.delete(key);
    streamingIdRef.current.delete(key);
    patchStream(key, { connected: false, streaming: false, thinking: false });
  }, [patchStream]);

  const subscribe = useCallback<ChatContextValue['subscribe']>(
    (agent, session) => {
      openStream(agent, session);
      return () => closeStream(agent, session);
    },
    [openStream, closeStream],
  );

  const getMessages = useCallback<ChatContextValue['getMessages']>(
    (agent, session) => messages[sessionKey(agent, session)] ?? [],
    [messages],
  );

  const getStream = useCallback<ChatContextValue['getStream']>(
    (agent, session) => streams[sessionKey(agent, session)] ?? initialStreamState,
    [streams],
  );

  const send = useCallback<ChatContextValue['send']>(
    async (agent, session, text) => {
      if (!text.trim()) return;
      const key = sessionKey(agent, session);
      // Track the text so we can dedupe the server's user_message
      // echo against our optimistic local copy.
      const pending = pendingSelfSendsRef.current.get(key) ?? [];
      pending.push(text);
      pendingSelfSendsRef.current.set(key, pending);
      // Optimistic user-message append — better UX than waiting for
      // the server round-trip.
      appendMessage(key, {
        id: newId('local-user'),
        role: 'user',
        ts: Date.now(),
        text,
      });
      try {
        await api.send(agent, session, text);
      } catch (err) {
        // Send failed — remove the pending dedupe entry so a future
        // identical text can still be echoed normally.
        const cur = pendingSelfSendsRef.current.get(key) ?? [];
        const i = cur.indexOf(text);
        if (i >= 0) {
          cur.splice(i, 1);
          pendingSelfSendsRef.current.set(key, cur);
        }
        throw err;
      }
    },
    [appendMessage],
  );

  const abort = useCallback<ChatContextValue['abort']>(async (agent, session) => {
    await api.abort(agent, session);
  }, []);

  // Cleanup on provider unmount (rare — App lives as long as the
  // page; but covers HMR + future router-based unmounts).
  useEffect(() => {
    return () => {
      for (const entry of sourcesRef.current.values()) entry.es.close();
      sourcesRef.current.clear();
    };
  }, []);

  const streamingKeys = useMemo(
    () =>
      Object.entries(streams)
        .filter(([, s]) => s.streaming)
        .map(([k]) => k),
    [streams],
  );

  const value = useMemo<ChatContextValue>(
    () => ({ subscribe, getMessages, getStream, streamingKeys, send, abort }),
    [subscribe, getMessages, getStream, streamingKeys, send, abort],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/** Convenience reader for a specific (agent, session). Subscribes on
 *  mount, unsubscribes on unmount, returns the live snapshot. */
export function useChatSessionFromContext(agent: string, session: string) {
  const ctx = useChatContext();
  useEffect(() => {
    const unsub = ctx.subscribe(agent, session);
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, session]);

  return {
    messages: ctx.getMessages(agent, session),
    ...ctx.getStream(agent, session),
    send: (text: string) => ctx.send(agent, session, text),
    abort: () => ctx.abort(agent, session),
  };
}

function historyEventToMessages(e: HistoryEvent): ChatMessage[] {
  if (e.kind === 'user_message' && typeof e.text === 'string') {
    return [
      {
        id: newId('h-um'),
        role: 'user',
        ts: e.ts,
        text: e.text,
        ...(e.from_agent ? { fromAgent: e.from_agent } : {}),
      },
    ];
  }
  if (e.kind === 'assistant_message' && typeof e.text === 'string') {
    return [{ id: newId('h-am'), role: 'assistant', ts: e.ts, text: e.text }];
  }
  if (e.kind === 'tool_call' && e.tool) {
    return [
      {
        id: newId('h-tc'),
        role: 'tool_call',
        ts: e.ts,
        toolCall: {
          tool: e.tool,
          ...(e.callId ? { callId: e.callId } : {}),
          ...(e.input ? { input: e.input } : {}),
        },
      },
    ];
  }
  if (e.kind === 'tool_result' && e.callId) {
    return [
      {
        id: newId('h-tr'),
        role: 'tool_result',
        ts: e.ts,
        toolResult: {
          tool: '?',
          callId: e.callId,
          ...(e.output !== undefined ? { output: e.output } : {}),
        },
      },
    ];
  }
  return [];
}
