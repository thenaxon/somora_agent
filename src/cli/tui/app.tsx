import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, measureElement, useApp, useInput, useWindowSize, type DOMElement } from 'ink';

import { Api } from './api.ts';
import { openStream, type StreamHandle } from './stream.ts';
import { herdrState, reportHerdr } from './herdr.ts';
import { openActivityStream } from './activity-stream.ts';
import { matchCommands, runCommand } from './commands.ts';
import { Header } from './header.tsx';
import { Editor, type EditorEdges } from './editor.tsx';
import { resolveEngineMetaLabel, summariseEngineMeta } from '../../engine/engine-meta-labels.ts';
import { Footer } from './footer.tsx';
import { Separator } from './separator.tsx';
import { MAX_VISIBLE, SlashAutocomplete } from './autocomplete.tsx';
import { AgentBody, TurnView } from './turn-views.tsx';
import { THINKING_TAIL_LINES, tailLines } from './thinking-text.ts';
import { nextId, summarize } from './format.ts';
import { INPUT_HISTORY_MAX, readInputHistory, rememberAgent, writeInputHistory } from './state.ts';
import { searchHistory } from './editor-model.ts';
import { formatWorkCounters } from './work-queue.ts';
import { explodeTurn, itemsAboveView } from './layout.ts';
import { endsMidTurn, lastUserTs, missedEvents } from './resync.ts';
import { loopbackFetch } from '../../server/loopback-fetch.ts';
import { BANNER_COMPACT, BANNER_MOTTO, BANNER_TAGLINE, BANNER_TAGLINE_SHORT, BANNER_WIDE, bannerShape, isUtf8Locale } from '../banner.ts';
import type {
  AgentInfo,
  PendingQueuedTurn,
  ProjectInfo,
  SessionQuestion,
  SessionWork,
  StreamEvent,
  Turn,
  TurnStats,
} from './types.ts';

interface Props {
  base: string;
  initialAgent: string;
  initialSession: string;
  initialShowMemory: boolean;
  initialShowTools: boolean;
  initialVerboseTools: boolean;
  initialVerboseMemory: boolean;
  initialVerboseSystem: boolean;
  initialVerboseThinking: boolean;
}



/** One line for the scrollback when a fallback model takes over a turn.
 *  With a chain, every failed hop is named so the operator sees which
 *  hosts were down — the ⇄ chip in /web carries the same list. */
/** The question as a notice with numbered options: "probe asks for
 *  permission: exec: rm -rf /tmp/x — 1 Allow once · 2 Reject (type the
 *  number)". */
export function questionNotice(agent: string, q: SessionQuestion): string {
  const kinds = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
  const optionLines = (options: SessionQuestion['options']): string[] =>
    options.map((o, i) => `   ${i + 1} ${o.label}${o.description && !kinds.has(o.description) ? ` — ${o.description}` : ''}`);
  // Several questions at once (async only): each with its options; the
  // answer is whatever you write next.
  // What is decided on, in full, before the question (indented).
  const details = q.details ? `${q.details.split('\n').map((l) => `   ${l}`).join('\n')}\n` : '';
  if (q.async && q.parts && q.parts.length > 1) {
    const blocks = q.parts.map((p) => [`❓ ${p.question}`, ...optionLines(p.options)].join('\n'));
    return `${details}${blocks.join('\n')}\n   answer in your own words (${agent} asks; answer any time)`;
  }
  const lines = optionLines(q.options);
  const how = q.options.length === 0 ? 'answer in your own words' : q.multiple ? 'type the numbers, e.g. 1,3' : 'type the number';
  const tail = !q.async ? `(${agent} waits)` : `${lines.length > 0 ? 'or write your own answer ' : ''}(${agent} asks; answer any time)`;
  return `${details}❓ ${q.question}${lines.length > 0 ? `\n${lines.join('\n')}` : ''}\n   ${how} ${tail}`;
}

function fallbackNotice(fb: {
  requested: string;
  actual: string;
  reason: string;
  hops?: Array<{ model: string; reason: string }>;
}): string {
  const hops = fb.hops && fb.hops.length > 0 ? fb.hops : [{ model: fb.requested, reason: fb.reason }];
  const failed = hops.map((h) => `${h.model} (${h.reason || 'no reason given'})`).join(', ');
  return `⇄ model fallback: ${failed} failed before producing anything — answering with ${fb.actual}`;
}

/** Turns of a session's history that are laid out in the frame when it
 *  opens; older ones go straight to the scrollback. More than a screen
 *  holds, so the flush trims it to what is visible. */
const LIVE_TAIL = 60;

/** Rows of the bottom panel with the command list closed: the blank row
 *  and the separator, the status line, the input, the hints. */
const BOTTOM_PANEL_ROWS = 5;

