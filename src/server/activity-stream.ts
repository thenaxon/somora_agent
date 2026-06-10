// Cross-agent activity broadcast hub.
//
// The main SSE hub in index.ts keys subscribers by (agent, session) so
// the right chat gets the right events. That model breaks down for two
// app-wide UX concerns:
//
//   1. "Which agents are streaming RIGHT NOW" — mobile (single SSE on
//      active agent) and the web AgentDock both want to render
//      streaming-dots on inactive agents too.
//   2. "Which agent has unread activity" — sentinel fires, A2A
//      messages, and assistant replies arriving while the user wasn't
//      looking should leave a visual marker until the user opens that
//      session.
//
// This module is a SIDE-CHANNEL that taps every per-session `publish()`
// call. It filters the per-session event stream down to two
// app-relevant signals (`streaming` and `turn`) and re-broadcasts on
// the `/activity/stream` SSE endpoint, plus persists `unreadAt` to the
// session's meta so the state survives a server restart.
//
// `seen` events (client says "I just looked at this session") go the
// other direction: client POSTs, server persists `seenAt`, broadcasts
// to siblings so other open clients clear their badge live.
//
// Unread filter:
//   - chat:final                       → unread (assistant answer)
//   - user_message from_agent          → unread (A2A peer wrote to us)
//   - user_message from_system         → unread (sentinel woke us)
//   - everything else (tool, memory,
//     engine_meta, status, heartbeat,
//     plain user_message)              → ignored
//
// "Plain user_message" is the user typing on some client. We don't
// count it as unread because the user knows what they sent — even from
// a different client. Open question revisited 2026-05-27 with the
// user: they confirmed.

import { sessionMetaStore } from '../storage/sessions.ts';
import { logger } from './logger.ts';
import type { SseEvent } from '../types/events.ts';

export type ActivityEvent =
  | { event: 'streaming'; data: { agent: string; session: string; phase: 'start' | 'end' } }
  | { event: 'turn'; data: { agent: string; session: string; unreadAt: string } }
  | { event: 'seen'; data: { agent: string; session: string; seenAt: string } };

type Subscriber = (e: ActivityEvent) => Promise<void> | void;

const subscribers = new Set<Subscriber>();

export function subscribeActivity(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

async function broadcast(event: ActivityEvent): Promise<void> {
  if (subscribers.size === 0) return;
  // Parallel fan-out with per-sub catch — one wedged subscriber must
  // not block others. Mirrors the per-session publish() defensive
  // pattern from 2026-05-19 (mobile-iOS-background TCP-freeze).
  await Promise.all(
    [...subscribers].map(async (sub) => {
      try {
        await sub(event);
      } catch (err) {
        logger.debug({
          msg: 'activity.broadcast_subscriber_failed',
          err: (err as Error).message,
        });
      }
    }),
  );
}

/** Decide whether a per-session SSE event should bump unread state.
 *  See top-of-file for the rule table. */
export function isUnreadCandidate(event: SseEvent): boolean {
  if (event.event === 'chat') {
    const state = (event.data as { state?: string } | undefined)?.state;
    return state === 'final';
  }
  if (event.event === 'user_message') {
    const d = event.data as { from_agent?: unknown; from_system?: unknown } | undefined;
    return Boolean(d?.from_agent) || Boolean(d?.from_system);
  }
  return false;
}

/** Called from the main publish() in index.ts on every per-session
 *  event. Extracts activity signals and broadcasts them; persists
 *  unreadAt to sessionMeta when applicable.
 *
 *  This is fire-and-forget: any persistence failure logs but does not
 *  break the calling publish path. */
export async function tapPublish(
  agent: string,
  session: string,
  event: SseEvent,
): Promise<void> {
  try {
    if (event.event === 'agent') {
      const phase = (event.data as { phase?: string } | undefined)?.phase;
      if (phase === 'start' || phase === 'end') {
        await broadcast({ event: 'streaming', data: { agent, session, phase } });
      }
      return;
    }
    if (isUnreadCandidate(event)) {
      const unreadAt = new Date().toISOString();
      await persistUnreadAt(agent, session, unreadAt);
      await broadcast({ event: 'turn', data: { agent, session, unreadAt } });
    }
  } catch (err) {
    logger.debug({
      msg: 'activity.tap_publish_failed',
      agent,
      session,
      err: (err as Error).message,
    });
  }
}

/** Race-safe update: only advance unreadAt, never regress. Uses the
 *  atomic read-merge-write so a turn-end engine write or stats-cache
 *  write can't be reverted by this mark (Juni-Audit 2026-06). */
async function persistUnreadAt(agent: string, session: string, ts: string): Promise<void> {
  await sessionMetaStore.update(agent, session, (current) => {
    const existing = typeof current.unreadAt === 'string' ? current.unreadAt : null;
    if (existing && existing >= ts) return current; // ISO strings compare lexicographically — no regress
    return { ...current, unreadAt: ts };
  });
}

/** Race-safe update for the "user just opened this session" signal.
 *  Returns the timestamp that was actually persisted (= max of
 *  current and requested), so the caller can echo it on the broadcast. */
export async function markSeen(agent: string, session: string, ts?: string): Promise<string> {
  const desired = ts ?? new Date().toISOString();
  const result = await sessionMetaStore.update(agent, session, (current) => {
    const existing = typeof current.seenAt === 'string' ? current.seenAt : null;
    const winning = existing && existing > desired ? existing : desired;
    return winning === existing ? current : { ...current, seenAt: winning };
  });
  const winning = typeof result.seenAt === 'string' ? result.seenAt : desired;
  await broadcast({ event: 'seen', data: { agent, session, seenAt: winning } });
  return winning;
}

/** Snapshot of all sessions with their unread/seen state. Used at
 *  client connect time so a fresh subscriber knows what's already
 *  unread without needing a separate `/agents/:agent/sessions` query
 *  per agent. */
export interface ActivitySnapshotEntry {
  agent: string;
  session: string;
  unreadAt: string | null;
  seenAt: string | null;
}
