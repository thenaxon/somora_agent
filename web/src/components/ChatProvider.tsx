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
import { api, type AttachmentRef, type HistoryEvent, type ProjectInfo } from '../lib/api';
import {
  resolveEngineMetaLabel,
  extractTodoListItems,
  summariseTodoList,
} from '../lib/engine-meta-labels';
import type {
  AssistantImage,
  ChatMessage,
  ChatUsage,
  MemoryHitsSnapshot,
  ModelFallback,
} from '../types/chat';

let messageIdSeq = 0;
function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++messageIdSeq}`;
}

// Double-colon to match the server's pubsub key + survive agent
// names that ever contain a colon. Desktop strips the suffix to
// derive a per-agent streaming Set for the dock — the separator
// must match what's used here.
const sessionKey = (agent: string, session: string) => `${agent}::${session}`;

export interface SessionStreamState {
  streaming: boolean;
  thinking: boolean;
  loading: boolean;
  connected: boolean;
  usage: ChatUsage | null;
  memory: MemoryHitsSnapshot | null;
  /** Currently-pinned project for this (agent, session), or null.
   *  Set on subscribe via fetch, updated by:
   *   - SSE `project` event broadcasts (slash-command / HTTP route)
   *   - re-fetch after each agent-end (catches MCP-tool focus changes
   *     that don't reach SSE because they happen in a child process)
   *  Phase Projects v1. */
  project: ProjectInfo | null;
  /** The most recent finished turn was answered by the fallback model
   *  (null when the primary answered). Drives the header marker and the
   *  first-of-a-streak notice in ChatWindow. */
  lastFallback: ModelFallback | null;
  /** Set for exactly one turn-end when a turn on the primary follows a
   *  fallback streak — carries the primary's ref for the "back" notice. */
  primaryRestored: string | null;
}

const initialStreamState: SessionStreamState = {
  streaming: false,
  thinking: false,
  loading: false,
  connected: false,
  usage: null,
  memory: null,
  project: null,
  lastFallback: null,
  primaryRestored: null,
};

interface ChatContextValue {
  /** Feature-flag from /projects/feature, fetched once at provider
   *  mount. null while loading; true/false once probed. Drives all
   *  UI visibility for the projects feature (chip, sessions column,
   *  slash commands). */
  projectsEnabled: boolean | null;
  subscribe: (agent: string, session: string) => () => void;
  getMessages: (agent: string, session: string) => ChatMessage[];
  getStream: (agent: string, session: string) => SessionStreamState;
  /** All session-keys (agent::session) that are currently streaming.
   *  Drives the dock's per-agent streaming dot — Desktop derives a
   *  Set<agentName> from this snapshot. */
  streamingKeys: string[];
  send: (
    agent: string,
    session: string,
    text: string,
    attachments?: AttachmentRef[],
    voice?: { inputModality?: 'voice'; autoPlayRequested?: boolean; sttProvider?: string },
  ) => Promise<void>;
  /** Voice: subscribe to assistant_audio arrivals for one session.
   *  Returns the unsubscribe fn. The handler receives the audio URL;
   *  caller decides whether to actually play it (typically gated by
   *  the per-session auto-play toggle in localStorage). */
  subscribeAudio: (agent: string, session: string, handler: (url: string) => void) => () => void;
  abort: (
    agent: string,
    session: string,
  ) => Promise<{ aborted: boolean; ms_running?: number }>;
  /** Lazy-load older history. Returns true when more is available
   *  after this load (so the caller can keep paging), false when the
   *  beginning of the session has been reached. No-op when there's
   *  nothing more to fetch or a load is already in flight. */
  loadOlder: (agent: string, session: string) => Promise<boolean>;
  /** Whether older messages exist beyond the current loaded slice.
   *  Drives the chat-window's "load older" trigger visibility. */
  getHasMore: (agent: string, session: string) => boolean;
  /** Wipe the in-memory transcript for (agent, session). Used by
   *  `/reset` after the server archives the jsonl — the SSE stream
   *  stays connected on the same session id, the local buffer just
   *  needs to drop so the freshly-empty session shows as empty. */
  clearMessages: (agent: string, session: string) => void;
  /** Refetch the pinned project for (agent, session) and store in
   *  stream state. Called after the chip/switcher mutates focus via
   *  api.setSessionProject / api.clearSessionProject, and also after
   *  every agent-end to catch tool-path focus changes. */
  refreshProject: (agent: string, session: string) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue>({
  projectsEnabled: null,
  subscribe: () => () => {},
  getMessages: () => [],
  getStream: () => initialStreamState,
  streamingKeys: [],
  send: async () => {},
  subscribeAudio: () => () => {},
  abort: async () => ({ aborted: false }),
  loadOlder: async () => false,
  getHasMore: () => false,
  clearMessages: () => {},
  refreshProject: async () => {},
});

const INITIAL_HISTORY_LIMIT = 100;
const OLDER_PAGE_SIZE = 100;

export function useChatContext(): ChatContextValue {
  return useContext(ChatContext);
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [streams, setStreams] = useState<Record<string, SessionStreamState>>({});
  // Feature-flag for projects — one boot-time probe, then all UI
  // surfaces (chip in ChatWindow, column in SessionsWindow, slash
  // commands in SlashCommandPopup) read this. Starts null so they
  // can render in a hidden/loading state without flashing.
  const [projectsEnabled, setProjectsEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.projectsFeature().then((r) => {
      if (!cancelled) setProjectsEnabled(r.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // EventSource map (open per session). Ref-counted: a session is
  // opened on first subscribe, closed when refcount hits zero. Each
  // entry also carries an AbortController that signals all in-flight
  // history/loadOlder fetches for that session — closeStream() aborts
  // it so a slow history response can't flip state on a session the
  // user has already left.
  const sourcesRef = useRef<
    Map<string, { es: EventSource; refs: number; loaded: boolean; ac: AbortController }>
  >(new Map());
  // Last time we saw ANY event (data or heartbeat) per session. Drives
  // sleep-recovery: when the tab regains visibility/focus we compare
  // against this and force-reconnect if the gap exceeds the heartbeat
  // window. Without this a wedged SSE after laptop-sleep stays silent
  // until the user manually reloads.
  const lastEventAtRef = useRef<Map<string, number>>(new Map());
  // Track the in-flight assistant message id per session — a delta
  // appends to that bubble, an agent.end finalizes it.
  const streamingIdRef = useRef<Map<string, string>>(new Map());
  // Voice: per-session listeners that fire when an assistant_audio
  // event arrives. ChatWindow registers one to optionally auto-play
  // the audio (gated by its own localStorage toggle).
  const audioListenersRef = useRef<Map<string, Set<(url: string) => void>>>(new Map());
  // Pending texts we just sent — used to dedupe the server's
  // user_message echo against our optimistic local-user message so
  // we don't render the same text twice.
  const pendingSelfSendsRef = useRef<Map<string, string[]>>(new Map());
  // Per-session map of local-bubble id → turnId for self-sends whose
  // HTTP /chat/send response hasn't returned yet by the time the
  // server's turn_queued SSE arrives (rare but possible — both
  // channels race). Stored as turnId → localId so a late turn_queued
  // event can be buffered and applied once the HTTP response lands.
  const pendingQueuedEventsRef = useRef<Map<string, Map<string, number>>>(new Map());
  // Pagination cursor per session: where the loaded slice begins
  // (oldestTs), whether older messages exist beyond, and a guard
  // against concurrent loadOlder calls.
  const paginationRef = useRef<
    Map<string, { hasMore: boolean; oldestTs: number | null; inFlight: boolean }>
  >(new Map());
  // Bumped whenever pagination state changes — drives consumers'
  // re-renders since refs themselves don't trigger React updates.
  const [paginationTick, setPaginationTick] = useState(0);

  // model_fallback arrives BEFORE the fallback engine's deltas; park it
  // per session until the bubble exists, then stamp it on the bubble.
  const pendingFallbackRef = useRef(new Map<string, ModelFallback>());
  // Previous turn's fallback per session — to detect "primary is back".
  const lastFallbackRef = useRef(new Map<string, ModelFallback | null>());

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

  // Insert mid-stream side-channel events (tool calls, memory injects,
  // engine_meta items) ABOVE the currently-streaming assistant bubble
  // so they read as "happened during the turn, before the agent's
  // continued text" — TUI-style ordering. When no bubble is streaming
  // (no event in flight or the turn hasn't produced text yet), this
  // degrades to a plain append at the bottom of the list.
  const insertBeforeStreaming = useCallback((key: string, msg: ChatMessage) => {
    const streamId = streamingIdRef.current.get(key);
    setMessages((prev) => {
      const list = prev[key] ?? [];
      if (!streamId) return { ...prev, [key]: [...list, msg] };
      const idx = list.findIndex((m) => m.id === streamId);
      if (idx < 0) return { ...prev, [key]: [...list, msg] };
      const next = list.slice();
      next.splice(idx, 0, msg);
      return { ...prev, [key]: next };
    });
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
      const ac = new AbortController();
      sourcesRef.current.set(key, { es, refs: 1, loaded: false, ac });
      lastEventAtRef.current.set(key, Date.now());
      const bump = () => lastEventAtRef.current.set(key, Date.now());
      patchStream(key, { connected: false, loading: true });

      // Load history once per session-key. Stream events that happen
      // between history-snapshot and EventSource-open could be missed
      // — the race is rare and the reload UX is just F5.
      // Initial load is paginated (last N events). Older windows
      // come in via loadOlder() when the user scrolls to the top.
      // signal: ac.signal so closeStream() aborts an in-flight history
      // fetch instead of letting it land on a no-longer-subscribed key.
      api
        .history(agent, session, { limit: INITIAL_HISTORY_LIMIT, signal: ac.signal })
        .then((res) => {
          const entry = sourcesRef.current.get(key);
          if (!entry) return;
          entry.loaded = true;
          setMessages((prev) => ({
            ...prev,
            [key]: historyEventsToMessages(res.events),
          }));
          if (typeof res.oldestTs === 'number') {
            paginationRef.current.set(key, {
              hasMore: Boolean(res.hasMore),
              oldestTs: res.oldestTs,
              inFlight: false,
            });
          } else {
            paginationRef.current.set(key, {
              hasMore: false,
              oldestTs: null,
              inFlight: false,
            });
          }
          // Notify subscribers so the "load older" trigger appears.
          setPaginationTick((t) => t + 1);
          patchStream(key, { loading: false });
        })
        .catch((err: Error) => {
          // An aborted history fetch is the expected outcome when the
          // session was closed mid-load — swallow it silently.
          if (err.name === 'AbortError') return;
          patchStream(key, { loading: false });
          // eslint-disable-next-line no-console
          console.warn('[somora-web] history load failed', key, err.message);
        });

      // Initial project fetch — populates the chip on first subscribe.
      // Empty-handed on 503 (projects feature off) or no pin, which
      // surfaces as project: null and the chip stays hidden.
      void api
        .sessionProject(agent, session)
        .then((info) => {
          const entry = sourcesRef.current.get(key);
          if (!entry) return;
          patchStream(key, { project: info.project });
        })
        .catch(() => {
          /* feature off or unavailable — leave project null */
        });

      function parse<T>(ev: MessageEvent): T | null {
        try {
          return JSON.parse(ev.data) as T;
        } catch {
          return null;
        }
      }

      es.addEventListener('open', () => {
        bump();
        patchStream(key, { connected: true });
      });
      es.addEventListener('error', () => patchStream(key, { connected: false }));
      // Heartbeat fires every 20s from the server (sse.publishTimeoutMs +
      // a fixed setInterval) — it has no UI payload, its only job is to
      // keep TCP alive and feed the staleness watchdog below.
      es.addEventListener('heartbeat', () => bump());

      es.addEventListener('status', (ev) => {
        bump();
        patchStream(key, { connected: true });
        const d = parse<{ msg?: string }>(ev as MessageEvent);
        if (d?.msg && d.msg !== 'connected') {
          // eslint-disable-next-line no-console
          console.info('[somora-web] status', key, d.msg);
        }
      });

      es.addEventListener('chat', (ev) => {
        bump();
        const d = parse<{ state: 'delta' | 'final'; text: string }>(ev as MessageEvent);
        if (!d) return;
        // Single assistant bubble per turn. The bubble is created on
        // the FIRST delta (appended at the current bottom of the
        // list), and every subsequent delta + the final update the
        // bubble's text IN PLACE — no reordering. Tool / memory /
        // engine_meta events that fire mid-stream insert themselves
        // BEFORE this bubble so they read as "happened during the
        // turn, above the agent's continued text".
        //
        // Why not "always move to bottom" anymore: the old behavior
        // left an optimistic queued-user-bubble (inserted AFTER the
        // streaming bubble while a previous turn was running) stuck
        // ABOVE the in-flight assistant text on the next delta —
        // the bubble jumped over it. Order looked fine after a
        // reload (JSONL is correctly ordered) but live it was off.
        //
        // Ref bookkeeping (assigning + clearing the streaming id)
        // happens OUTSIDE the setMessages updater. React StrictMode
        // double-invokes updaters in dev — any side effect inside
        // would run twice, with the second pass observing different
        // ref state, and the bubble would be duplicated on every
        // chat:final.
        if (d.state === 'delta') {
          patchStream(key, { thinking: false });
          let trackedId = streamingIdRef.current.get(key);
          const isFirstDelta = !trackedId;
          if (!trackedId) {
            trackedId = newId('msg');
            streamingIdRef.current.set(key, trackedId);
          }
          const id = trackedId;
          setMessages((prev) => {
            const list = prev[key] ?? [];
            if (isFirstDelta) {
              // First delta of a new turn — position the fresh
              // assistant bubble BEFORE the first still-pending
              // user-bubble (a queued message the user typed while
              // waiting for this turn). Without this, the agent's
              // reply would land BELOW any queued user-message
              // already in the list, breaking the natural read
              // order. If no pending user-bubbles exist, append at
              // the bottom as before.
              const insertIdx = list.findIndex(
                (m) => m.role === 'user' && m.pending,
              );
              const newBubble: ChatMessage = {
                id,
                role: 'assistant',
                ts: Date.now(),
                text: d.text,
                streaming: true,
              };
              if (insertIdx < 0) {
                return { ...prev, [key]: [...list, newBubble] };
              }
              const next = list.slice();
              next.splice(insertIdx, 0, newBubble);
              return { ...prev, [key]: next };
            }
            // Subsequent deltas: update in place to preserve position
            // relative to any user-messages or tool events inserted
            // around the bubble.
            const idx = list.findIndex((m) => m.id === id);
            if (idx < 0) {
              return {
                ...prev,
                [key]: [
                  ...list,
                  {
                    id,
                    role: 'assistant',
                    ts: Date.now(),
                    text: d.text,
                    streaming: true,
                  },
                ],
              };
            }
            const next = list.slice();
            const existing = next[idx];
            if (!existing || existing.role !== 'assistant') return prev;
            next[idx] = { ...existing, text: d.text, streaming: true };
            return { ...prev, [key]: next };
          });
        } else if (d.state === 'final') {
          const id = streamingIdRef.current.get(key) ?? newId('msg');
          streamingIdRef.current.delete(key);
          setMessages((prev) => {
            const list = prev[key] ?? [];
            const idx = list.findIndex((m) => m.id === id);
            const fb = pendingFallbackRef.current.get(key);
            if (idx < 0) {
              // No bubble in list (no deltas arrived) — append.
              return {
                ...prev,
                [key]: [
                  ...list,
                  {
                    id,
                    role: 'assistant',
                    ts: Date.now(),
                    text: d.text,
                    ...(fb ? { fallback: fb } : {}),
                  },
                ],
              };
            }
            const next = list.slice();
            const existing = next[idx];
            if (!existing || existing.role !== 'assistant') return prev;
            next[idx] = { ...existing, text: d.text, streaming: false, ...(fb ? { fallback: fb } : {}) };
            return { ...prev, [key]: next };
          });
        }
      });

      es.addEventListener('model_fallback', (ev) => {
        bump();
        const d = parse<ModelFallback>(ev as MessageEvent);
        if (!d || typeof d.actual !== 'string') return;
        pendingFallbackRef.current.set(key, d);
        // A bubble may already be streaming (engine yielded text before
        // the marker is impossible today, but keep it robust).
        const id = streamingIdRef.current.get(key);
        if (!id) return;
        setMessages((prev) => {
          const list = prev[key];
          if (!list) return prev;
          const idx = list.findIndex((m) => m.id === id);
          const existing = idx >= 0 ? list[idx] : undefined;
          if (!existing || existing.role !== 'assistant') return prev;
          const next = list.slice();
          next[idx] = { ...existing, fallback: d };
          return { ...prev, [key]: next };
        });
      });

      es.addEventListener('agent', (ev) => {
        bump();
        const d = parse<{ phase: 'start' | 'end'; usage?: ChatUsage; fallback?: ModelFallback }>(
          ev as MessageEvent,
        );
        if (!d) return;
        if (d.phase === 'start') {
          patchStream(key, { streaming: true, thinking: true, primaryRestored: null });
        } else if (d.phase === 'end') {
          const fb = d.fallback ?? pendingFallbackRef.current.get(key) ?? null;
          pendingFallbackRef.current.delete(key);
          const prevFb = lastFallbackRef.current.get(key) ?? null;
          lastFallbackRef.current.set(key, fb);
          patchStream(key, {
            streaming: false,
            thinking: false,
            ...(d.usage ? { usage: d.usage } : {}),
            lastFallback: fb,
            primaryRestored: !fb && prevFb ? prevFb.requested : null,
          });
          // Sweep any leftover streaming=true assistant bubbles —
          // multi-segment turns (tool intervened mid-stream) can
          // leave the pre-tool bubble unfinalized otherwise.
          setMessages((prev) => {
            const list = prev[key];
            if (!list) return prev;
            let changed = false;
            const next = list.map((m) => {
              if (m.role === 'assistant' && m.streaming) {
                changed = true;
                return { ...m, streaming: false };
              }
              return m;
            });
            // Belt and braces for the fallback chip: stamp the turn's
            // last assistant bubble if it doesn't carry it yet (e.g. the
            // marker event raced ahead of the bubble's creation).
            if (fb) {
              for (let i = next.length - 1; i >= 0; i -= 1) {
                const m = next[i];
                if (m && m.role === 'assistant') {
                  if (!m.fallback) {
                    next[i] = { ...m, fallback: fb };
                    changed = true;
                  }
                  break;
                }
              }
            }
            if (!changed) return prev;
            return { ...prev, [key]: next };
          });
          streamingIdRef.current.delete(key);
          // Refetch project — tool-path focus changes (project_focus
          // called inside an MCP child for claude-cli / codex-cli)
          // don't reach SSE because the child has no broadcaster.
          // Slash-command / HTTP-route changes DO emit a 'project'
          // event (handler below). Refetching here costs one GET per
          // turn-end; cheap and reliably catches both paths.
          void api
            .sessionProject(agent, session)
            .then((info) => patchStream(key, { project: info.project }))
            .catch(() => {
              /* leave previous state */
            });
        }
      });

      es.addEventListener('project', () => {
        bump();
        // Broadcast carries from/to slugs, but the chip needs the
        // full ProjectInfo for name + color, so we re-GET regardless.
        void api
          .sessionProject(agent, session)
          .then((info) => patchStream(key, { project: info.project }))
          .catch(() => {
            /* ignore — chip just won't update */
          });
      });

      es.addEventListener('memory', (ev) => {
        bump();
        const d = parse<{
          count: number;
          topScore?: number;
          refs: string[];
          fullText?: string;
        }>(ev as MessageEvent);
        if (!d) return;
        const snapshot = {
          count: d.count,
          topScore: d.topScore ?? null,
          refs: d.refs,
          ...(d.fullText !== undefined ? { fullText: d.fullText } : {}),
        };
        // Latest snapshot stays in stream state (header pills, badges).
        patchStream(key, { memory: snapshot });
        // Plus a chat-flow item so the user sees what was injected at
        // each turn in scrollback — mirrors the TUI's `◇ memory · …`
        // line. Anchored before the turn's first chat:delta, so it
        // sits ABOVE the agent's reply for the turn it informed.
        insertBeforeStreaming(key, {
          id: newId('mi'),
          role: 'memory_inject',
          ts: Date.now(),
          memory: snapshot,
        });
      });

      es.addEventListener('tool', (ev) => {
        bump();
        const d = parse<{
          phase: 'call' | 'result' | 'error';
          tool: string;
          summary?: string;
          details?: string;
          error?: string;
        }>(ev as MessageEvent);
        if (!d) return;
        if (d.phase === 'call') {
          insertBeforeStreaming(key, {
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
          insertBeforeStreaming(key, {
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
          insertBeforeStreaming(key, {
            id: newId('tr'),
            role: 'tool_result',
            ts: Date.now(),
            toolResult: { tool: d.tool, error: d.error ?? 'tool failed' },
          });
        }
      });

      es.addEventListener('engine_meta', (ev) => {
        bump();
        const d = parse<{
          engine: string;
          itemType: string;
          label: string;
          summary?: string;
          payload: unknown;
        }>(ev as MessageEvent);
        if (!d) return;
        insertBeforeStreaming(key, {
          id: newId('em'),
          role: 'engine_meta',
          ts: Date.now(),
          meta: {
            engine: d.engine,
            itemType: d.itemType,
            label: d.label,
            ...(d.summary ? { summary: d.summary } : {}),
            payload: d.payload,
          },
        });
      });

      es.addEventListener('assistant_images', (ev) => {
        bump();
        const d = parse<{ turnId: string; images: AssistantImage[] }>(ev as MessageEvent);
        if (!d || d.images.length === 0) return;
        // Same pairing as assistant_audio: attach to the most recent
        // assistant row in this session. Images are published once per
        // turn, after the reply finalized, so the newest bubble is the
        // one they belong to.
        setMessages((prev) => {
          const list = prev[key];
          if (!list || list.length === 0) return prev;
          let targetIdx = -1;
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const m = list[i];
            if (m && m.role === 'assistant') {
              targetIdx = i;
              break;
            }
          }
          if (targetIdx < 0) return prev;
          const target = list[targetIdx];
          if (!target || target.role !== 'assistant') return prev;
          const next = list.slice();
          next[targetIdx] = { ...target, images: d.images };
          return { ...prev, [key]: next };
        });
      });

      es.addEventListener('assistant_audio', (ev) => {
        bump();
        const d = parse<{
          turnId: string;
          url: string;
          mime: string;
          durationMs?: number;
          cacheKey: string;
        }>(ev as MessageEvent);
        if (!d) return;
        // Attach to the most recent assistant message in this session.
        // turnId pairing would be more precise but ChatProvider's
        // assistant rows don't yet carry the engine turnId — last
        // assistant wins, which is correct for the single-turn case
        // (the only one auto-TTS currently fires for).
        setMessages((prev) => {
          const list = prev[key];
          if (!list || list.length === 0) return prev;
          let targetIdx = -1;
          for (let i = list.length - 1; i >= 0; i -= 1) {
            const m = list[i];
            if (m && m.role === 'assistant') {
              targetIdx = i;
              break;
            }
          }
          if (targetIdx < 0) return prev;
          const target = list[targetIdx];
          if (!target || target.role !== 'assistant') return prev;
          const next = list.slice();
          next[targetIdx] = {
            ...target,
            audio: {
              url: d.url,
              mime: d.mime,
              ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
              cacheKey: d.cacheKey,
            },
            turnId: d.turnId,
          };
          return { ...prev, [key]: next };
        });
        // Auto-play hook — listeners registered via subscribeAudio()
        // get notified. Per-session toggle gate lives in the chat
        // window (it has the localStorage state); we just notify.
        const ls = audioListenersRef.current.get(key);
        ls?.forEach((fn) => fn(d.url));
      });

      es.addEventListener('user_message', (ev) => {
        bump();
        const d = parse<{
          text: string;
          ts: number;
          turnId?: string;
          from_agent?: string;
          from_system?: 'sentinel' | 'tmux';
        }>(ev as MessageEvent);
        if (!d) return;
        // Dedupe + append in a SINGLE setMessages updater so the
        // decision is atomic. An earlier version kept `cleared` in
        // a closure outside the updater and then called appendMessage
        // when `cleared` was still false — but setMessages updaters
        // run asynchronously, so the flag wasn't set yet when the
        // outer code checked it. Result: optimistic bubble + appended
        // echo = duplicate user-message in the chat.
        setMessages((prev) => {
          const list = prev[key] ?? [];
          if (!d.from_agent && !d.from_system) {
            // Self-typed echo: look for the optimistic bubble that
            // owns this turn and clear its pending/queued flags
            // (the turn just transitioned from "waiting" to "running").
            // turnId match is authoritative; text+pending fallback
            // covers the race where the user_message SSE arrives
            // BEFORE the POST /chat/send response — the optimistic
            // bubble doesn't have its turnId tagged yet, so turnId
            // match fails. m.pending acts as the guard against
            // matching a finalized bubble with the same text.
            //
            // Exactly ONE bubble is cleared per echo — each event
            // represents one send. An earlier version mapped over the
            // whole list and cleared every match at once, so sending
            // the same text twice in quick succession stripped BOTH
            // bubbles' queued indicator + pending anchor on the first
            // echo. turnId is scanned first so the fallback can't
            // steal a match that belongs to a different bubble.
            let matchIdx = d.turnId
              ? list.findIndex((m) => m.role === 'user' && m.turnId === d.turnId)
              : -1;
            if (matchIdx < 0) {
              matchIdx = list.findIndex(
                (m) => m.role === 'user' && m.pending && m.text === d.text,
              );
            }
            const matched = matchIdx >= 0 ? list[matchIdx] : undefined;
            if (matched && matched.role === 'user') {
              const { queued: _q, pending: _p, ...rest } = matched;
              const next = list.slice();
              next[matchIdx] = rest as ChatMessage;
              return { ...prev, [key]: next };
            }
            // No match — this came from another client on the same
            // session (e.g., mobile + desktop both watching). Fall
            // through to append.
          }
          return {
            ...prev,
            [key]: [
              ...list,
              {
                id: newId('um'),
                role: 'user',
                ts: d.ts ?? Date.now(),
                text: d.text,
                ...(d.turnId ? { turnId: d.turnId } : {}),
                ...(d.from_agent ? { fromAgent: d.from_agent } : {}),
                ...(d.from_system ? { fromSystem: d.from_system } : {}),
              },
            ],
          };
        });
        // The turn is starting — a buffered turn_queued ahead-count
        // for this turnId is moot now. Pruning here also drops
        // buffered entries for OTHER clients' queued turns, which
        // nothing else would ever drain.
        if (d.turnId) {
          const perSession = pendingQueuedEventsRef.current.get(key);
          if (perSession) {
            perSession.delete(d.turnId);
            if (perSession.size === 0) pendingQueuedEventsRef.current.delete(key);
          }
        }
        // Backward-compat: drain the text-based dedupe set so older
        // servers (no turnId in user_message) still don't double-render.
        // Safe to do unconditionally — splicing a missing entry is a no-op.
        if (!d.from_agent && !d.from_system) {
          const pending = pendingSelfSendsRef.current.get(key) ?? [];
          const textIdx = pending.indexOf(d.text);
          if (textIdx >= 0) {
            pending.splice(textIdx, 1);
            pendingSelfSendsRef.current.set(key, pending);
          }
        }
      });

      es.addEventListener('turn_queued', (ev) => {
        bump();
        const d = parse<{ turnId: string; ahead: number }>(ev as MessageEvent);
        if (!d || !d.turnId) return;
        // Find the optimistic bubble that owns this turnId and tag
        // it with the queued indicator. If the bubble hasn't been
        // tagged yet (HTTP response still in flight), stash the
        // ahead-count so `send()` can apply it once it has the id.
        // The tag-or-buffer decision lives INSIDE the updater — an
        // earlier version set a flag in the updater and read it right
        // after setMessages returned, but updaters run at flush time,
        // so the flag was always stale-false and EVERY event landed
        // in the buffer, growing it unboundedly (send() only drains
        // the entry it races with). The ref mutation in here is
        // idempotent, so StrictMode's double-invoked updater is
        // harmless.
        setMessages((prev) => {
          const list = prev[key] ?? [];
          const idx = list.findIndex((m) => m.role === 'user' && m.turnId === d.turnId);
          const target = idx >= 0 ? list[idx] : undefined;
          if (!target || target.role !== 'user') {
            let perSession = pendingQueuedEventsRef.current.get(key);
            if (!perSession) {
              perSession = new Map();
              pendingQueuedEventsRef.current.set(key, perSession);
            }
            perSession.set(d.turnId, d.ahead);
            return prev;
          }
          const next = list.slice();
          next[idx] = { ...target, queued: { ahead: d.ahead } };
          return { ...prev, [key]: next };
        });
      });
    },
    [patchStream, appendMessage, insertBeforeStreaming, updateAssistantText],
  );

  const closeStream = useCallback((agent: string, session: string) => {
    const key = sessionKey(agent, session);
    const entry = sourcesRef.current.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    entry.es.close();
    entry.ac.abort();
    sourcesRef.current.delete(key);
    lastEventAtRef.current.delete(key);
    streamingIdRef.current.delete(key);
    // No window watches this session anymore — drop the per-session
    // dedupe/queue bookkeeping so it can't leak or go stale.
    pendingSelfSendsRef.current.delete(key);
    pendingQueuedEventsRef.current.delete(key);
    patchStream(key, { connected: false, streaming: false, thinking: false });
  }, [patchStream]);

  // Tear down an open SSE for (agent, session) and reopen it, preserving
  // the ref count. Used by the staleness watchdog after laptop-sleep /
  // long network interruption: closing the EventSource forces the browser
  // to redo the TCP handshake, and openStream re-fetches the history
  // snapshot so any events that fired while we were offline (other agent
  // talking to this session, sentinel turn, etc.) appear without F5.
  const reopenStream = useCallback(
    (agent: string, session: string) => {
      const key = sessionKey(agent, session);
      const old = sourcesRef.current.get(key);
      if (!old) return;
      const refs = old.refs;
      old.es.close();
      old.ac.abort();
      sourcesRef.current.delete(key);
      lastEventAtRef.current.delete(key);
      // openStream installs a fresh entry with refs:1 — restore the
      // caller-side ref count so closeStream() unsubscribes still match.
      openStream(agent, session);
      const fresh = sourcesRef.current.get(key);
      if (fresh) fresh.refs = refs;
    },
    [openStream],
  );

  // Sleep / network-interruption recovery. After laptop sleep the TCP
  // socket under EventSource often half-closes — the browser's auto-
  // reconnect doesn't fire because no 'error' event comes through, and
  // the next send appears to work but the response stream is dead.
  // Watch visibility/focus/online and force a reconnect on any active
  // session whose last event is older than two heartbeat intervals.
  useEffect(() => {
    const STALE_MS = 45_000; // server heartbeat is 20s; allow 2 misses
    const checkAll = () => {
      const now = Date.now();
      for (const key of sourcesRef.current.keys()) {
        const last = lastEventAtRef.current.get(key) ?? 0;
        if (now - last <= STALE_MS) continue;
        const sep = key.indexOf('::');
        if (sep < 0) continue;
        const agent = key.slice(0, sep);
        const session = key.slice(sep + 2);
        // eslint-disable-next-line no-console
        console.info('[somora-web] sse stale, reconnecting', key, 'gap=', now - last, 'ms');
        reopenStream(agent, session);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') checkAll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', checkAll);
    window.addEventListener('online', checkAll);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', checkAll);
      window.removeEventListener('online', checkAll);
    };
  }, [reopenStream]);

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
    async (agent, session, text, attachments, voice) => {
      if (!text.trim() && (!attachments || attachments.length === 0)) return;
      const key = sessionKey(agent, session);
      // Track the text so we can dedupe the server's user_message
      // echo against our optimistic local copy.
      const pending = pendingSelfSendsRef.current.get(key) ?? [];
      pending.push(text);
      pendingSelfSendsRef.current.set(key, pending);
      // Optimistic user-message append — better UX than waiting for
      // the server round-trip. Attachments ride along in display state
      // so the bubble shows the same thumbnail row the user just
      // confirmed in the input.
      const localId = newId('local-user');
      // pending: true marks this bubble as "awaiting server-side turn
      // start". The chat:delta handler uses it as an anchor — a fresh
      // assistant bubble inserts BEFORE the first pending user-bubble
      // so the agent's reply for the CURRENT turn doesn't jump below
      // a queued message the user typed while waiting. Cleared by the
      // user_message SSE handler when the matching turnId arrives.
      appendMessage(key, {
        id: localId,
        role: 'user',
        ts: Date.now(),
        text,
        pending: true,
        ...(attachments && attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                hash: a.hash,
                name: a.name,
                mime: a.mime,
                kind: a.kind,
                size: a.size,
              })),
            }
          : {}),
      });
      try {
        const { turnId } = await api.send(agent, session, text, attachments, voice);
        // Tag the optimistic bubble with the server-issued turnId so
        // future SSE events (turn_queued, user_message) can find it.
        // If turn_queued already arrived (race), drain the buffer and
        // apply the ahead-count in the same setMessages pass.
        if (turnId) {
          const perSession = pendingQueuedEventsRef.current.get(key);
          const bufferedAhead = perSession?.get(turnId);
          if (perSession && bufferedAhead !== undefined) {
            perSession.delete(turnId);
            if (perSession.size === 0) pendingQueuedEventsRef.current.delete(key);
          }
          setMessages((prev) => {
            const list = prev[key];
            if (!list) return prev;
            const next = list.map((m) => {
              if (m.id !== localId) return m;
              if (m.role !== 'user') return m;
              return {
                ...m,
                turnId,
                ...(bufferedAhead !== undefined ? { queued: { ahead: bufferedAhead } } : {}),
              };
            });
            return { ...prev, [key]: next };
          });
        }
      } catch (err) {
        // Send failed — remove the pending dedupe entry so a future
        // identical text can still be echoed normally.
        const cur = pendingSelfSendsRef.current.get(key) ?? [];
        const i = cur.indexOf(text);
        if (i >= 0) {
          cur.splice(i, 1);
          pendingSelfSendsRef.current.set(key, cur);
        }
        // Drop the optimistic bubble — it never reached the server. A
        // forever-`pending` bubble would anchor every future assistant
        // reply ABOVE it (see the chat:delta anchor logic) and make the
        // message look sent. ChatWindow's catch surfaces the error and
        // restores the draft.
        setMessages((prev) => {
          const list = prev[key];
          if (!list) return prev;
          return { ...prev, [key]: list.filter((m) => m.id !== localId) };
        });
        throw err;
      }
    },
    [appendMessage],
  );

  const abort = useCallback<ChatContextValue['abort']>(async (agent, session) => {
    return api.abort(agent, session);
  }, []);

  const subscribeAudio = useCallback<ChatContextValue['subscribeAudio']>(
    (agent, session, handler) => {
      const key = sessionKey(agent, session);
      let set = audioListenersRef.current.get(key);
      if (!set) {
        set = new Set();
        audioListenersRef.current.set(key, set);
      }
      set.add(handler);
      return () => {
        const cur = audioListenersRef.current.get(key);
        if (cur) {
          cur.delete(handler);
          if (cur.size === 0) audioListenersRef.current.delete(key);
        }
      };
    },
    [],
  );

  const loadOlder = useCallback<ChatContextValue['loadOlder']>(
    async (agent, session) => {
      const key = sessionKey(agent, session);
      const cur = paginationRef.current.get(key);
      if (!cur) return false;
      if (!cur.hasMore || cur.inFlight || cur.oldestTs === null) return cur.hasMore;
      const entry = sourcesRef.current.get(key);
      cur.inFlight = true;
      paginationRef.current.set(key, cur);
      setPaginationTick((t) => t + 1);
      try {
        const res = await api.history(agent, session, {
          limit: OLDER_PAGE_SIZE,
          before: cur.oldestTs,
          ...(entry ? { signal: entry.ac.signal } : {}),
        });
        const olderMessages = historyEventsToMessages(res.events);
        if (olderMessages.length > 0) {
          setMessages((prev) => ({
            ...prev,
            [key]: [...olderMessages, ...(prev[key] ?? [])],
          }));
        }
        const next = {
          hasMore: Boolean(res.hasMore),
          oldestTs: typeof res.oldestTs === 'number' ? res.oldestTs : cur.oldestTs,
          inFlight: false,
        };
        paginationRef.current.set(key, next);
        setPaginationTick((t) => t + 1);
        return next.hasMore;
      } catch (err) {
        cur.inFlight = false;
        paginationRef.current.set(key, cur);
        setPaginationTick((t) => t + 1);
        if ((err as Error).name === 'AbortError') return cur.hasMore;
        // eslint-disable-next-line no-console
        console.warn('[somora-web] loadOlder failed', key, (err as Error).message);
        return cur.hasMore;
      }
    },
    [],
  );

  const getHasMore = useCallback<ChatContextValue['getHasMore']>(
    (agent, session) => {
      // paginationTick is read so React re-runs this when state moves.
      void paginationTick;
      return paginationRef.current.get(sessionKey(agent, session))?.hasMore ?? false;
    },
    [paginationTick],
  );

  const clearMessages = useCallback<ChatContextValue['clearMessages']>(
    (agent, session) => {
      const key = sessionKey(agent, session);
      setMessages((prev) => ({ ...prev, [key]: [] }));
      // Reset transient streaming refs so a stale tracked-id from
      // before the reset doesn't try to mutate a non-existent bubble
      // when the next chat:delta arrives.
      streamingIdRef.current.delete(key);
      pendingSelfSendsRef.current.delete(key);
      pendingQueuedEventsRef.current.delete(key);
      // Stream state (usage, memory snapshot) clears too — fresh
      // session means none of those snapshots apply anymore.
      patchStream(key, {
        thinking: false,
        streaming: false,
        usage: null,
        memory: null,
      });
      // Pagination resets — the freshly-archived session has no older
      // history, the "load older" button should disappear.
      paginationRef.current.set(key, { hasMore: false, oldestTs: null, inFlight: false });
      setPaginationTick((t) => t + 1);
    },
    [patchStream],
  );

  // Cleanup on provider unmount (rare — App lives as long as the
  // page; but covers HMR + future router-based unmounts). Aborting
  // each entry's controller cancels in-flight history/loadOlder so
  // the resolver does not fire on a torn-down provider.
  useEffect(() => {
    return () => {
      for (const entry of sourcesRef.current.values()) {
        entry.es.close();
        entry.ac.abort();
      }
      sourcesRef.current.clear();
    };
  }, []);

  const refreshProject = useCallback<ChatContextValue['refreshProject']>(
    async (agent, session) => {
      const key = sessionKey(agent, session);
      try {
        const info = await api.sessionProject(agent, session);
        patchStream(key, { project: info.project });
      } catch {
        /* leave previous state — caller can retry */
      }
    },
    [patchStream],
  );

  const streamingKeys = useMemo(
    () =>
      Object.entries(streams)
        .filter(([, s]) => s.streaming)
        .map(([k]) => k),
    [streams],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      projectsEnabled,
      subscribe,
      getMessages,
      getStream,
      streamingKeys,
      send,
      subscribeAudio,
      abort,
      loadOlder,
      getHasMore,
      clearMessages,
      refreshProject,
    }),
    [
      projectsEnabled,
      subscribe,
      getMessages,
      getStream,
      streamingKeys,
      send,
      subscribeAudio,
      abort,
      loadOlder,
      getHasMore,
      clearMessages,
      refreshProject,
    ],
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
    send: (
      text: string,
      attachments?: AttachmentRef[],
      voice?: { inputModality?: 'voice'; autoPlayRequested?: boolean; sttProvider?: string },
    ) => ctx.send(agent, session, text, attachments, voice),
    abort: () => ctx.abort(agent, session),
    loadOlder: () => ctx.loadOlder(agent, session),
    hasMore: ctx.getHasMore(agent, session),
    clearMessages: () => ctx.clearMessages(agent, session),
    refreshProject: () => ctx.refreshProject(agent, session),
    subscribeAudio: (handler: (url: string) => void) =>
      ctx.subscribeAudio(agent, session, handler),
    projectsEnabled: ctx.projectsEnabled,
  };
}

/**
 * Convert a history-event list into chat messages, folding any
 * assistant_audio events onto the most recent preceding assistant
 * message. Used at session-open + load-older. Live SSE handles
 * assistant_audio separately in the SSE listener.
 */
function historyEventsToMessages(events: HistoryEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  // model_fallback precedes the fallback engine's output: stamp the
  // NEXT assistant message with it.
  let pendingFallback: ModelFallback | null = null;
  for (const e of events) {
    if (e.kind === 'model_fallback') {
      if (typeof e.requested === 'string' && typeof e.actual === 'string') {
        pendingFallback = { requested: e.requested, actual: e.actual, reason: e.reason ?? '' };
      }
      continue;
    }
    if (pendingFallback && e.kind === 'assistant_message') {
      const msgs = historyEventToMessages(e);
      out.push(
        ...msgs.map((m) => (m.role === 'assistant' ? { ...m, fallback: pendingFallback as ModelFallback } : m)),
      );
      pendingFallback = null;
      continue;
    }
    if (e.kind === 'assistant_images' && Array.isArray(e.images) && e.images.length > 0) {
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const m = out[i];
        if (m && m.role === 'assistant') {
          out[i] = { ...m, images: e.images };
          break;
        }
      }
      continue;
    }
    if (e.kind === 'assistant_audio' && e.audio) {
      // Attach to most recent assistant message in the current accumulator.
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const m = out[i];
        if (m && m.role === 'assistant') {
          out[i] = {
            ...m,
            audio: {
              url: e.audio.url,
              mime: e.audio.mime,
              ...(e.audio.durationMs !== undefined ? { durationMs: e.audio.durationMs } : {}),
              cacheKey: e.audio.cacheKey,
            },
          };
          break;
        }
      }
      continue;
    }
    out.push(...historyEventToMessages(e));
  }
  return out;
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
        ...(e.from_system ? { fromSystem: e.from_system } : {}),
        ...(e.attachments && e.attachments.length > 0
          ? {
              attachments: e.attachments.map((a) => ({
                hash: a.hash,
                name: a.name,
                mime: a.mime,
                size: a.size,
                kind: kindFromMime(a.mime),
              })),
            }
          : {}),
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
  if (e.kind === 'engine_meta' && typeof e.itemType === 'string') {
    const engine = e.engine ?? 'unknown';
    const label = resolveEngineMetaLabel(engine, e.itemType);
    let summary: string | undefined;
    if (engine === 'codex-cli' && e.itemType === 'todo_list') {
      const items = extractTodoListItems(e.payload);
      if (items) summary = summariseTodoList(items);
    }
    return [
      {
        id: newId('h-em'),
        role: 'engine_meta',
        ts: e.ts,
        meta: {
          engine,
          itemType: e.itemType,
          label,
          ...(summary ? { summary } : {}),
          payload: e.payload,
        },
      },
    ];
  }
  return [];
}

function kindFromMime(mime: string): 'image' | 'pdf' | 'text' {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}
