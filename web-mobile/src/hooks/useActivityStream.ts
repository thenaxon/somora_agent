// Cross-agent activity stream. One EventSource for the whole app —
// independent of the per-session chat stream owned by useChatStream.
//
// What this hook delivers:
//   - streamingAgents:  Set<string>     — any agent currently mid-turn
//                                         on any session
//   - unreadAgents:     Set<string>     — any agent whose any session
//                                         has lastActivity > lastSeen
//   - postSeen(a, s):                   — fire-and-forget "I am
//                                         looking at this session now"
//
// State is keyed by (agent::session) internally; the public sets
// aggregate to agent-only for the AvatarRow dot.
//
// Initial state on app boot: fetch /agents/:name/sessions for each
// known agent and seed unreadAt + seenAt from the response. This way
// a badge that was active when the user left their tab open survives
// a reload.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInfo } from './useAgents';

interface SessionMark {
  unreadAt: string | null;
  seenAt: string | null;
}

interface SessionEntry {
  id: string;
  unreadAt?: string | null;
  seenAt?: string | null;
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
  streamingAgents: Set<string>;
  unreadAgents: Set<string>;
  postSeen: (agent: string, session: string) => void;
}

export function useActivityStream(agents: AgentInfo[]): ActivityState {
  // Streaming is per (agent, session). For the AvatarRow we collapse
  // to per-agent: ANY busy session lights the dot.
  const [streamingKeys, setStreamingKeys] = useState<Set<string>>(() => new Set());
  const [marks, setMarks] = useState<Record<string, SessionMark>>({});
  const seededRef = useRef(false);

  // Seed unread/seen state from /agents/:name/sessions once we know
  // the agent list. Subsequent SSE events keep it live.
  useEffect(() => {
    if (seededRef.current || agents.length === 0) return;
    seededRef.current = true;
    let cancelled = false;
    void (async () => {
      const next: Record<string, SessionMark> = {};
      await Promise.all(
        agents.map(async (a) => {
          try {
            const res = await fetch(`/agents/${encodeURIComponent(a.name)}/sessions`);
            if (!res.ok) return;
            const sessions = (await res.json()) as SessionEntry[];
            for (const s of sessions) {
              next[key(a.name, s.id)] = {
                unreadAt: s.unreadAt ?? null,
                seenAt: s.seenAt ?? null,
              };
            }
          } catch {
            /* one agent failure is harmless — others still seed */
          }
        }),
      );
      if (!cancelled) setMarks((prev) => ({ ...next, ...prev }));
    })();
    return () => {
      cancelled = true;
    };
  }, [agents]);

  // Single SSE subscription for the whole app. Reconnects on error via
  // the browser's built-in EventSource retry.
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
        /* ignore malformed */
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
    // Optimistic local update: clear badge instantly so the dot
    // doesn't flash. The server's broadcast will re-confirm with the
    // canonical timestamp.
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
      /* network blip — server-broadcast will fix on reconnect */
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

  // Memoise the returned object — see web/src/hooks/useActivityStream.ts
  // for the rationale (consumer useEffect dep-arrays).
  return useMemo(
    () => ({ streamingAgents, unreadAgents, postSeen }),
    [streamingAgents, unreadAgents, postSeen],
  );
}