export function App({
  base,
  initialAgent,
  initialSession,
  initialShowMemory,
  initialShowTools,
  initialVerboseTools,
  initialVerboseMemory,
  initialVerboseSystem,
  initialVerboseThinking,
}: Props) {
  const { exit } = useApp();
  const apiRef = useRef(new Api(base));
  const bannerShownRef = useRef(false);

  const [agent, setAgent] = useState(initialAgent);
  const [session, setSession] = useState(initialSession);
  const [turns, setTurns] = useState<Turn[]>([]);
  // The frame (docs/display.md "The screen", layout.ts): `turns` from
  // `flushedCount` on are drawn in the frame's chat area; those before it
  // have left the top of the screen and live in the terminal's
  // scrollback through <Static>.
  const [flushedCount, setFlushedCount] = useState(0);
  const { rows: termRows, columns: termCols } = useWindowSize();
  const termColsRef = useRef(termCols);
  termColsRef.current = termCols;
  const inputBoxRef = useRef<DOMElement>(null);
  const editorEdgesRef = useRef<EditorEdges>({ atTop: true, atBottom: true });
  const viewRef = useRef<DOMElement>(null);
  const liveRefs = useRef(new Map<string, DOMElement>());
  const tailRef = useRef<DOMElement>(null);
  const [streamingText, setStreamingText] = useState<string>('');
  // Cumulative thinking text of the in-flight turn (SSE `thinking`
  // deltas). Rendered as a gray tail while the reply text is still
  // empty; folded into a `thinking` Turn at agent-end when /verbose
  // thinking is on, discarded otherwise. The ref is the source of
  // truth for agent-end (reads synchronously, no updater ordering
  // games); the state only drives the streaming view.
  const [streamingThinking, setStreamingThinking] = useState<string>('');
  const streamingThinkingRef = useRef<{ text: string; truncated: boolean }>({
    text: '',
    truncated: false,
  });
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<TurnStats | null>(null);
  // The model the session's next turn uses. `stats.model` is the last
  // turn's; a switch from another client or an agent shows up here at
  // once (session_model event), not only after the next turn.
  const [nextModel, setNextModel] = useState<{ label: string; modelId: string } | null>(null);
  const refreshNextModel = (a: string, s: string): void => {
    apiRef.current
      .fetchSessionModel(a, s)
      .then((info) => {
        if (!info || !isCurrent(a, s)) return;
        setNextModel({ label: info.alias ?? info.modelId, modelId: info.modelId });
        // Stats restored from the history carry no window; the session's
        // model has it when it is the one that answered last.
        setStats((prev) =>
          prev && prev.contextWindow === null && prev.model && (prev.model === info.modelId || prev.model.endsWith(`/${info.modelId}`))
            ? { ...prev, contextWindow: info.contextWindow }
            : prev,
        );
      })
      .catch(() => {
        /* keep the previous value */
      });
  };
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentIcons, setAgentIcons] = useState<Record<string, string>>({});
  // External agents (docs/external-agents.md): name → status-line label
  // shown instead of a model ("external · OpenClaw 2026.10.3").
  const [externalLabels, setExternalLabels] = useState<Record<string, string>>({});
  // The session's open question (an external agent asking permission):
  // answered by typing an option's number.
  const [openQuestion, setOpenQuestionState] = useState<SessionQuestion | null>(null);
  const openQuestionRef = useRef<SessionQuestion | null>(null);
  const setOpenQuestion = (q: SessionQuestion | null): void => {
    openQuestionRef.current = q;
    setOpenQuestionState(q);
  };
  const [showMemory, setShowMemory] = useState(initialShowMemory);
  const [showTools, setShowTools] = useState(initialShowTools);
  const [verboseTools, setVerboseTools] = useState(initialVerboseTools);
  const [verboseMemory, setVerboseMemory] = useState(initialVerboseMemory);
  const [verboseSystem, setVerboseSystem] = useState(initialVerboseSystem);
  const [verboseThinking, setVerboseThinking] = useState(initialVerboseThinking);
  // Refs so the SSE handler always sees the current toggle without
  // re-subscribing the stream on every flip.
  const showMemoryRef = useRef(showMemory);
  const showToolsRef = useRef(showTools);
  const verboseThinkingRef = useRef(verboseThinking);
  // Pending self-sent texts. Server now echoes user_message events
  // for every /chat/send so other clients (a web tab on the same
  // session) see them live. The TUI's own optimistic local-user
  // turn already covers its own sends, so we drop matching echoes
  // by recent-text instead of double-rendering.
  const pendingSelfSendsRef = useRef<string[]>([]);
  // Self-sent turns the user fired while another turn was already
  // running. These DO NOT go straight into the Static-flushed
  // scrollback because the entry needs to mutate (queued · 1 ahead
  // → queued · 2 ahead → done) over its lifetime, and Static items
  // are immutable after flush. Rendered in the dynamic frame above
  // the input; promoted to a real Turn (appendTurn) when the
  // server's user_message SSE event fires with the matching turnId.
  const [pendingQueued, setPendingQueued] = useState<PendingQueuedTurn[]>([]);
  // The same list, current at once: SSE handlers decide on it in the
  // same tick (2026-11-22, Codex review). Reading a flag set inside a
  // state updater was always stale; every change goes through
  // updatePendingQueued so both stay equal.
  const pendingQueuedRef = useRef<PendingQueuedTurn[]>([]);
  // Resync after a (re)connect (resync.ts): the newest user message
  // shown, whether the opened history ended inside a turn, whether a
  // reply was streaming, and a counter of live events that changed the
  // chat — a resync answer older than the newest of those is dropped.
  const lastUserTsRef = useRef<number | null>(null);
  const openedMidTurnRef = useRef(false);
  const streamingRef = useRef(false);
  const liveSeqRef = useRef(0);
  // What the stream showed while a resync read the history: user
  // messages (by timestamp) and turn ends, each with its liveSeq.
  const liveLogRef = useRef<Array<{ seq: number; kind: 'user' | 'end'; ts?: number }>>([]);
  // The history read last ended inside a turn that is still running.
  const unfinishedTurnRef = useRef(false);
  // Echoes of a self-typed message whose POST had not returned yet:
  // shown at once, and the queued row goes when the POST names the id.
  const earlyEchoRef = useRef(new Set<string>());
  // Question events seen on the stream; a question snapshot fetched
  // before the newest of them is stale.
  const questionSeqRef = useRef(0);
  streamingRef.current = streaming;
  // The (agent, session) on screen now. An answer to a request made for
  // another one is dropped (Codex review 2026-11-22): a slow model,
  // project or work lookup from the session just left must not dress the
  // new one in its values.
  const currentKeyRef = useRef('');
  currentKeyRef.current = `${agent}\u0000${session}`;
  const isCurrent = (a: string, s: string): boolean => currentKeyRef.current === `${a}\u0000${s}`;
  const updatePendingQueued = (next: PendingQueuedTurn[] | ((prev: PendingQueuedTurn[]) => PendingQueuedTurn[])): void => {
    const value = typeof next === 'function' ? next(pendingQueuedRef.current) : next;
    pendingQueuedRef.current = value;
    setPendingQueued(value);
  };
  // turn_dequeued that arrived before our POST returned its turnId.
  const earlyDequeuedRef = useRef(new Set<string>());
  // turn_queued SSE events that arrived before the matching POST
  // /chat/send response returned the turnId. Keyed by turnId; drained
  // by handleSubmit once the id is known.
  const pendingQueuedBufferRef = useRef<Map<string, number>>(new Map());
  // The session's work queue (GET …/work): drives the `⌛3 ▶1 🤖2`
  // counters in the status line. Refetched on the turn lifecycle
  // events (turn_queued, turn_dequeued, turn start/end), on /queue rm
  // and on session switch — never polled while idle. The /queue
  // command fetches its own fresh copy for the listing.
  const [work, setWork] = useState<SessionWork | null>(null);
  const workFetchSeq = useRef(0);
  function refreshWork(forAgent = agent, forSession = session): void {
    const seq = ++workFetchSeq.current;
    apiRef.current
      .fetchWork(forAgent, forSession)
      .then((w) => {
        // A later fetch (or a session switch) wins over a slow earlier one.
        if (seq === workFetchSeq.current && isCurrent(forAgent, forSession)) setWork(w);
      })
      .catch(() => {
        /* server unreachable — keep the previous counters */
      });
  }
  useEffect(() => {
    const current = work?.agent === agent && work.session === session ? work : null;
    const state = herdrState(connected && current !== null, openQuestion !== null, busy || streaming, current);
    reportHerdr(agent, session, state, `${agent}:${session}${state === 'unknown' ? ' · synchronizing / disconnected' : ''}`);
  }, [agent, session, connected, openQuestion, busy, streaming, work]);
  useEffect(() => {
    showMemoryRef.current = showMemory;
  }, [showMemory]);
  useEffect(() => {
    showToolsRef.current = showTools;
  }, [showTools]);
  useEffect(() => {
    verboseThinkingRef.current = verboseThinking;
  }, [verboseThinking]);

  // Submit-history (newest at the end). Up/Down step through it.
  const [history, setHistory] = useState<string[]>(() => readInputHistory());
  // Ctrl+R: the query and the history entry it found (-1: none).
  const [search, setSearch] = useState<{ query: string; index: number; draft: string } | null>(null);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState<string>('');
  const [reviewLoop, setReviewLoop] = useState<{ agent: string; dreamId: string } | null>(null);
  // Currently-pinned project for (agent, session). Refetched on
  // agent/session change, on /projekt slash command (via
  // projectFocusRefresh action), and on SSE 'project' events.
  const [project, setProject] = useState<ProjectInfo | null>(null);
  // Feature-flag fetched once at App mount. Hides /projekt commands
  // from autocomplete + /help and stops the chip-related effects from
  // firing useless GETs.
  const [projectsEnabled, setProjectsEnabled] = useState<boolean>(false);
  // Mirrored into a ref for the SSE handler: the stream's for-await
  // loop captures applyEvent from the render its effect ran in (deps
  // are agent/session only), so reading the state value there would
  // see the mount-time `false` forever in single-agent sessions —
  // the agent-end project refetch would never fire.
  const projectsEnabledRef = useRef(projectsEnabled);
  useEffect(() => {
    projectsEnabledRef.current = projectsEnabled;
  }, [projectsEnabled]);
  useEffect(() => {
    let cancelled = false;
    apiRef.current
      .fetchProjectsEnabled()
      .then((enabled) => {
        if (!cancelled) setProjectsEnabled(enabled);
      })
      .catch(() => {
        /* server unreachable — leave the feature off */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-agent activity tracking (mirrors web/mobile). Single SSE on
  // /activity/stream feeds two derived Sets: `streamingKeysActivity`
  // (any agent::session currently mid-turn server-wide) and
  // `unreadMarks` (per-(agent,session) unreadAt + seenAt timestamps).
  // The current (agent, session) the user is viewing is auto-marked
  // seen on every (agent, session) change.
  const [streamingKeysActivity, setStreamingKeysActivity] = useState<Set<string>>(() => new Set());
  const [unreadMarks, setUnreadMarks] = useState<Record<string, { unreadAt: string | null; seenAt: string | null }>>({});

  // Slash-autocomplete: matched against the input prefix, only when the
  // input is a single token starting with `/`. Index is the highlighted
  // suggestion (Tab cycles).
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  // The list a Tab started stepping through, and what it filled in last;
  // typing anything else ends the cycle (its `filled` no longer matches).
  const tabCycleRef = useRef<{ options: ReturnType<typeof matchCommands>; index: number; filled: string } | null>(null);

  const agentIcon = agentIcons[agent] ?? '';

  const slashMatches = useMemo(() => {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return [];
    if (trimmed.includes(' ')) return []; // user is typing args, hide popup
    return matchCommands(trimmed, { projects: projectsEnabled });
  }, [input, projectsEnabled]);

  const safeAutocompleteIndex =
    slashMatches.length > 0 ? autocompleteIndex % slashMatches.length : 0;

  // Reset highlight to first match whenever the match-set changes (typing
  // narrows the list).
  useEffect(() => {
    setAutocompleteIndex(0);
  }, [slashMatches.length, slashMatches[0]?.name]);

  // Fetch agents on mount and whenever we switch — populates icon-by-name
  // map. Cheap call, the listing is tiny.
  useEffect(() => {
    let cancelled = false;
    apiRef.current
      .fetchAgents()
      .then((list: AgentInfo[]) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        const labels: Record<string, string> = {};
        for (const a of list) {
          if (a.icon) next[a.name] = a.icon;
          else if (a.external) next[a.name] = a.external.badge;
          if (a.external) labels[a.name] = `external · ${a.external.label}${a.external.version ? ` ${a.external.version}` : ''}`;
        }
        setAgentIcons(next);
        setExternalLabels(labels);
      })
      .catch(() => {
        /* leave icons empty if endpoint is unreachable */
      });
    apiRef.current
      .fetchLoopState()
      .then((s) => {
        if (cancelled) return;
        if (s && s.active && s.agent && s.dreamId) {
          setReviewLoop({ agent: s.agent, dreamId: s.dreamId });
        } else {
          setReviewLoop(null);
        }
      })
      .catch(() => {
        /* server unreachable — leave loop indicator off */
      });
    // Pinned project for the current (agent, session). Skip the fetch
    // entirely when the feature is off — there's nothing to learn and
    // the request would 503. Chip never renders anyway since project
    // stays null.
    if (projectsEnabled) {
      apiRef.current
        .fetchSessionProject(agent, session)
        .then((info) => {
          if (cancelled) return;
          setProject(info.project);
        })
        .catch(() => {
          if (cancelled) return;
          setProject(null);
        });
    } else {
      setProject(null);
    }
    return () => {
      cancelled = true;
    };
  }, [agent, session, projectsEnabled]);

  // Activity-stream subscription. Single connection for the whole TUI
  // process; updates unreadMarks + streamingKeysActivity as events
  // arrive. Seeded via /sessions on connect (no separate refresh
  // mechanism — events keep us live after that).
  useEffect(() => {
    let cancelled = false;
    // Seed via /sessions global list. Cheap (one request) + gives us
    // every agent's state at once. Again after every reconnect of the
    // activity stream: a turn finished or a session read elsewhere while
    // it was down sends no event afterwards (Codex review 2026-11-22).
    // Each mark keeps the later of the two values, so a live event that
    // beat the snapshot is not undone by it.
    const seed = async (): Promise<void> => {
      try {
        const res = await loopbackFetch(`${base}/sessions`);
        if (!res.ok) return;
        const data = (await res.json()) as { sessions: Array<{ agent: string; sessionId: string; unreadAt?: string | null; seenAt?: string | null }> };
        if (cancelled) return;
        const later = (x: string | null, y: string | null): string | null => (x && y ? (x > y ? x : y) : x ?? y);
        setUnreadMarks((prev) => {
          const next = { ...prev };
          for (const s of data.sessions) {
            const k = `${s.agent}::${s.sessionId}`;
            const p = prev[k];
            next[k] = {
              unreadAt: later(s.unreadAt ?? null, p?.unreadAt ?? null),
              seenAt: later(s.seenAt ?? null, p?.seenAt ?? null),
            };
          }
          return next;
        });
      } catch {
        /* server unreachable — events will populate as they arrive */
      }
    };
    const h = openActivityStream(apiRef.current.activityStreamUrl(), (ev) => {
      if (cancelled) return;
      const k = `${ev.agent}::${ev.session}`;
      if (ev.kind === 'streaming') {
        setStreamingKeysActivity((prev) => {
          const next = new Set(prev);
          if (ev.phase === 'start') next.add(k);
          else next.delete(k);
          return next;
        });
        return;
      }
      if (ev.kind === 'turn') {
        setUnreadMarks((prev) => ({
          ...prev,
          [k]: { ...(prev[k] ?? { unreadAt: null, seenAt: null }), unreadAt: ev.unreadAt },
        }));
        return;
      }
      if (ev.kind === 'seen') {
        setUnreadMarks((prev) => ({
          ...prev,
          [k]: { ...(prev[k] ?? { unreadAt: null, seenAt: null }), seenAt: ev.seenAt },
        }));
        return;
      }
    }, () => void seed());
    return () => {
      cancelled = true;
      h.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  // Auto-mark the current view as seen whenever (agent, session)
  // changes. Optimistic local update first, then POST. Server clamps
  // to max(currentSeenAt, ts) and broadcasts the canonical value to
  // sibling clients (web + mobile + other TUIs).
  useEffect(() => {
    const now = new Date().toISOString();
    const k = `${agent}::${session}`;
    setUnreadMarks((prev) => ({
      ...prev,
      [k]: { ...(prev[k] ?? { unreadAt: null, seenAt: null }), seenAt: now },
    }));
    void apiRef.current.markSeen(agent, session);
  }, [agent, session]);

  // Derived: which OTHER agents (not the currently-viewed one) have
  // unread activity. Used by Header to render the 📬 N badge.
  const unreadOtherAgents = useMemo(() => {
    const out = new Set<string>();
    for (const [k, mark] of Object.entries(unreadMarks)) {
      if (!mark.unreadAt) continue;
      if (mark.seenAt && mark.unreadAt <= mark.seenAt) continue;
      const idx = k.indexOf('::');
      const a = k.slice(0, idx);
      if (a === agent) continue;
      out.add(a);
    }
    return out;
  }, [unreadMarks, agent]);

  // SSE lifecycle + history replay: on (agent, session) change clear
  // the scrollback, fetch past events from /chat/history and replay
  // them as scrollback Turns, THEN open the SSE stream for live
  // events. History fetch is best-effort — empty/failing returns
  // just give an empty starting state. SSE picks up events from
  // connect-time forward so there's no overlap with replay.
  useEffect(() => {
    let cancelled = false;
    setTurns([]);
    setFlushedCount(0);
    setStreaming(false);
    setBusy(false);
    setStats(null);
    setNextModel(null);
    refreshNextModel(agent, session);
    setOpenQuestion(null);
    updatePendingQueued([]);
    earlyDequeuedRef.current.clear();
    earlyEchoRef.current.clear();
    liveLogRef.current = [];
    unfinishedTurnRef.current = false;
    pendingQueuedBufferRef.current.clear();
    setWork(null);
    refreshWork(agent, session);
    // Drop stale self-send entries from the previous (agent, session)
    // — a leftover text would silently swallow the SAME text sent by
    // another client on the new session's stream.
    pendingSelfSendsRef.current = [];

    let handle: StreamHandle | null = null;

    (async () => {
      try {
        const { events } = await apiRef.current.fetchHistory(agent, session);
        if (cancelled) return;
        lastUserTsRef.current = lastUserTs(events);
        openedMidTurnRef.current = endsMidTurn(events);
        const replayed = mapHistoryToTurns(events).flatMap((t) => explodeTurn(t, nextId, termColsRef.current || 80));
        if (replayed.length > 0) {
          // Older turns go straight to the scrollback; the frame lays out
          // only the tail, and the flush below trims that to the screen.
          setFlushedCount(Math.max(0, replayed.length - LIVE_TAIL));
          setTurns(replayed);
          restoreLastTurnStats(events);
        } else if (!bannerShownRef.current) {
          // An empty session is greeted with the lettering — once per run.
          const shape = bannerShape({ isTTY: process.stdout.isTTY === true, columns: process.stdout.columns, utf8: isUtf8Locale() });
          if (shape !== 'none') {
            bannerShownRef.current = true;
            appendTurn({
              kind: 'banner',
              id: nextId(),
              lines: shape === 'wide' ? BANNER_WIDE : BANNER_COMPACT,
              tagline: shape === 'wide' ? BANNER_TAGLINE : BANNER_TAGLINE_SHORT,
              hint: shape === 'wide' ? `${BANNER_MOTTO}  ·  type a message to start, /help for commands` : `${BANNER_MOTTO}  ·  /help for commands`,
            });
          }
        }
      } catch {
        /* history endpoint failures are non-fatal — leave scrollback empty */
      }

      if (cancelled) return;
      // A question already open (asked before this client looked) goes
      // below the replayed history; later ones arrive on the stream.
      try {
        const q = await apiRef.current.fetchSessionQuestion(agent, session);
        if (!cancelled && q) {
          setOpenQuestion(q);
          appendTurn({ kind: 'system', id: nextId(), text: questionNotice(agent, q), tone: 'warn' });
        }
      } catch {
        /* an older server has no such route */
      }

      if (cancelled) return;
      handle = openStream(
        apiRef.current.streamUrl(agent, session),
        (text, tone) => {
          if (cancelled) return;
          setConnected(false);
          appendTurn({ kind: 'system', id: nextId(), text, tone });
        },
      );
      const stream = handle;
      let connectedBefore = false;
      (async () => {
        for await (const ev of stream.events) {
          if (cancelled) break;
          applyEvent(ev);
          if (ev.kind === 'connected') {
            // The first connect closes the gap between the history read
            // above and the subscription; a later one the time without a
            // stream. A reply streaming when the stream dropped is what
            // may have ended meanwhile.
            const midTurn = connectedBefore ? streamingRef.current || unfinishedTurnRef.current : openedMidTurnRef.current;
            connectedBefore = true;
            const seq = liveSeqRef.current;
            const anchorAtStart = lastUserTsRef.current;
            void apiRef.current.fetchHistory(agent, session).then(({ events }) => {
              if (cancelled) return;
              const missed = missedEvents(events, anchorAtStart, midTurn);
              // What the stream delivered while this was read is on screen
              // already: cut the snapshot before the first user message the
              // stream showed, and drop the running turn's end when the
              // stream showed that end.
              const shownLive = liveLogRef.current.filter((e) => e.seq > seq);
              const firstLiveUser = Math.min(...shownLive.filter((e) => e.kind === 'user' && e.ts !== undefined).map((e) => e.ts!));
              const liveEnd = shownLive.some((e) => e.kind === 'end');
              const stop = missed.events.findIndex((ev) => ev.kind === 'user_message' && typeof ev.ts === 'number' && ev.ts >= firstLiveUser);
              let replay = stop >= 0 ? missed.events.slice(0, stop) : missed.events;
              if (liveEnd && midTurn) {
                const firstUser = replay.findIndex((ev) => ev.kind === 'user_message');
                replay = firstUser >= 0 ? replay.slice(firstUser) : [];
              }
              if (replay.length > 0) {
                const anchor = lastUserTs(replay);
                if (anchor !== null && (lastUserTsRef.current === null || anchor > lastUserTsRef.current)) lastUserTsRef.current = anchor;
                for (const t of mapHistoryToTurns(replay)) appendTurn(t);
                // A message this client queued may have started while the
                // stream was away: its row goes, the history has it now.
                const started = new Set(replay.filter((ev) => ev.kind === 'user_message' && !ev.from_agent && typeof ev.text === 'string').map((ev) => ev.text as string));
                if (started.size > 0) updatePendingQueued((prev) => prev.filter((p) => !started.has(p.text)));
              }
              if (missed.skippedTools > 0 && !(liveEnd && midTurn)) {
                appendTurn({ kind: 'system', id: nextId(), text: `${missed.skippedTools} tool call${missed.skippedTools === 1 ? '' : 's'} of that turn ${missed.skippedTools === 1 ? 'is' : 'are'} not repeated here; /export has ${missed.skippedTools === 1 ? 'it' : 'them'}`, tone: 'info' });
              }
              if (missed.turnEnded && !liveEnd) {
                restoreLastTurnStats(events);
                setStreamingText('');
                setStreamingThinking('');
                setStreaming(false);
                setBusy(false);
              }
              // A turn that is still running per the history: shown as
              // running, and remembered for the next reconnect.
              unfinishedTurnRef.current = endsMidTurn(events) && !liveEnd;
              if (unfinishedTurnRef.current && !streamingRef.current) {
                streamingRef.current = true;
                setStreaming(true);
              }
              openedMidTurnRef.current = false;
              liveLogRef.current = liveLogRef.current.filter((e) => e.seq > liveSeqRef.current - 50);
              refreshWork(agent, session);
            }).catch(() => {});
            // The open question: dropped when a question event arrived
            // while it was being read; one found only here is shown with
            // its options, or a number would answer a question nobody saw.
            const qSeq = questionSeqRef.current;
            void apiRef.current.fetchSessionQuestion(agent, session).then((q) => {
              if (cancelled || questionSeqRef.current !== qSeq) return;
              const shown = openQuestionRef.current;
              if (q && shown?.id !== q.id) appendTurn({ kind: 'system', id: nextId(), text: questionNotice(agent, q), tone: 'warn' });
              setOpenQuestion(q);
            }).catch(() => {});
          }
        }
      })().catch(() => {
        /* iterator close — nothing to do */
      });
    })();

    return () => {
      cancelled = true;
      handle?.close();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, session]);

  /**
   * Convert raw JSONL history events into TUI Turn entries. Skips
   * deltas, turn-boundaries, errors — those are noise for replay.
   * Tool events render as collapsed `tool` rows respecting the same
   * showTools/showMemory toggles as live events do (we don't read
   * the toggles here; we always emit the rows and let the renderer
   * filter via the existing showToolsRef path... actually for replay
   * we just emit them and trust the user can toggle). For simplicity
   * we ALWAYS emit tool rows on replay — the user can /show tools off
   * to hide globally.
   */
  function mapHistoryToTurns(events: import('./api.ts').HistoryEvent[]): Turn[] {
    const out: Turn[] = [];
    // Ids from the client-wide counter: rows replayed after a reconnect
    // join rows of the first replay, and two with one id would share a
    // React key and a measurement slot (Codex review 2026-11-22).
    const nid = nextId;
    // History events come from JSONL with raw `mcp__<server>__<tool>`
    // tool names; the SSE serializer strips this prefix on the live
    // path. Replay needs the same shortening so the TUI doesn't show
    // mcp__somora__exec for old turns. Same regex as the
    // server's shortToolName helper.
    const stripMcpPrefix = (t: string): string => t.replace(/^mcp__[^_]+__/, '');
    for (const ev of events) {
      if (ev.kind === 'user_message' && typeof ev.text === 'string') {
        out.push({
          kind: 'user',
          id: nid(),
          text: ev.text,
          ...(ev.from_agent ? { fromAgent: ev.from_agent } : {}),
          ...(ev.from_agent && ev.from_session ? { fromSession: ev.from_session } : {}),
          ...(ev.from_system ? { fromSystem: ev.from_system } : {}),
          ...(ev.origin ? { origin: ev.origin } : {}),
        });
      } else if (ev.kind === 'assistant_message' && typeof ev.text === 'string') {
        out.push({ kind: 'agent', id: nid(), text: ev.text });
      } else if (ev.kind === 'thinking_message' && typeof ev.text === 'string') {
        // JSONL places the row before the turn's assistant_message, so
        // pushing in sequence keeps it above the reply. Only hydrated
        // when /verbose thinking is on at load time — off means the
        // user never asked to see reasoning, so don't backfill it.
        if (verboseThinkingRef.current && ev.text.length > 0) {
          out.push({
            kind: 'thinking',
            id: nid(),
            text: ev.text,
            ...(ev.truncated === true ? { truncated: true } : {}),
          });
        }
      } else if (ev.kind === 'tool_call' && typeof ev.tool === 'string') {
        out.push({
          kind: 'tool',
          id: nid(),
          tool: stripMcpPrefix(ev.tool),
          phase: 'call',
          summary: typeof ev.input === 'object' && ev.input ? safeStringify(ev.input, 60) : '',
        });
      } else if (ev.kind === 'tool_result' && typeof ev.tool === 'string') {
        if (ev.error) {
          out.push({
            kind: 'tool',
            id: nid(),
            tool: stripMcpPrefix(ev.tool),
            phase: 'error',
            error: summarize(ev.error, 200),
          });
        } else {
          out.push({
            kind: 'tool',
            id: nid(),
            tool: stripMcpPrefix(ev.tool),
            phase: 'result',
            summary: typeof ev.output === 'object' && ev.output ? safeStringify(ev.output, 60) : '',
          });
        }
      } else if (
        ev.kind === 'model_fallback' &&
        typeof ev.requested === 'string' &&
        typeof ev.actual === 'string'
      ) {
        out.push({
          kind: 'system',
          id: nid(),
          text: fallbackNotice({
            requested: ev.requested,
            actual: ev.actual,
            reason: typeof ev.reason === 'string' ? ev.reason : '',
            ...(Array.isArray(ev.hops) ? { hops: ev.hops as Array<{ model: string; reason: string }> } : {}),
          }),
          tone: 'warn',
        });
      } else if (
        ev.kind === 'engine_meta' &&
        typeof ev.engine === 'string' &&
        typeof ev.itemType === 'string'
      ) {
        // The same label and one-liner the server puts on the live
        // event (pure formatting, no server state), so a row reads the
        // same after a reload as it did when it arrived.
        const label = resolveEngineMetaLabel(ev.engine, ev.itemType);
        const summary = summariseEngineMeta(ev.engine, ev.itemType, ev.payload);
        let details: string | undefined;
        try {
          details = JSON.stringify(ev.payload, null, 2);
        } catch {
          details = undefined;
        }
        out.push({
          kind: 'engine_meta',
          id: nid(),
          engine: ev.engine,
          itemType: ev.itemType,
          label,
          ...(summary ? { summary } : {}),
          ...(details ? { details } : {}),
        });
      }
      // turn_start, turn_end, assistant_delta, error: skipped
      // memory injects don't live in JSONL — they're SSE-only
    }
    return out;
  }

  function safeStringify(value: unknown, maxLen: number): string {
    try {
      const s = JSON.stringify(value);
      return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
    } catch {
      return '';
    }
  }

  // A broken config.yaml: say so once per broken version (the server
  // keeps the last valid one, so an edit silently does nothing).
  const configProblemShownRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      const problem = await apiRef.current.fetchConfigProblem();
      if (!alive) return;
      if (!problem) {
        configProblemShownRef.current = null;
        return;
      }
      if (configProblemShownRef.current === problem.since) return;
      configProblemShownRef.current = problem.since;
      appendTurn({
        kind: 'system',
        id: nextId(),
        tone: 'error',
        text:
          'config.yaml does not validate — somora keeps running on the last valid version. Fix it (somora config check):\n' +
          problem.message.replace(/^config\.yaml is invalid \([^)]*\):\n/, ''),
      });
    };
    void check();
    const t = setInterval(() => void check(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function appendTurn(t: Turn): void {
    const items = explodeTurn(t, nextId, termColsRef.current || 80);
    setTurns((prev) => [...prev, ...items]);
  }

  // The status line after a session opens: the last turn's spend and
  // model come from its turn_end in the history, so they are there before
  // the next turn ends (docs/display.md "The status line"). The window
  // for the context fill is added when the session's model is known.
  function restoreLastTurnStats(events: import('./api.ts').HistoryEvent[]): void {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.kind !== 'turn_end' || !ev.usage) continue;
      // Turns from before 2026-09-21 do not name their model; their
      // counts beside the session's current model would mislead.
      if (!ev.model) return;
      setStats({
        tokensIn: ev.usage.tokens_in ?? 0,
        tokensInCached: ev.usage.tokens_in_cached ?? null,
        contextTokens: ev.usage.context_tokens ?? null,
        tokensOut: ev.usage.tokens_out ?? 0,
        tokensOutReasoning: ev.usage.tokens_out_reasoning ?? null,
        tokensOutReasoningEstimated: ev.usage.tokens_out_reasoning_estimated === true,
        contextWindow: null,
        provider: null,
        model: ev.model ?? null,
        thinking: null,
      });
      refreshNextModel(agent, session);
      return;
    }
  }

  // After every render: chat items whose last row is above the top of the
  // frame move into the scrollback (<Static>). Counted against the chat
  // area at its tallest — rows minus the bottom panel without the command
  // list — so items only hidden while the list is open stay in the frame
  // and come back when it closes.
  useEffect(() => {
    const live = turns.slice(flushedCount);
    if (live.length === 0 || !viewRef.current) return;
    const heights: number[] = [];
    for (const t of live) {
      const el = liveRefs.current.get(t.id);
      if (!el) return; // not laid out yet
      heights.push(measureElement(el).height);
    }
    const tail = tailRef.current ? measureElement(tailRef.current).height : 0;
    // The input wraps a long draft over several rows; the rest of the
    // closed panel is fixed.
    const inputRows = inputBoxRef.current ? measureElement(inputBoxRef.current).height : 1;
    const panel = BOTTOM_PANEL_ROWS - 1 + inputRows;
    const chatRows = Math.max(1, (termRows || 24) - panel);
    const n = itemsAboveView(heights, chatRows - tail);
    if (n > 0) setFlushedCount((c) => c + n);
  });

  function applyEvent(ev: StreamEvent): void {
    switch (ev.kind) {
      case 'connected':
        setConnected(true);
        refreshWork(agent, session);
        return;
      case 'session-model':
        refreshNextModel(agent, session);
        return;
      case 'agent-start':
        refreshWork(agent, session);
        setStreaming(true);
        setStreamingText('');
        setStreamingThinking('');
        streamingThinkingRef.current = { text: '', truncated: false };
        // If the server tells us the upcoming turn has a thinking level,
        // pre-set it on stats so the header can show the "🧠 thinking…"
        // pre-content badge before any tokens arrive.
        if (ev.thinking) {
          setStats((prev) => ({
            tokensIn: prev?.tokensIn ?? 0,
            tokensInCached: prev?.tokensInCached ?? null,
            contextTokens: prev?.contextTokens ?? null,
            tokensOut: prev?.tokensOut ?? 0,
            tokensOutReasoning: prev?.tokensOutReasoning ?? null,
            tokensOutReasoningEstimated: prev?.tokensOutReasoningEstimated ?? false,
            contextWindow: prev?.contextWindow ?? null,
            provider: prev?.provider ?? null,
            model: prev?.model ?? null,
            thinking: ev.thinking ?? null,
          }));
        }
        return;
      case 'chat-delta':
        // Opened (or reconnected) in the middle of a turn: there was no
        // agent-start, but a reply is streaming and Esc must stop it.
        if (!streamingRef.current) {
          streamingRef.current = true;
          setStreaming(true);
        }
        setStreamingText(ev.text);
        return;
      case 'chat-final':
        setStreamingText(ev.text);
        return;
      case 'thinking-delta':
        // Cumulative text, same convention as chat-delta.
        streamingThinkingRef.current = { text: ev.text, truncated: false };
        setStreamingThinking(ev.text);
        return;
      case 'thinking-final':
        streamingThinkingRef.current = { text: ev.text, truncated: ev.truncated === true };
        setStreamingThinking(ev.text);
        return;
      case 'agent-end': {
        liveSeqRef.current += 1;
        liveLogRef.current.push({ seq: liveSeqRef.current, kind: 'end' });
        unfinishedTurnRef.current = false;
        // Snapshot + clear the thinking buffer synchronously so the
        // updater below (which runs later, during render) sees the
        // turn's value, not the next turn's.
        const thinking = streamingThinkingRef.current;
        streamingThinkingRef.current = { text: '', truncated: false };
        setStreamingThinking('');
        const showThinking = verboseThinkingRef.current && thinking.text.trim().length > 0;
        setStreamingText((current) => {
          // Thinking turn goes BEFORE the reply it produced — mirrors
          // the JSONL order (thinking_message, then assistant_message).
          if (showThinking) {
            appendTurn({
              kind: 'thinking',
              id: nextId(),
              text: thinking.text,
              ...(thinking.truncated ? { truncated: true } : {}),
            });
          }
          if (current.length > 0) {
            appendTurn({ kind: 'agent', id: nextId(), text: current });
          }
          return '';
        });
        setStreaming(false);
        setBusy(false);
        refreshWork(agent, session);
        // Refresh wiki-review loop indicator after each turn — the
        // turn may have called dream_review({action:'start'|'end'}).
        apiRef.current.fetchLoopState().then((s) => {
          if (s && s.active && s.agent && s.dreamId) {
            setReviewLoop({ agent: s.agent, dreamId: s.dreamId });
          } else {
            setReviewLoop(null);
          }
        });
        // Refetch project too — the just-finished turn might have
        // called project_focus via the MCP-tool path (no SSE broadcast
        // for that route). Skip when feature is off. Read via ref —
        // this closure is captured at stream-open time, before the
        // feature-flag probe resolves.
        if (projectsEnabledRef.current) {
          apiRef.current.fetchSessionProject(agent, session).then((info) => {
            if (isCurrent(agent, session)) setProject(info.project);
          }).catch(() => {
            /* leave previous state */
          });
        }
        if (ev.usage || ev.contextWindow || ev.provider || ev.model || ev.thinking) {
          setStats({
            tokensIn: ev.usage?.tokens_in ?? 0,
            tokensInCached: ev.usage?.tokens_in_cached ?? null,
            contextTokens: ev.usage?.context_tokens ?? null,
            tokensOut: ev.usage?.tokens_out ?? 0,
            tokensOutReasoning: ev.usage?.tokens_out_reasoning ?? null,
            tokensOutReasoningEstimated: ev.usage?.tokens_out_reasoning_estimated ?? false,
            contextWindow: ev.contextWindow ?? null,
            provider: ev.provider ?? null,
            model: ev.model ?? null,
            thinking: ev.thinking ?? null,
          });
        }
        return;
      }
      case 'assistant-media':
        appendTurn({ kind: 'media', id: nextId(), items: ev.items });
        return;
      case 'memory':
        // Display-only suppression. The injection itself already happened
        // server-side; we just don't render the [memory · …] line.
        if (!showMemoryRef.current) return;
        appendTurn({
          kind: 'memory',
          id: nextId(),
          count: ev.count,
          topScore: ev.topScore,
          refs: ev.refs,
          fullText: ev.fullText,
        });
        return;
      case 'tool': {
        // Display-only suppression. Same caveat as memory: the tool ran,
        // we just hide the call/result line.
        if (!showToolsRef.current) return;
        const phase: 'call' | 'result' | 'error' =
          ev.phase === 'call' || ev.phase === 'result' || ev.phase === 'error'
            ? ev.phase
            : 'result';
        appendTurn({
          kind: 'tool',
          id: nextId(),
          tool: ev.tool,
          phase,
          summary: ev.summary,
          // For errors we don't summarize details (already short-string);
          // for call/result we keep the full pretty-printed payload so
          // /verbose tools can show it.
          details: phase === 'error' ? undefined : ev.details,
          error: phase === 'error' ? summarize(ev.error, 200) : undefined,
        });
        return;
      }
      case 'model-fallback': {
        appendTurn({ kind: 'system', id: nextId(), text: fallbackNotice(ev), tone: 'warn' });
        return;
      }
      case 'engine_meta': {
        // somora's own notes (model switched, compacted by hand) and
        // every compaction are for the reader, not engine internals:
        // shown with tools hidden too.
        if (!showToolsRef.current && ev.engine !== 'somora' && ev.itemType !== 'context_compacted') return;
        let details: string | undefined;
        try {
          details = JSON.stringify(ev.payload, null, 2);
        } catch {
          details = String(ev.payload);
        }
        appendTurn({
          kind: 'engine_meta',
          id: nextId(),
          engine: ev.engine,
          itemType: ev.itemType,
          label: ev.label,
          ...(ev.summary ? { summary: ev.summary } : {}),
          ...(details ? { details } : {}),
        });
        return;
      }
      case 'user-message': {
        liveSeqRef.current += 1;
        liveLogRef.current.push({ seq: liveSeqRef.current, kind: 'user', ...(ev.ts !== undefined ? { ts: ev.ts } : {}) });
        if (ev.ts !== undefined && (lastUserTsRef.current === null || ev.ts > lastUserTsRef.current)) {
          lastUserTsRef.current = ev.ts;
        }
        // A2A inbound: another agent wrote into the session we're
        // watching. Render as a user-turn tagged with the sender so
        // it's visually distinct from our own typed turns.
        //
        // Self-typed echoes (server now broadcasts user_message for
        // every /chat/send so other clients can see them) arrive
        // WITHOUT fromAgent. Two cases to handle for those:
        //   1. The text matches an entry in pendingSelfSendsRef →
        //      this TUI fired a send while idle; the optimistic
        //      Static append already represents it. Drop the echo.
        //   2. The turnId matches an entry in pendingQueued → this
        //      TUI fired a send while another turn was running.
        //      The pending-queued render in the dynamic frame now
        //      becomes a real Static turn — remove from pending,
        //      append to Static so the message lands in scrollback.
        // Self-typed echoes from OTHER clients (a web tab on the
        // same session as the TUI tail) pass through both checks
        // and render as normal user turns.
        if (!ev.fromAgent && !ev.fromSystem) {
          // Case 2 first — promote pending-queued to Static. The turn
          // is starting, so any buffered turn_queued ahead-count for
          // this turnId is moot — prune it (this also drops buffered
          // entries for OTHER clients' queued turns, which nothing
          // else would ever drain).
          // Matched by turnId, or by text while our POST has not
          // returned its turnId yet: the echo can beat the response
          // when the running turn ends just as we send.
          if (ev.turnId) pendingQueuedBufferRef.current.delete(ev.turnId);
          const queued = pendingQueuedRef.current;
          const qi = queued.findIndex((p) => ev.turnId !== undefined && p.turnId === ev.turnId);
          if (qi >= 0) {
            updatePendingQueued(queued.filter((_, i) => i !== qi));
            appendTurn({ kind: 'user', id: nextId(), text: ev.text });
            return;
          }
          // Our POST may still be out: the echo of a message with the
          // same text could be ours or another client's. Show it now;
          // when the POST returns this id, our queued row goes.
          if (ev.turnId !== undefined && queued.some((p) => p.turnId === undefined && p.text === ev.text)) {
            earlyEchoRef.current.add(ev.turnId);
            appendTurn({ kind: 'user', id: nextId(), text: ev.text });
            return;
          }
          // Case 1 — drop optimistic-already-rendered self-echo.
          const pending = pendingSelfSendsRef.current;
          const idx = pending.indexOf(ev.text);
          if (idx >= 0) {
            pending.splice(idx, 1);
            return;
          }
        }
        appendTurn({
          kind: 'user',
          id: nextId(),
          text: ev.text,
          ...(ev.fromAgent ? { fromAgent: ev.fromAgent } : {}),
          ...(ev.fromAgent && ev.fromSession ? { fromSession: ev.fromSession } : {}),
          ...(ev.fromSystem ? { fromSystem: ev.fromSystem } : {}),
          ...(ev.origin ? { origin: ev.origin } : {}),
        });
        return;
      }
      case 'turn-queued': {
        // Find the matching pending-queued entry (if any) and tag
        // it with the ahead-count. If the entry isn't there yet
        // (HTTP /chat/send response still in flight), buffer the
        // ahead-count so handleSubmit can apply it once the turnId
        // lands. The buffering decision lives INSIDE the updater —
        // an earlier version set a flag in the updater and read it
        // right after setPendingQueued returned, but updaters run at
        // flush time, so the flag was always stale-false and every
        // event landed in the buffer (entries for other clients'
        // turns then piled up forever). The ref mutation in here is
        // idempotent, so a double-invoked updater is harmless.
        {
          const prev = pendingQueuedRef.current;
          const idx = prev.findIndex((p) => p.turnId === ev.turnId);
          const existing = idx >= 0 ? prev[idx] : undefined;
          if (!existing) {
            pendingQueuedBufferRef.current.set(ev.turnId, ev.ahead);
          } else {
            const next = prev.slice();
            next[idx] = { ...existing, queued: { ahead: ev.ahead } };
            updatePendingQueued(next);
          }
        }
        refreshWork(agent, session);
        return;
      }
      case 'turn-dequeued': {
        // A waiting entry was removed (from this TUI via /queue rm, or
        // from another client). Our own pending-queued row for it —
        // if it was ours — would otherwise sit there forever, since
        // no user_message ever promotes it.
        pendingQueuedBufferRef.current.delete(ev.turnId);
        if (pendingQueuedRef.current.some((p) => p.turnId === ev.turnId)) {
          updatePendingQueued((prev) => prev.filter((p) => p.turnId !== ev.turnId));
        } else {
          // Our POST may not have returned this turnId yet.
          earlyDequeuedRef.current.add(ev.turnId);
        }
        refreshWork(agent, session);
        return;
      }
      case 'question':
        questionSeqRef.current += 1;
        setOpenQuestion(ev.question);
        appendTurn({ kind: 'system', id: nextId(), text: questionNotice(agent, ev.question), tone: 'warn' });
        return;
      case 'question-answered':
      {
        questionSeqRef.current += 1;
        // The event handler lives across renders (the stream loop), so
        // the open question is read from its ref, not from state.
        const q = openQuestionRef.current;
        if (q && (ev.questionId === null || ev.questionId === q.id)) {
          setOpenQuestion(null);
          // A non-waiting question answered in words (or replaced) needs
          // no line: the message itself is the answer.
          if (!q.async || ev.choice) {
            appendTurn({ kind: 'system', id: nextId(), text: `→ ${ev.choice ?? 'no answer — the safest option was taken'}`, tone: 'info' });
          }
        }
        return;
      }
      case 'project': {
        // Server broadcasts project focus changes on the HTTP path
        // (slash-command from any client, or DELETE via REST). On the
        // tool path (agent calling project_focus in an MCP child),
        // there's no SSE — the chat:final event triggers a refetch.
        // Refetch unconditionally here too so the chip reflects the
        // latest server state including the project's frontmatter.
        apiRef.current.fetchSessionProject(agent, session).then((info) => {
          if (isCurrent(agent, session)) setProject(info.project);
        }).catch(() => {
          if (isCurrent(agent, session)) setProject(null);
        });
        return;
      }
    }
  }

  function pushHistory(text: string): void {
    setHistory((prev) => {
      // Don't add a literal duplicate of the most recent entry.
      if (prev[prev.length - 1] === text) return prev;
      const next = [...prev, text].slice(-INPUT_HISTORY_MAX);
      writeInputHistory(next);
      return next;
    });
    setHistoryIndex(null);
    setHistoryDraft('');
  }

  // Wraps setInput so any modification while history-navigating clears the
  // history-cursor — typing breaks you out of the history walk.
  function handleInputChange(next: string): void {
    if (historyIndex !== null && next !== history[historyIndex]) {
      setHistoryIndex(null);
    }
    setInput(next);
  }

  // useInput captures every keypress. The Editor (editor.tsx) reads the
  // same keys and handles typing, cursor moves, Backspace and Enter; here
  // only the keys it leaves alone (Tab, Up/Down at the draft's edges,
  // Esc, Ctrl+C).
  useInput((char, key) => {
    // Ctrl+R: search what was sent before, newest first. While it runs it
    // has every key: typing narrows, Ctrl+R steps to an older match,
    // Enter takes the match into the input (without sending), Esc or
    // Ctrl+C or Ctrl+G give the draft back.
    if (search) {
      if (key.escape || (key.ctrl && (char === 'c' || char === 'g'))) {
        setSearch(null);
        setInput(search.draft);
        return;
      }
      if (key.return || key.tab || key.rightArrow) {
        if (search.index >= 0) setInput(history[search.index] ?? '');
        setSearch(null);
        return;
      }
      if (key.ctrl && char === 'r') {
        const older = searchHistory(history, search.query, search.index - 1);
        if (older >= 0) setSearch({ ...search, index: older });
        return;
      }
      if (key.backspace || key.delete) {
        const query = [...search.query].slice(0, -1).join('');
        setSearch({ ...search, query, index: searchHistory(history, query) });
        return;
      }
      if (!key.ctrl && !key.meta && char && !/[\u0000-\u001f]/.test(char)) {
        const query = search.query + char;
        setSearch({ ...search, query, index: searchHistory(history, query) });
      }
      return;
    }
    if (key.ctrl && char === 'r') {
      setSearch({ query: '', index: searchHistory(history, ''), draft: input });
      return;
    }
    // Tab: the first press fills in the highlighted command, every
    // further press steps on through the list the first one saw
    // (2026-11-22: it skipped the highlighted entry, and after filling
    // the list was gone so a second Tab did nothing).
    const cycle = tabCycleRef.current;
    const cycling = cycle !== null && cycle.filled === input;
    if (key.tab && (cycling || slashMatches.length > 0)) {
      let options = slashMatches;
      let index = safeAutocompleteIndex;
      if (cycling) {
        const dir = key.shift ? -1 : 1;
        options = cycle.options;
        index = (cycle.index + dir + options.length) % options.length;
      }
      const picked = options[index];
      if (picked) {
        const filled = picked.name + ' ';
        tabCycleRef.current = { options, index, filled };
        setInput(filled);
      }
      return;
    }
    // Esc:
    //   - while streaming: abort the in-flight turn server-side. Keep
    //     the input buffer untouched — the user might be typing the
    //     next message while the model is still talking.
    //   - otherwise: clear the input (also hides the autocomplete popup,
    //     since `/` prefix → matchCommands returns [] when empty).
    if (key.escape) {
      if (streaming) {
        void apiRef.current.abortTurn(agent, session);
        return;
      }
      if (input.length > 0) {
        setInput('');
        setHistoryIndex(null);
      }
      return;
    }
    // History navigation
    // History only from the draft's first line (Up) or last line (Down);
    // inside a multi-line draft the arrows move the cursor (editor.tsx).
    if (key.upArrow && history.length > 0 && editorEdgesRef.current.atTop) {
      if (historyIndex === null) {
        setHistoryDraft(input);
        const idx = history.length - 1;
        setHistoryIndex(idx);
        setInput(history[idx] ?? '');
      } else if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        setInput(history[idx] ?? '');
      }
      return;
    }
    if (key.downArrow && historyIndex !== null && editorEdgesRef.current.atBottom) {
      if (historyIndex < history.length - 1) {
        const idx = historyIndex + 1;
        setHistoryIndex(idx);
        setInput(history[idx] ?? '');
      } else {
        setHistoryIndex(null);
        setInput(historyDraft);
      }
      return;
    }
    // Ctrl+C: first press soft-cancels (clear input / close popup), second
    // press exits when there's nothing to clear.
    if (key.ctrl && char === 'c') {
      if (input.length > 0) {
        setInput('');
        setHistoryIndex(null);
        return;
      }
      exit();
      return;
    }
  });

  async function handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput('');
    // An open question takes its option's number ("1", "2", …). One that
    // does not wait takes anything else too: it goes out as a message.
    const numbered = openQuestion && !(openQuestion.async && openQuestion.parts && openQuestion.parts.length > 1) && openQuestion.options.length > 0;
    if (openQuestion && numbered && (openQuestion.multiple ? /^\d+(\s*[, ]\s*\d+)*$/ : /^\d+$/).test(trimmed)) {
      const picks = [...new Set(trimmed.split(/[\s,]+/).map(Number))].map((n) => openQuestion.options[n - 1]);
      if (picks.every(Boolean)) {
        const q = openQuestion;
        const labels = picks.map((o) => o!.label);
        try {
          await apiRef.current.answerSessionQuestion(agent, session, q.id, labels);
          if (openQuestionRef.current?.id === q.id) {
            setOpenQuestion(null);
            appendTurn({ kind: 'system', id: nextId(), text: `→ ${labels.join(', ')}`, tone: 'info' });
          }
        } catch (err) {
          appendTurn({ kind: 'system', id: nextId(), text: `could not answer: ${(err as Error).message}`, tone: 'error' });
        }
        return;
      }
      if (!openQuestion.async) {
        appendTurn({ kind: 'system', id: nextId(), text: `no option ${trimmed} — type 1 to ${openQuestion.options.length}`, tone: 'warn' });
        return;
      }
    }
    pushHistory(trimmed);
    if (trimmed.startsWith('/')) {
      try {
        const questionBeforeCommand = openQuestionRef.current;
        const actions = await runCommand(trimmed, {
          api: apiRef.current,
          agent,
          session,
          showMemory,
          showTools,
          verboseTools,
          verboseMemory,
          verboseSystem,
          verboseThinking,
          featureFlags: { projects: projectsEnabled },
        });
        // The user may have switched while the command ran: what belongs
        // to the session it ran in is not applied to the one on screen.
        const stale = currentKeyRef.current !== `${agent}\u0000${session}`;
        for (const a of actions) {
          if (stale && (a.kind === 'restoreInput' || a.kind === 'projectFocusRefresh' || a.kind === 'clearStats' || a.kind === 'clearQuestion')) continue;
          if (a.kind === 'notice') {
            appendTurn({ kind: 'system', id: nextId(), text: a.text, tone: a.tone });
          } else if (a.kind === 'exit') {
            exit();
          } else if (a.kind === 'switchTo') {
            setStats(null);
            setStreamingText('');
            setStreamingThinking('');
            streamingThinkingRef.current = { text: '', truncated: false };
            setStreaming(false);
            setAgent(a.agent);
            setSession(a.session);
            rememberAgent(a.agent);
          } else if (a.kind === 'clearStats') {
            setStats(null);
          } else if (a.kind === 'clearQuestion') {
            // A question that arrived while the reset ran belongs to the
            // fresh conversation and stays.
            if (openQuestionRef.current?.id === questionBeforeCommand?.id) setOpenQuestion(null);
          } else if (a.kind === 'setShow') {
            if (a.target === 'memory') setShowMemory(a.value);
            else setShowTools(a.value);
          } else if (a.kind === 'setVerbose') {
            if (a.target === 'tools') setVerboseTools(a.value);
            else if (a.target === 'memory') setVerboseMemory(a.value);
            else if (a.target === 'thinking') setVerboseThinking(a.value);
            else setVerboseSystem(a.value);
          } else if (a.kind === 'projectFocusRefresh') {
            // Refetch project after a successful /projekt pin/unlink so
            // the chip updates immediately. Server's SSE 'project'
            // broadcast also lands, but this gives the snappier feel.
            apiRef.current
              .fetchSessionProject(agent, session)
              .then((info) => setProject(info.project))
              .catch(() => setProject(null));
          } else if (a.kind === 'restoreInput') {
            // /queue rm took a human turn back: its text returns to
            // the input for a rewrite, and the pending-queued row it
            // had (if this TUI sent it) goes away. The server's
            // turn_dequeued does the latter too; doing it here keeps
            // the row from flashing until the event lands.
            pendingQueuedBufferRef.current.delete(a.turnId);
            updatePendingQueued((prev) => prev.filter((p) => p.turnId !== a.turnId));
            setInput(a.text);
            setHistoryIndex(null);
          } else if (a.kind === 'workRefresh') {
            refreshWork(agent, session);
          }
        }
      } catch (err) {
        appendTurn({
          kind: 'system',
          id: nextId(),
          text: `command failed: ${(err as Error).message}`,
          tone: 'error',
        });
      }
      return;
    }
    // Two paths for self-typed turns:
    //   A. no turn running → idle channel. Optimistically append to
    //      Static so the user sees their message instantly;
    //      pendingSelfSendsRef.push so the server's user_message
    //      echo gets deduped. Same flow as before queueing existed.
    //   B. a turn is already running → queued channel. Push the
    //      text into pendingQueued (dynamic-frame, mutable). The
    //      server queues the POST behind the lock and emits a
    //      turn_queued SSE; we render "queued · N ahead" until
    //      the user_message SSE arrives and promotes the entry
    //      into a real Static turn.
    // `busy` only covers our OWN in-flight send; `streaming` covers
    // turns started elsewhere (another client on this session, A2A,
    // sentinel). Gating on busy alone let those take path A — the
    // optimistic Static append is immutable, so the running turn's
    // reply landed BELOW the queued message, permanently misordered.
    const queuedPath = busy || streaming;
    const localId = nextId();
    if (queuedPath) {
      updatePendingQueued((prev) => [
        ...prev,
        { localId, text: trimmed, ts: Date.now() },
      ]);
    } else {
      appendTurn({ kind: 'user', id: localId, text: trimmed });
      pendingSelfSendsRef.current.push(trimmed);
      setBusy(true);
    }
    try {
      const { turnId } = await apiRef.current.send(agent, session, trimmed);
      if (queuedPath && turnId) {
        // Drain any turn_queued SSE that arrived before this POST
        // returned so the ahead-count lands on the bubble in the
        // same render as the turnId tag.
        const bufferedAhead = pendingQueuedBufferRef.current.get(turnId);
        if (bufferedAhead !== undefined) pendingQueuedBufferRef.current.delete(turnId);
        if (earlyDequeuedRef.current.delete(turnId) || earlyEchoRef.current.delete(turnId)) {
          updatePendingQueued((prev) => prev.filter((p) => p.localId !== localId));
          return;
        }
        updatePendingQueued((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? {
                  ...p,
                  turnId,
                  ...(bufferedAhead !== undefined ? { queued: { ahead: bufferedAhead } } : {}),
                }
              : p,
          ),
        );
      }
    } catch (err) {
      if (queuedPath) {
        // Remove the pending-queued entry so the user doesn't see
        // a permanently-stuck "queued" row.
        updatePendingQueued((prev) => prev.filter((p) => p.localId !== localId));
      } else {
        // Drop the pending dedupe entry so a future identical
        // text echoes normally.
        const cur = pendingSelfSendsRef.current;
        const idx = cur.indexOf(trimmed);
        if (idx >= 0) cur.splice(idx, 1);
        setBusy(false);
      }
      appendTurn({
        kind: 'system',
        id: nextId(),
        text: `send failed: ${(err as Error).message}`,
        tone: 'error',
      });
    }
  }

  const agentTag = agentIcon ? `${agentIcon} ${agent}` : agent;

  const flushedTurns = useMemo(() => turns.slice(0, flushedCount), [turns, flushedCount]);
  const liveTurns = turns.slice(flushedCount);

  return (
    // The frame is exactly as tall as the terminal (layout.ts): the chat
    // area takes what the bottom panel leaves and is cut at its top, so
    // the panel always ends on the last row whatever opens or closes.
    <Box flexDirection="column" height={termRows || 24}>
      {/* Scrollback: a turn reaches it once it has left the top of the
          frame (the flush effect above), then belongs to the terminal. */}
      <Static items={flushedTurns}>
        {(turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            agentName={agent}
            agentIcon={agentIcon}
            verbose={{ tools: verboseTools, memory: verboseMemory }}
          />
        )}
      </Static>

      <Box ref={viewRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" justifyContent="flex-end">
      {liveTurns.map((turn) => (
        <Box
          key={turn.id}
          flexDirection="column"
          flexShrink={0}
          ref={(el) => {
            if (el) liveRefs.current.set(turn.id, el);
            else liveRefs.current.delete(turn.id);
          }}
        >
          <TurnView
            turn={turn}
            agentName={agent}
            agentIcon={agentIcon}
            verbose={{ tools: verboseTools, memory: verboseMemory }}
          />
        </Box>
      ))}
      <Box ref={tailRef} flexDirection="column" flexShrink={0}>
      {streamingText.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>
            {agentTag}
          </Text>
          <AgentBody text={streamingText} />
        </Box>
      ) : verboseThinking && streaming && streamingThinking.trim().length > 0 ? (
        // Model is still thinking, no reply text yet: show the tail of
        // the thinking text where the reply will appear. Replaced by
        // the reply as soon as the first chat delta lands; the full
        // (capped) text lands in the scrollback at agent-end.
        <Box marginTop={1} flexDirection="column">
          <Text color="gray" bold>
            🧠 thinking
          </Text>
          <Box paddingLeft={2} flexDirection="column">
            {tailLines(streamingThinking, THINKING_TAIL_LINES).map((line, i) => (
              <Text key={i} color="gray">
                {line.length > 0 ? line : ' '}
              </Text>
            ))}
          </Box>
        </Box>
      ) : null}

      {/* Pending-queued self-typed turns. Lives in the dynamic frame
       *  (not in Static) because each row mutates as turn_queued SSE
       *  events update the ahead-count, and disappears when the
       *  matching user_message event promotes it into a real Static
       *  turn. Visually distinct from a finalized user turn so the
       *  user knows the message is in the queue, not yet running. */}
      {pendingQueued.length > 0
        ? pendingQueued.map((p) => (
            <Box key={p.localId} marginTop={1}>
              <Text color="green" bold>
                {'user  '}
              </Text>
              <Text>{p.text} </Text>
              <Text color="yellow" italic>
                · queued
                {p.queued && p.queued.ahead > 1 ? ` · ${p.queued.ahead - 1} ahead` : ''}
              </Text>
            </Box>
          ))
        : null}
      </Box>
      </Box>

      {/* Bottom panel: separator → status → autocomplete (if any) → input →
          hints. Never shrinks; the command list takes its rows from the
          chat area above. */}
      <Box flexDirection="column" flexShrink={0}>
        <Box marginTop={1}>
          <Separator />
        </Box>
        <Header
          agent={agent}
          agentIcon={agentIcon}
          session={session}
          stats={stats}
          streaming={streaming}
          streamingPhase={streaming && streamingText.length === 0 ? 'pre' : 'content'}
          connected={connected}
          showMemory={showMemory}
          showTools={showTools}
          reviewLoop={reviewLoop}
          project={project}
          unreadOtherAgents={unreadOtherAgents}
          workCounters={formatWorkCounters(work)}
          nextModel={nextModel}
          externalLabel={externalLabels[agent] ?? null}
        />
        <SlashAutocomplete
          matches={slashMatches}
          selectedIndex={safeAutocompleteIndex}
          maxVisible={Math.max(1, Math.min(MAX_VISIBLE, (termRows || 24) - BOTTOM_PANEL_ROWS - 4))}
        />
        <Box ref={inputBoxRef} flexDirection="column">
          {search ? (
            <Text wrap="truncate-end">
              <Text color="magenta">{'(search) '}</Text>
              <Text color="cyan">{search.query}</Text>
              <Text inverse> </Text>
              <Text color="gray">{'  '}</Text>
              {search.index >= 0 ? (
                <Text>{(history[search.index] ?? '').replace(/\n/g, ' ⏎ ')}</Text>
              ) : (
                <Text color="yellow">no match</Text>
              )}
            </Text>
          ) : null}
          {/* Hidden, not unmounted, during a search: it keeps its pastes. */}
          <Box display={search ? 'none' : 'flex'} flexDirection="column">
            <Editor
              value={input}
              onChange={handleInputChange}
              onSubmit={(text) => void handleSubmit(text)}
              placeholder={busy || streaming ? '(type to queue next message…)' : ''}
              edgeRef={editorEdgesRef}
              isActive={search === null}
            />
          </Box>
        </Box>
        <Footer />
      </Box>
    </Box>
  );
}
