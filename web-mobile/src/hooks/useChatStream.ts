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
  /** A2A: name of the peer agent that wrote this inbound. Renderer
   *  swaps the user-bubble for a peer-agent bubble in the sender's
   *  color/icon. */
  fromAgent?: string;
  /** Synthesized inbound marker. Today: 'sentinel'. Renderer draws a
   *  centered system divider instead of a user-bubble. */
  fromSystem?: 'sentinel' | 'tmux' | 'subagent';
  /** Voice: optional TTS audio URL produced for this turn. Set when an
   *  `assistant_audio` SSE event arrived after the message; drives the
   *  Play-button on the agent bubble. */
  audio?: { url: string; mime: string; durationMs?: number };
  /** Server-issued turnId for self-typed turns. Set after POST
   *  /chat/send returns; used to pair this optimistic bubble with
   *  later SSE events (turn_queued, user_message). */
  turnId?: string;
  /** Set when a turn_queued SSE event arrived for this bubble's
   *  turnId. Cleared once the matching user_message event lands
   *  (= the turn actually started). Drives the hourglass marker
   *  next to the timestamp. */
  queued?: { ahead: number };
  /** True from optimistic send until the matching user_message
   *  SSE arrives. Used by the chat:delta handler to anchor the
   *  fresh assistant bubble BEFORE any queued user-bubbles so
   *  the agent's reply for the CURRENT turn stays above messages
   *  the user typed while waiting. */
  pending?: boolean;
}

interface HistoryEvent {
  kind: string;
  ts?: number;
  text?: string;
  turnId?: string;
  from_agent?: string;
  from_system?: 'sentinel' | 'tmux' | 'subagent';
  audio?: { url: string; mime: string; durationMs?: number; cacheKey: string };
}

export interface ChatStream {
  messages: ChatMessage[];
  /** True from the moment the user sends until the server emits
   *  agent.phase='end'. */
  streaming: boolean;
  /** Transient status line (abort outcome, etc.). Cleared by the
   *  next successful send or after a short timer in the consumer. */
  statusNotice: string | null;
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
  /** Abort the in-flight turn for this session. POST /chat/abort;
   *  close-out still lands as chat:final + agent:end. Surfaces
   *  aborted:false / HTTP failures via statusNotice so Stop never
   *  silently no-ops. */
  abort: () => Promise<void>;
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
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  // Track the currently-streaming agent message id outside React state
  // so successive deltas can find it without re-render races.
  const streamingIdRef = useRef<string | null>(null);
  const agentRef = useRef<string | null>(agent);
  // Voice: subscribers waiting for assistant_audio events.
  const audioListenersRef = useRef<Set<(url: string) => void>>(new Set());
  // Buffer of turn_queued events that arrived before the matching
  // POST /chat/send response landed (HTTP and SSE channels can race).
  // Keyed by turnId; consumed by send() when it gets its turnId back.
  const pendingQueuedRef = useRef<Map<string, number>>(new Map());
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
    // Buffered ahead-counts belong to the previous agent's session —
    // a stale entry must not be applied to a bubble on the new one.
    pendingQueuedRef.current.clear();

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

      // First delta appends a fresh bubble at the current bottom.
      // Subsequent deltas + final update the SAME bubble in place
      // so optimistic user-bubbles inserted while the previous turn
      // was running stay below the agent's text instead of being
      // jumped over on every render. See ChatProvider.tsx for the
      // matching desktop logic.
      if (d.state === 'delta') {
        let id = streamingIdRef.current;
        const isFirstDelta = !id;
        if (!id) {
          id = newId('a');
          streamingIdRef.current = id;
        }
        const trackedId = id;
        setMessages((prev) => {
          if (isFirstDelta) {
            // Anchor the fresh agent bubble BEFORE any still-pending
            // user-bubble — queued messages stay below the agent's
            // reply for the current turn instead of being jumped
            // over by the first delta. See ChatProvider.tsx for the
            // matching desktop logic.
            const insertIdx = prev.findIndex((m) => m.role === 'user' && m.pending);
            const newBubble: ChatMessage = {
              id: trackedId,
              role: 'agent',
              ts: Date.now(),
              text,
              streaming: true,
            };
            if (insertIdx < 0) return [...prev, newBubble];
            const next = prev.slice();
            next.splice(insertIdx, 0, newBubble);
            return next;
          }
          const idx = prev.findIndex((m) => m.id === trackedId);
          if (idx < 0) {
            return [
              ...prev,
              { id: trackedId, role: 'agent', ts: Date.now(), text, streaming: true },
            ];
          }
          const next = prev.slice();
          const existing = next[idx];
          if (!existing || existing.role !== 'agent') return prev;
          next[idx] = { ...existing, text, streaming: true };
          return next;
        });
      } else if (d.state === 'final') {
        const id = streamingIdRef.current ?? newId('a');
        streamingIdRef.current = null;
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === id);
          if (idx < 0) {
            return [
              ...prev,
              { id, role: 'agent', ts: Date.now(), text },
            ];
          }
          const next = prev.slice();
          const existing = next[idx];
          if (!existing || existing.role !== 'agent') return prev;
          next[idx] = { ...existing, text, streaming: false };
          return next;
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

