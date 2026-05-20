// Single SSE subscription for the active agent's main session. Auto-
// unsubscribes when the agent changes and resubscribes to the new one.
// Loads history on agent-switch so the chat surface shows the existing
// conversation immediately, then streams new events on top.
//
import type { AttachmentRef } from '../components/AttachmentPicker';

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
  /** Voice: optional TTS audio URL produced for this turn. Set when an
   *  `assistant_audio` SSE event arrived after the message; drives the
   *  Play-button on the agent bubble. */
  audio?: { url: string; mime: string; durationMs?: number };
}

interface HistoryEvent {
  kind: string;
  ts?: number;
  text?: string;
  turnId?: string;
  audio?: { url: string; mime: string; durationMs?: number; cacheKey: string };
}

export interface ChatStream {
  messages: ChatMessage[];
  /** True from the moment the user sends until the server emits
   *  agent.phase='end'. */
  streaming: boolean;
  /** Send a user message via POST /chat/send. Optionally includes
   *  staged attachment refs (already uploaded to /attachments).
   *  Optimistically appends to local messages so the bubble shows
   *  up without waiting for the server. */
  send: (
    text: string,
    attachments?: AttachmentRef[],
    voice?: { inputModality?: 'voice'; autoPlayRequested?: boolean },
  ) => Promise<void>;
  /** Voice: callback invoked when an `assistant_audio` event arrives.
   *  Caller decides whether to auto-play (typically gated by their
   *  per-session toggle). Returns unsubscribe. */
  subscribeAudio: (handler: (url: string) => void) => () => void;
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
  // Voice: subscribers waiting for assistant_audio events.
  const audioListenersRef = useRef<Set<(url: string) => void>>(new Set());
  // Sleep-recovery: timestamp of the last SSE event (heartbeat or data)
  // for this subscription. Drives the staleness check below — when the
  // tab regains visibility/focus after iOS Safari has frozen the TCP
  // socket, we compare against this and force a reconnect if the gap
  // exceeds two heartbeat intervals.
  const lastEventAtRef = useRef<number>(0);
  // Bumping this state-counter re-runs the main subscribe effect, which
  // tears down the old EventSource and opens a fresh one. Used by the
  // visibility / focus / online listeners below.
  const [reopenTick, setReopenTick] = useState(0);

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
        const out: ChatMessage[] = [];
        for (const ev of body.events ?? []) {
          if (ev.kind === 'assistant_audio' && ev.audio) {
            // Fold onto the most recent agent message so past turns
            // still show a Play-button on history load.
            for (let i = out.length - 1; i >= 0; i -= 1) {
              const m = out[i];
              if (m && m.role === 'agent') {
                out[i] = {
                  ...m,
                  audio: {
                    url: ev.audio.url,
                    mime: ev.audio.mime,
                    ...(typeof ev.audio.durationMs === 'number'
                      ? { durationMs: ev.audio.durationMs }
                      : {}),
                  },
                };
                break;
              }
            }
            continue;
          }
          const mapped = eventToMessage(ev);
          if (mapped) out.push(mapped);
        }
        setMessages(out);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[somora-mobile] history load failed:', err);
      });

    // 2. Subscribe to SSE for live events.
    const url = `/chat/stream?agent=${encodeURIComponent(agent)}&session=main`;
    const es = new EventSource(url);
    lastEventAtRef.current = Date.now();
    const bump = () => { lastEventAtRef.current = Date.now(); };

    const onOpen = () => {
      if (cancelled) return;
      bump();
      setConnectionError(null);
    };
    const onError = () => {
      if (cancelled) return;
      setConnectionError('Verbindung wackelt — versuche neu zu verbinden…');
    };
    // Server emits `heartbeat` every 20s; its only job is keeping TCP
    // alive and feeding the staleness watchdog. No UI payload.
    const onHeartbeat = () => { bump(); };

    const onChat = (e: MessageEvent) => {
      bump();
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
      bump();
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
      bump();
      let d: { msg?: string } | null = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || !d.msg) return;
      if (d.msg.startsWith('error') || d.msg.startsWith('turn failed')) {
        setConnectionError(d.msg);
        setStreaming(false);
        streamingIdRef.current = null;
      }
    };

    const onAssistantAudio = (e: MessageEvent) => {
      bump();
      let d: { turnId?: string; url?: string; mime?: string; durationMs?: number } | null = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || typeof d.url !== 'string' || typeof d.mime !== 'string') return;
      const audio = {
        url: d.url,
        mime: d.mime,
        ...(typeof d.durationMs === 'number' ? { durationMs: d.durationMs } : {}),
      };
      setMessages((prev) => {
        // Attach to the most recent agent message (single-session,
        // single-turn-at-a-time on mobile, so last agent message is
        // the right target).
        for (let i = prev.length - 1; i >= 0; i -= 1) {
          const m = prev[i];
          if (m && m.role === 'agent') {
            const next = prev.slice();
            next[i] = { ...m, audio };
            return next;
          }
        }
        return prev;
      });
      audioListenersRef.current.forEach((fn) => fn(audio.url));
    };

    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    es.addEventListener('heartbeat', onHeartbeat);
    es.addEventListener('chat', onChat);
    es.addEventListener('agent', onAgent);
    es.addEventListener('status', onStatus);
    es.addEventListener('assistant_audio', onAssistantAudio);

    return () => {
      cancelled = true;
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.removeEventListener('heartbeat', onHeartbeat);
      es.removeEventListener('chat', onChat);
      es.removeEventListener('agent', onAgent);
      es.removeEventListener('status', onStatus);
      es.removeEventListener('assistant_audio', onAssistantAudio);
      es.close();
    };
  }, [agent, reopenTick]);

  // Sleep-recovery: iOS Safari aggressively freezes TCP sockets when
  // the PWA goes to the background — EventSource appears alive but no
  // bytes flow, no error fires. On returning to the foreground, check
  // when we last saw any event; if it's been longer than two heartbeat
  // intervals, bump reopenTick to force the main effect to recreate
  // the EventSource (which also re-hydrates from /chat/history so
  // anything broadcast while we slept is recovered).
  useEffect(() => {
    if (!agent) return;
    const STALE_MS = 45_000; // server heartbeat is 20s; allow 2 misses
    const checkStale = () => {
      const last = lastEventAtRef.current;
      if (last === 0) return;
      if (Date.now() - last <= STALE_MS) return;
      setReopenTick((n) => n + 1);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkStale();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', checkStale);
    window.addEventListener('online', checkStale);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', checkStale);
      window.removeEventListener('online', checkStale);
    };
  }, [agent]);

  const send: ChatStream['send'] = async (text, attachments, voice) => {
    if (!agent) return;
    // Optimistically add the user's message so the bubble appears
    // instantly — the server doesn't broadcast user_message back to
    // SSE subscribers, so without this the message would only show
    // up on the next history-reload. Attachment-thumbs in the user's
    // own bubble are a Phase-3 polish; v1 just shows the text.
    const userMsg: ChatMessage = {
      id: newId('u'),
      role: 'user',
      ts: Date.now(),
      text: text || (attachments && attachments.length > 0
        ? `📎 ${attachments.map((a) => a.name).join(', ')}`
        : ''),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    try {
      await fetch('/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent,
          session: 'main',
          text,
          ...(attachments && attachments.length > 0
            ? { attachments: attachments.map((a) => ({ hash: a.hash, name: a.name, mime: a.mime })) }
            : {}),
          ...(voice?.inputModality === 'voice' ? { input_modality: 'voice' as const } : {}),
          ...(voice?.autoPlayRequested ? { auto_play_requested: true } : {}),
        }),
      });
    } catch (err) {
      console.warn('[somora-mobile] /chat/send failed:', err);
      setStreaming(false);
    }
  };

  const subscribeAudio: ChatStream['subscribeAudio'] = (handler) => {
    audioListenersRef.current.add(handler);
    return () => {
      audioListenersRef.current.delete(handler);
    };
  };

  return { messages, streaming, send, subscribeAudio, connectionError };
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
