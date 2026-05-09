// Per-session chat state. Owns the message list, the SSE
// subscription, the streaming/thinking flags, the running token
// snapshot, and the most recent memory-inject hit set.
//
// Wire format reminder: server SSE emits `event: chat / agent /
// tool / memory / status / user_message / heartbeat` with a
// discriminated `data` shape. The chat event carries
// `{state: 'delta' | 'final'}`, agent carries
// `{phase: 'start' | 'end'}`, tool carries `{phase: ...}`. There
// are NO `chat-delta` / `agent-start` named events — that was a
// mismatched assumption in the first cut of this hook.

import { useCallback, useEffect, useRef, useState } from 'react';
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

export interface ChatSessionState {
  messages: ChatMessage[];
  streaming: boolean;
  thinking: boolean;
  loading: boolean;
  usage: ChatUsage | null;
  memory: MemoryHitsSnapshot | null;
  /** Connection state for the SSE stream. */
  connected: boolean;
  /** Send a fresh user message. The user_message echo + agent
   *  reply both arrive via the SSE stream. */
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

  // The id of the in-flight assistant message that chat-delta
  // events append to. Cleared on agent.end.
  const streamingAssistantIdRef = useRef<string | null>(null);

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

    function parse<T>(ev: MessageEvent): T | null {
      try {
        return JSON.parse(ev.data) as T;
      } catch {
        return null;
      }
    }

    function onStatus(ev: MessageEvent) {
      if (cancelled) return;
      setConnected(true);
      // status events also carry runtime errors as messages — we
      // don't surface them in the UI yet but they're worth a log.
      const d = parse<{ msg?: string }>(ev);
      if (d?.msg && d.msg !== 'connected') {
        // eslint-disable-next-line no-console
        console.info('[somora-web] status', d.msg);
      }
    }

    function onChat(ev: MessageEvent) {
      if (cancelled) return;
      const d = parse<{ state: 'delta' | 'final'; text: string }>(ev);
      if (!d) return;
      if (d.state === 'delta') {
        setThinking(false);
        setMessages((ms) => {
          const id = streamingAssistantIdRef.current;
          if (id) {
            // Server-side deltas are CUMULATIVE — each event carries
            // the full accumulated text, not the new chunk. Replace,
            // don't append. (Wire-format note in src/types/events.ts:
            // "Deltas are cumulative.")
            return ms.map((m) =>
              m.role === 'assistant' && m.id === id ? { ...m, text: d.text } : m,
            );
          }
          const fresh = newId('msg');
          streamingAssistantIdRef.current = fresh;
          return [
            ...ms,
            {
              id: fresh,
              role: 'assistant',
              ts: Date.now(),
              text: d.text,
              streaming: true,
            },
          ];
        });
      } else if (d.state === 'final') {
        setMessages((ms) => {
          const id = streamingAssistantIdRef.current;
          if (id) {
            return ms.map((m) =>
              m.role === 'assistant' && m.id === id
                ? { ...m, text: d.text, streaming: false }
                : m,
            );
          }
          return [
            ...ms,
            { id: newId('msg'), role: 'assistant', ts: Date.now(), text: d.text },
          ];
        });
        streamingAssistantIdRef.current = null;
      }
    }

    function onAgent(ev: MessageEvent) {
      if (cancelled) return;
      const d = parse<{
        phase: 'start' | 'end';
        usage?: ChatUsage;
      }>(ev);
      if (!d) return;
      if (d.phase === 'start') {
        setStreaming(true);
        setThinking(true);
      } else if (d.phase === 'end') {
        setStreaming(false);
        setThinking(false);
        if (d.usage) setUsage(d.usage);
        // Mark the in-flight assistant message as no longer streaming.
        const id = streamingAssistantIdRef.current;
        if (id) {
          setMessages((ms) =>
            ms.map((m) =>
              m.role === 'assistant' && m.id === id ? { ...m, streaming: false } : m,
            ),
          );
          streamingAssistantIdRef.current = null;
        }
      }
    }

    function onMemory(ev: MessageEvent) {
      if (cancelled) return;
      const d = parse<{
        count: number;
        topScore?: number;
        refs: string[];
        fullText?: string;
      }>(ev);
      if (!d) return;
      setMemory({
        count: d.count,
        topScore: d.topScore ?? null,
        refs: d.refs,
        ...(d.fullText !== undefined ? { fullText: d.fullText } : {}),
      });
    }

    function onTool(ev: MessageEvent) {
      if (cancelled) return;
      const d = parse<{
        phase: 'call' | 'result' | 'error';
        tool: string;
        summary?: string;
        details?: string;
        error?: string;
      }>(ev);
      if (!d) return;
      if (d.phase === 'call') {
        setMessages((ms) => [
          ...ms,
          {
            id: newId('tc'),
            role: 'tool_call',
            ts: Date.now(),
            toolCall: {
              tool: d.tool,
              ...(d.summary ? { summary: d.summary } : {}),
              ...(d.details ? { details: d.details } : {}),
            },
          },
        ]);
      } else if (d.phase === 'result') {
        setMessages((ms) => [
          ...ms,
          {
            id: newId('tr'),
            role: 'tool_result',
            ts: Date.now(),
            toolResult: {
              tool: d.tool,
              ...(d.summary ? { summary: d.summary } : {}),
              ...(d.details ? { details: d.details } : {}),
            },
          },
        ]);
      } else if (d.phase === 'error') {
        setMessages((ms) => [
          ...ms,
          {
            id: newId('tr'),
            role: 'tool_result',
            ts: Date.now(),
            toolResult: {
              tool: d.tool,
              error: d.error ?? 'tool failed',
            },
          },
        ]);
      }
    }

    function onUserMessage(ev: MessageEvent) {
      if (cancelled) return;
      const d = parse<{ text: string; ts: number; from_agent?: string }>(ev);
      if (!d) return;
      setMessages((ms) => [
        ...ms,
        {
          id: newId('um'),
          role: 'user',
          ts: d.ts ?? Date.now(),
          text: d.text,
          ...(d.from_agent ? { fromAgent: d.from_agent } : {}),
        },
      ]);
    }

    function onError() {
      setConnected(false);
    }

    es.addEventListener('status', onStatus as EventListener);
    es.addEventListener('chat', onChat as EventListener);
    es.addEventListener('agent', onAgent as EventListener);
    es.addEventListener('memory', onMemory as EventListener);
    es.addEventListener('tool', onTool as EventListener);
    es.addEventListener('user_message', onUserMessage as EventListener);
    es.addEventListener('error', onError);

    return () => {
      cancelled = true;
      es.close();
      setConnected(false);
    };
  }, [agent, session]);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      // Optimistic user-message append — the server doesn't broadcast
      // an SSE `user_message` event for the user's own POST /chat/send
      // (those events fire only for A2A inbounds from other agents).
      // Without this the user's typed text would only show up on the
      // next history refresh / browser reload. The id is unique so a
      // future stream-side echo wouldn't duplicate; today there is no
      // echo for self-sent messages.
      setMessages((ms) => [
        ...ms,
        { id: newId('local-user'), role: 'user', ts: Date.now(), text },
      ]);
      await api.send(agent, session, text);
    },
    [agent, session],
  );

  const abort = useCallback(async () => {
    await api.abort(agent, session);
  }, [agent, session]);

  return { messages, streaming, thinking, loading, usage, memory, connected, send, abort };
}

/** Convert a server JSONL history event into 0+ chat messages. */
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