    const onUserMessage = (e: MessageEvent) => {
      bump();
      let d:
        | {
            text?: string;
            ts?: number;
            turnId?: string;
            from_agent?: string;
            from_system?: 'sentinel' | 'tmux' | 'subagent';
          }
        | null = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || typeof d.text !== 'string') return;
      const dd = d;
      // Dedupe + append in a SINGLE setMessages updater so the
      // decision is atomic. Three cases:
      //   1. Self-typed echo with matching pending bubble in OUR
      //      list → clear pending/queued, drop the echo.
      //   2. Self-typed echo with NO matching bubble (this client
      //      didn't send it — it's coming from a sibling client on
      //      the same session, e.g. mobile watching while desktop
      //      sends) → append as a new user-message.
      //   3. A2A (fromAgent) / sentinel inbound → append.
      // The turn is starting — a buffered turn_queued ahead-count for
      // this turnId is moot now. Pruning here also drops buffered
      // entries for OTHER clients' queued turns, which nothing else
      // would ever drain.
      if (dd.turnId) pendingQueuedRef.current.delete(dd.turnId);
      setMessages((prev) => {
        if (!dd.from_agent && !dd.from_system) {
          // Exactly ONE bubble is cleared per echo — each event
          // represents one send. An earlier version mapped over the
          // whole list and cleared every match at once, so sending
          // the same text twice in quick succession stripped BOTH
          // bubbles' queued indicator + pending anchor on the first
          // echo. turnId is scanned first so the text fallback can't
          // steal a match that belongs to a different bubble.
          let matchIdx = dd.turnId
            ? prev.findIndex((m) => m.role === 'user' && m.turnId === dd.turnId)
            : -1;
          if (matchIdx < 0) {
            matchIdx = prev.findIndex(
              (m) => m.role === 'user' && m.pending && m.text === dd.text,
            );
          }
          const matched = matchIdx >= 0 ? prev[matchIdx] : undefined;
          if (matched) {
            const { queued: _q, pending: _p, ...rest } = matched;
            const next = prev.slice();
            next[matchIdx] = rest as ChatMessage;
            return next;
          }
          // No optimistic bubble owns this message — it came from
          // another client on the same session. Fall through to
          // append so the user sees it live, not just after reload.
        }
        return [
          ...prev,
          {
            id: newId('um'),
            role: 'user',
            ts: dd.ts ?? Date.now(),
            text: dd.text!,
            ...(dd.turnId ? { turnId: dd.turnId } : {}),
            ...(dd.from_agent ? { fromAgent: dd.from_agent } : {}),
            ...(dd.from_system ? { fromSystem: dd.from_system } : {}),
          },
        ];
      });
    };

    const onTurnQueued = (e: MessageEvent) => {
      bump();
      let d: { turnId?: string; ahead?: number } | null = null;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || typeof d.turnId !== 'string' || typeof d.ahead !== 'number') return;
      const turnId = d.turnId;
      const ahead = d.ahead;
      // Find the optimistic bubble carrying this turnId and tag it.
      // If no bubble has it yet (HTTP /chat/send response in flight),
      // buffer the ahead-count so send() can apply it once the id
      // lands. The tag-or-buffer decision lives INSIDE the updater —
      // an earlier version set a flag in the updater and read it right
      // after setMessages returned, but updaters run at flush time, so
      // the flag was always stale-false and EVERY event landed in the
      // buffer, growing it unboundedly. The ref mutation in here is
      // idempotent, so StrictMode's double-invoked updater is harmless.
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.role === 'user' && m.turnId === turnId);
        const target = idx >= 0 ? prev[idx] : undefined;
        if (!target) {
          pendingQueuedRef.current.set(turnId, ahead);
          return prev;
        }
        const next = prev.slice();
        next[idx] = { ...target, queued: { ahead } };
        return next;
      });
    };

    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    es.addEventListener('heartbeat', onHeartbeat);
    es.addEventListener('chat', onChat);
    es.addEventListener('agent', onAgent);
    es.addEventListener('status', onStatus);
    es.addEventListener('assistant_audio', onAssistantAudio);
    es.addEventListener('user_message', onUserMessage);
    es.addEventListener('turn_queued', onTurnQueued);

    return () => {
      cancelled = true;
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.removeEventListener('heartbeat', onHeartbeat);
      es.removeEventListener('chat', onChat);
      es.removeEventListener('agent', onAgent);
      es.removeEventListener('status', onStatus);
      es.removeEventListener('assistant_audio', onAssistantAudio);
      es.removeEventListener('user_message', onUserMessage);
      es.removeEventListener('turn_queued', onTurnQueued);
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

  // Auto-dismiss abort/status notices so they don't stick forever.
  useEffect(() => {
    if (!statusNotice) return;
    const t = setTimeout(() => setStatusNotice(null), 4000);
    return () => clearTimeout(t);
  }, [statusNotice]);

  const send: ChatStream['send'] = async (text, attachments, voice) => {
    if (!agent) return;
    setStatusNotice(null);
    // Optimistically add the user's message so the bubble appears
    // instantly — the server doesn't broadcast user_message back to
    // SSE subscribers, so without this the message would only show
    // up on the next history-reload. Attachment-thumbs in the user's
    // own bubble are a Phase-3 polish; v1 just shows the text.
    const localId = newId('u');
    const userMsg: ChatMessage = {
      id: localId,
      role: 'user',
      ts: Date.now(),
      text: text || (attachments && attachments.length > 0
        ? `📎 ${attachments.map((a) => a.name).join(', ')}`
        : ''),
      pending: true,
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    try {
      const res = await fetch('/chat/send', {
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
      if (!res.ok) throw new Error(`chat/send ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { turnId?: string };
      const turnId = typeof body.turnId === 'string' ? body.turnId : '';
      if (turnId) {
        // If turn_queued already arrived before we got the HTTP
        // response back, drain its buffered ahead-count and apply
        // it in the same setMessages pass that adds the turnId.
        const bufferedAhead = pendingQueuedRef.current.get(turnId);
        if (bufferedAhead !== undefined) pendingQueuedRef.current.delete(turnId);
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== localId) return m;
            if (m.role !== 'user') return m;
            return {
              ...m,
              turnId,
              ...(bufferedAhead !== undefined ? { queued: { ahead: bufferedAhead } } : {}),
            };
          }),
        );
      }
    } catch (err) {
      console.warn('[somora-mobile] /chat/send failed:', err);
      setStreaming(false);
      // Drop the optimistic bubble — it never reached the server. Leaving
      // it `pending` forever would anchor future assistant replies above
      // it and make the message look sent. Rethrow so MessageInput's
      // catch restores the draft for a retry (HTTP errors previously
      // never threw, which left that restore path dead).
      setMessages((prev) => prev.filter((m) => m.id !== localId));
      throw err;
    }
  };

  const abort: ChatStream['abort'] = async () => {
    if (!agent) return;
    try {
      const res = await fetch(`/chat/abort?agent=${encodeURIComponent(agent)}&session=main`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setStatusNotice(`Stop failed: ${res.status}${body ? ` ${body.slice(0, 120)}` : ''}`);
        return;
      }
      const body = (await res.json()) as { aborted?: boolean };
      // Idempotent when nothing is running — still tell the user so
      // Stop doesn't feel broken during pre-lock / already-finished.
      if (!body.aborted) {
        setStatusNotice('Nothing to stop — no active turn');
      } else {
        setStatusNotice(null);
      }
    } catch (err) {
      console.warn('[somora-mobile] /chat/abort failed:', err);
      setStatusNotice(
        `Stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const subscribeAudio: ChatStream['subscribeAudio'] = (handler) => {
    audioListenersRef.current.add(handler);
    return () => {
      audioListenersRef.current.delete(handler);
    };
  };

  return { messages, streaming, send, subscribeAudio, abort, connectionError, statusNotice };
}

function eventToMessage(ev: HistoryEvent): ChatMessage | null {
  if (ev.kind === 'user_message') {
    return {
      id: `u-${ev.ts ?? 0}-${msgIdCounter++}`,
      role: 'user',
      text: ev.text ?? '',
      ts: ev.ts ?? 0,
      ...(ev.from_agent ? { fromAgent: ev.from_agent } : {}),
      ...(ev.from_system ? { fromSystem: ev.from_system } : {}),
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
