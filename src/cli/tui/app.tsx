import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

import { Api } from './api.ts';
import { openStream, type StreamHandle } from './stream.ts';
import { openActivityStream } from './activity-stream.ts';
import { matchCommands, runCommand } from './commands.ts';
import { Header } from './header.tsx';
import { Footer } from './footer.tsx';
import { Separator } from './separator.tsx';
import { SlashAutocomplete } from './autocomplete.tsx';
import { AgentBody, TurnView } from './turn-views.tsx';
import { nextId, summarize } from './format.ts';
import { rememberAgent } from './state.ts';
import type {
  AgentInfo,
  PendingQueuedTurn,
  ProjectInfo,
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
}

const HISTORY_MAX = 100;

export function App({
  base,
  initialAgent,
  initialSession,
  initialShowMemory,
  initialShowTools,
  initialVerboseTools,
  initialVerboseMemory,
  initialVerboseSystem,
}: Props) {
  const { exit } = useApp();
  const apiRef = useRef(new Api(base));

  const [agent, setAgent] = useState(initialAgent);
  const [session, setSession] = useState(initialSession);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streamingText, setStreamingText] = useState<string>('');
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<TurnStats | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [agentIcons, setAgentIcons] = useState<Record<string, string>>({});
  const [showMemory, setShowMemory] = useState(initialShowMemory);
  const [showTools, setShowTools] = useState(initialShowTools);
  const [verboseTools, setVerboseTools] = useState(initialVerboseTools);
  const [verboseMemory, setVerboseMemory] = useState(initialVerboseMemory);
  const [verboseSystem, setVerboseSystem] = useState(initialVerboseSystem);
  // Refs so the SSE handler always sees the current toggle without
  // re-subscribing the stream on every flip.
  const showMemoryRef = useRef(showMemory);
  const showToolsRef = useRef(showTools);
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
  // turn_queued SSE events that arrived before the matching POST
  // /chat/send response returned the turnId. Keyed by turnId; drained
  // by handleSubmit once the id is known.
  const pendingQueuedBufferRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    showMemoryRef.current = showMemory;
  }, [showMemory]);
  useEffect(() => {
    showToolsRef.current = showTools;
  }, [showTools]);

  // Submit-history (newest at the end). Up/Down step through it.
  const [history, setHistory] = useState<string[]>([]);
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
        for (const a of list) if (a.icon) next[a.name] = a.icon;
        setAgentIcons(next);
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
    // every agent's state at once.
    void (async () => {
      try {
        const res = await fetch(`${base}/sessions`);
        if (!res.ok) return;
        const data = (await res.json()) as { sessions: Array<{ agent: string; sessionId: string; unreadAt?: string | null; seenAt?: string | null }> };
        if (cancelled) return;
        const seeded: typeof unreadMarks = {};
        for (const s of data.sessions) {
          seeded[`${s.agent}::${s.sessionId}`] = { unreadAt: s.unreadAt ?? null, seenAt: s.seenAt ?? null };
        }
        setUnreadMarks((prev) => ({ ...seeded, ...prev }));
      } catch {
        /* server unreachable — events will populate as they arrive */
      }
    })();
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
    });
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
    setStats(null);
    setPendingQueued([]);
    pendingQueuedBufferRef.current.clear();
    // Drop stale self-send entries from the previous (agent, session)
    // — a leftover text would silently swallow the SAME text sent by
    // another client on the new session's stream.
    pendingSelfSendsRef.current = [];

    let handle: StreamHandle | null = null;

    (async () => {
      try {
        const { events } = await apiRef.current.fetchHistory(agent, session);
        if (cancelled) return;
        const replayed = mapHistoryToTurns(events);
        if (replayed.length > 0) {
          setTurns(replayed);
        }
      } catch {
        /* history endpoint failures are non-fatal — leave scrollback empty */
      }

      if (cancelled) return;
      handle = openStream(
        apiRef.current.streamUrl(agent, session),
        (text, tone) => {
          if (cancelled) return;
          appendTurn({ kind: 'system', id: nextId(), text, tone });
        },
      );
      const stream = handle;
      (async () => {
        for await (const ev of stream.events) {
          if (cancelled) break;
          applyEvent(ev);
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
    let id = 0;
    const nid = () => {
      id += 1;
      return `replay-${id}`;
    };
    // History events come from JSONL with raw `mcp__<server>__<tool>`
    // tool names; the SSE serializer strips this prefix on the live
    // path. Replay needs the same shortening so the TUI doesn't show
    // mcp__somora-memory__exec for old turns. Same regex as the
    // server's shortToolName helper.
    const stripMcpPrefix = (t: string): string => t.replace(/^mcp__[^_]+__/, '');
    for (const ev of events) {
      if (ev.kind === 'user_message' && typeof ev.text === 'string') {
        out.push({
          kind: 'user',
          id: nid(),
          text: ev.text,
          ...(ev.from_agent ? { fromAgent: ev.from_agent } : {}),
          ...(ev.from_system ? { fromSystem: ev.from_system } : {}),
        });
      } else if (ev.kind === 'assistant_message' && typeof ev.text === 'string') {
        out.push({ kind: 'agent', id: nid(), text: ev.text });
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
        ev.kind === 'engine_meta' &&
        typeof ev.engine === 'string' &&
        typeof ev.itemType === 'string'
      ) {
        // Resolve label client-side from a tiny mapping. Keep in sync
        // with src/engine/engine-meta-labels.ts — known item types get
        // friendly names, unknowns fall back to the raw itemType.
        const knownLabels: Record<string, Record<string, string>> = {
          'codex-cli': { todo_list: 'plan' },
        };
        const label = knownLabels[ev.engine]?.[ev.itemType] ?? ev.itemType;
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

  function appendTurn(t: Turn): void {
    setTurns((prev) => [...prev, t]);
  }

  function applyEvent(ev: StreamEvent): void {
    switch (ev.kind) {
      case 'connected':
        setConnected(true);
        return;
      case 'agent-start':
        setStreaming(true);
        setStreamingText('');
        // If the server tells us the upcoming turn has a thinking level,
        // pre-set it on stats so the header can show the "🧠 thinking…"
        // pre-content badge before any tokens arrive.
        if (ev.thinking) {
          setStats((prev) => ({
            tokensIn: prev?.tokensIn ?? 0,
            tokensInCached: prev?.tokensInCached ?? null,
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
        setStreamingText(ev.text);
        return;
      case 'chat-final':
        setStreamingText(ev.text);
        return;
      case 'agent-end': {
        setStreamingText((current) => {
          if (current.length > 0) {
            appendTurn({ kind: 'agent', id: nextId(), text: current });
          }
          return '';
        });
        setStreaming(false);
        setBusy(false);
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
            setProject(info.project);
          }).catch(() => {
            /* leave previous state */
          });
        }
        if (ev.usage || ev.contextWindow || ev.provider || ev.model || ev.thinking) {
          setStats({
            tokensIn: ev.usage?.tokens_in ?? 0,
            tokensInCached: ev.usage?.tokens_in_cached ?? null,
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
      case 'engine_meta': {
        if (!showToolsRef.current) return;
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
          if (ev.turnId) {
            pendingQueuedBufferRef.current.delete(ev.turnId);
            let promoted = false;
            setPendingQueued((prev) => {
              const idx = prev.findIndex((p) => p.turnId === ev.turnId);
              if (idx < 0) return prev;
              promoted = true;
              return prev.slice(0, idx).concat(prev.slice(idx + 1));
            });
            if (promoted) {
              appendTurn({ kind: 'user', id: nextId(), text: ev.text });
              return;
            }
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
          ...(ev.fromSystem ? { fromSystem: ev.fromSystem } : {}),
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
        setPendingQueued((prev) => {
          const idx = prev.findIndex((p) => p.turnId === ev.turnId);
          const existing = idx >= 0 ? prev[idx] : undefined;
          if (!existing) {
            pendingQueuedBufferRef.current.set(ev.turnId, ev.ahead);
            return prev;
          }
          const next = prev.slice();
          next[idx] = { ...existing, queued: { ahead: ev.ahead } };
          return next;
        });
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
          setProject(info.project);
        }).catch(() => {
          setProject(null);
        });
        return;
      }
    }
  }

  function pushHistory(text: string): void {
    setHistory((prev) => {
      // Don't add a literal duplicate of the most recent entry.
      if (prev[prev.length - 1] === text) return prev;
      const next = [...prev, text];
      return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next;
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

  // useInput captures every keypress. ink-text-input also reads stdin and
  // handles its own keys (typing, left/right, backspace, enter); we only
  // react to keys it doesn't touch (Tab, Up, Down, Esc, Ctrl+C/L).
  useInput((char, key) => {
    // Tab: cycle through autocomplete + replace input with selected command
    if (key.tab && slashMatches.length > 0) {
      const dir = key.shift ? -1 : 1;
      const next =
        (safeAutocompleteIndex + dir + slashMatches.length) % slashMatches.length;
      setAutocompleteIndex(next);
      const picked = slashMatches[next];
      if (picked) setInput(picked.name + ' ');
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
    if (key.upArrow && history.length > 0) {
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
    if (key.downArrow && historyIndex !== null) {
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
    pushHistory(trimmed);
    if (trimmed.startsWith('/')) {
      try {
        const actions = await runCommand(trimmed, {
          api: apiRef.current,
          agent,
          session,
          showMemory,
          showTools,
          verboseTools,
          verboseMemory,
          verboseSystem,
          featureFlags: { projects: projectsEnabled },
        });
        for (const a of actions) {
          if (a.kind === 'notice') {
            appendTurn({ kind: 'system', id: nextId(), text: a.text, tone: a.tone });
          } else if (a.kind === 'exit') {
            exit();
          } else if (a.kind === 'switchTo') {
            setStats(null);
            setStreamingText('');
            setStreaming(false);
            setAgent(a.agent);
            setSession(a.session);
            rememberAgent(a.agent);
          } else if (a.kind === 'clearStats') {
            setStats(null);
          } else if (a.kind === 'setShow') {
            if (a.target === 'memory') setShowMemory(a.value);
            else setShowTools(a.value);
          } else if (a.kind === 'setVerbose') {
            if (a.target === 'tools') setVerboseTools(a.value);
            else if (a.target === 'memory') setVerboseMemory(a.value);
            else setVerboseSystem(a.value);
          } else if (a.kind === 'projectFocusRefresh') {
            // Refetch project after a successful /projekt pin/unlink so
            // the chip updates immediately. Server's SSE 'project'
            // broadcast also lands, but this gives the snappier feel.
            apiRef.current
              .fetchSessionProject(agent, session)
              .then((info) => setProject(info.project))
              .catch(() => setProject(null));
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
      setPendingQueued((prev) => [
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
        setPendingQueued((prev) =>
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
        setPendingQueued((prev) => prev.filter((p) => p.localId !== localId));
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

  return (
    <Box flexDirection="column">
      {/* Scrollback: every finalized turn flushes to terminal scrollback once
          via Static, then is owned by the terminal — older messages scroll
          up and out as new ones arrive. The dynamic frame below stays put. */}
      <Static items={turns}>
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

      {streamingText.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan" bold>
            {agentTag}
          </Text>
          <AgentBody text={streamingText} />
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

      {/* Bottom panel: separator → status → autocomplete (if any) → input →
          hints. Stays anchored to the bottom of the visible terminal frame
          because nothing below it ever changes height except the
          autocomplete popup. */}
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
      />
      <SlashAutocomplete matches={slashMatches} selectedIndex={safeAutocompleteIndex} />
      <Box>
        <Text color="cyan">{'> '}</Text>
        <TextInput
          value={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          placeholder={busy || streaming ? '(type to queue next message…)' : ''}
        />
      </Box>
      <Footer />
    </Box>
  );
}
