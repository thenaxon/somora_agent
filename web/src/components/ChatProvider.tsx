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
import type {
  ChatMessage,
  ChatUsage,
  MemoryHitsSnapshot,
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
}

const initialStreamState: SessionStreamState = {
  streaming: false,
  thinking: false,
  loading: false,
  connected: false,
  usage: null,
  memory: null,
  project: null,
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
  abort: (agent: string, session: string) => Promise<void>;
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
  abort: async () => {},
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
  // Pagination cursor per session: where the loaded slice begins
  // (oldestTs), whether older messages exist beyond, and a guard
  // against concurrent loadOlder calls.
  const paginationRef = useRef<
    Map<string, { hasMore: boolean; oldestTs: number | null; inFlight: boolean }>
  >(new Map());
  // Bumped whenever pagination state changes — drives consumers'
  // re-renders since refs themselves don't trigger React updates.
  const [paginationTick, setPaginationTick] = useState(0);

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
      const ac = new AbortController();
      sourcesRef.current.set(key, { es, refs: 1, loaded: false, ac });
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
        // Single assistant bubble per turn, always at the bottom of
        // the list. Server emits cumulative text in each delta, so
        // we replace the bubble's text in place. When a tool event
        // arrives mid-stream the tool gets appended, and the next
        // delta MOVES the bubble back to the end — ensuring tools
        // always render ABOVE the agent's running text (TUI-style)
        // and the cumulative prefix never duplicates.
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
          if (!trackedId) {
            trackedId = newId('msg');
            streamingIdRef.current.set(key, trackedId);
          }
          const id = trackedId;
          setMessages((prev) => {
            const list = prev[key] ?? [];
            const filtered = list.filter((m) => m.id !== id);
            return {
              ...prev,
              [key]: [
                ...filtered,
                {
                  id,
                  role: 'assistant',
                  ts: Date.now(),
                  text: d.text,
                  streaming: true,
                },
              ],
            };
          });
        } else if (d.state === 'final') {
          const id = streamingIdRef.current.get(key) ?? newId('msg');
          streamingIdRef.current.delete(key);
          setMessages((prev) => {
            const list = prev[key] ?? [];
            const filtered = list.filter((m) => m.id !== id);
            return {
              ...prev,
              [key]: [
                ...filtered,
                {
                  id,
                  role: 'assistant',
                  ts: Date.now(),
                  text: d.text,
                },
              ],
            };
          });
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
        appendMessage(key, {
          id: newId('mi'),
          role: 'memory_inject',
          ts: Date.now(),
          memory: snapshot,
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

      es.addEventListener('assistant_audio', (ev) => {
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
    entry.ac.abort();
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
      appendMessage(key, {
        id: newId('local-user'),
        role: 'user',
        ts: Date.now(),
        text,
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
        await api.send(agent, session, text, attachments, voice);
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
  for (const e of events) {
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
  return [];
}

function kindFromMime(mime: string): 'image' | 'pdf' | 'text' {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}
