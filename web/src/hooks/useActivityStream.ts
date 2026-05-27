// Cross-agent activity stream subscription for the web client.
//
// Mirrors web-mobile/src/hooks/useActivityStream.ts — same SSE event
// shape, same internal (agent::session) keying, same agent-aggregated
// public sets. Kept as separate file because the two builds don't
// share a module graph.
//
// Web already has per-session EventSources via ChatProvider's ref-
// counted map for chat content. This hook ADDS:
//   1. streaming-dot coverage for sessions the user has NOT opened a
//      window for (so naxon's dock-tile lights up when sentinel
//      wakes it even though no ChatWindow is on naxon)
//   2. unread-state cross-client sync (TUI marks seen → web clears)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentInfo } from '../lib/api';

interface SessionMark {
  unreadAt: string | null;
  seenAt: string | null;
}

function key(agent: string, session: string): string {
  return `${agent}::${session}`;
}

function parseKey(k: string): { agent: string; session: string } {
  const idx = k.indexOf('::');
  return { agent: k.slice(0, idx), session: k.slice(idx + 2) };
}

function hasUnread(mark: SessionMark | undefined): boolean {
  if (!mark || !mark.unreadAt) return false;
  if (!mark.seenAt) return true;
  return mark.unreadAt > mark.seenAt;
}

export interface ActivityState {
  /** Agents currently streaming on any session. Aggregated from
   *  cross-agent activity-SSE, NOT from ChatProvider's per-session
   *  streams (which only know about windows the user has open). */
  streamingAgents: Set<string>;
  /** Agents with any unread session (unreadAt > seenAt). */
  unreadAgents: Set<string>;
  /** Per (agent, session) raw state — needed by the Sessions tool
   *  which renders per-session badges. */
  marks: Record<string, SessionMark>;
  /** Fire-and-forget: tell the server we just opened this session.
   *  Optimistic local clear so the dot vanishes instantly. */
  postSeen: (agent: string, session: string) => void;
}

export function useActivityStream(agents: AgentInfo[]): ActivityState {
  const [streamingKeys, setStreamingKeys] = useState<Set<string>>(() => new Set());
  const [marks, setMarks] = useState<Record<string, SessionMark>>({});
  const seededRef = useRef(false);

  // Seed unread/seen state via /sessions (the global flat list). One
  // request gives us every agent's every session — cheaper than N
  // per-agent calls. The mark map is keyed by (agent::sessionId).
  useEffect(() => {
    if (seededRef.current || agents.length === 0) return;
    seededRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.globalSessions();
        if (cancelled) return;
        const next: Record<string, SessionMark> = {};
        for (const r of rows) {
          next[key(r.agent, r.sessionId)] = {
            unreadAt: r.unreadAt ?? null,
            seenAt: r.seenAt ?? null,
          };
        }
        setMarks((prev) => ({ ...next, ...prev }));
      } catch {
        /* network blip — server-broadcast keeps state fresh anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agents]);

  useEffect(() => {
    const es = new EventSource('/activity/stream');
    es.addEventListener('streaming', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          agent: string;
          session: string;
          phase: 'start' | 'end';
        };
        setStreamingKeys((prev) => {
          const next = new Set(prev);
          const k = key(d.agent, d.session);
          if (d.phase === 'start') next.add(k);
          else next.delete(k);
          return next;
        });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('turn', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          agent: string;
          session: string;
          unreadAt: string;
        };
        setMarks((prev) => ({
          ...prev,
          [key(d.agent, d.session)]: {
            ...(prev[key(d.agent, d.session)] ?? { seenAt: null, unreadAt: null }),
            unreadAt: d.unreadAt,
          },
        }));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('seen', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          agent: string;
          session: string;
          seenAt: string;
        };
        setMarks((prev) => ({
          ...prev,
          [key(d.agent, d.session)]: {
            ...(prev[key(d.agent, d.session)] ?? { seenAt: null, unreadAt: null }),
            seenAt: d.seenAt,
          },
        }));
      } catch {
        /* ignore */
      }
    });
    return () => {
      es.close();
    };
  }, []);

  const postSeen = useCallback((agent: string, session: string) => {
    const now = new Date().toISOString();
    setMarks((prev) => ({
      ...prev,
      [key(agent, session)]: {
        ...(prev[key(agent, session)] ?? { unreadAt: null, seenAt: null }),
        seenAt: now,
      },
    }));
    void fetch(`/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(session)}/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {
      /* network blip */
    });
  }, []);

  const streamingAgents = useMemo(() => {
    const out = new Set<string>();
    for (const k of streamingKeys) out.add(parseKey(k).agent);
    return out;
  }, [streamingKeys]);

  const unreadAgents = useMemo(() => {
    const out = new Set<string>();
    for (const [k, mark] of Object.entries(marks)) {
      if (hasUnread(mark)) out.add(parseKey(k).agent);
    }
    return out;
  }, [marks]);

  // Memoise the returned object so consumer effects don't re-fire on
  // every render. Without this, ChatWindow's `useEffect(..., [activity])`
  // would treat the fresh object literal as a dep-change and re-post
  // /seen on every chat:delta — which is idempotent but very chatty.
  return useMemo(
    () => ({ streamingAgents, unreadAgents, marks, postSeen }),
    [streamingAgents, unreadAgents, marks, postSeen],
  );
}
