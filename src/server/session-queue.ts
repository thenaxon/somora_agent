// Per-session lock with two-class priority queue. Used by /chat/send
// and /chat/send-sync (and by extension agent_ask) so that two writers
// to the same agent's session never run concurrent turns — JSONL stays
// sane and the engine isn't double-driven.
//
// Two priority classes:
//   user  — human-driven turn (POST /chat/send without from_agent)
//   agent — A2A turn (agent_ask, POST /chat/send-sync with from_agent)
//
// User entries jump ahead of any waiting agent entries. FIFO within
// each class. The currently-running holder always finishes; we never
// preempt mid-turn — that would corrupt JSONL and confuse the engine.
//
// In-memory only — server restart drops queued waiters with abort errors.
// MVP scope; persistent queue is a FUTURE item if/when crash-recovery
// becomes a requirement (see A2A-design.md).
//
// Cancellation via AbortSignal: if the caller's signal fires while in
// the queue, we splice the entry out and reject with AbortError. If
// the entry was already running (lock held), the signal does nothing
// here — it's up to the caller's own code path to react.

import { logger } from './logger.ts';

type Priority = 'user' | 'agent';

interface Waiter {
  priority: Priority;
  enqueuedAt: number;
  callId: string | undefined;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  cancelled: boolean;
}

class SessionLock {
  private busy = false;
  private queue: Waiter[] = [];
  private activeSince: number | null = null;
  private activePriority: Priority | null = null;
  private activeCallId: string | undefined = undefined;
  private activeTurnId: string | undefined = undefined;

  acquire(opts: {
    priority: Priority;
    callId?: string;
    signal?: AbortSignal;
    turnId?: string;
  }): Promise<() => void> {
    if (!this.busy) {
      this.busy = true;
      this.activeSince = Date.now();
      this.activePriority = opts.priority;
      this.activeCallId = opts.callId;
      this.activeTurnId = opts.turnId;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        priority: opts.priority,
        enqueuedAt: Date.now(),
        callId: opts.callId,
        resolve: (release) => resolve(release),
        reject: (err) => reject(err),
        cancelled: false,
      };
      // User entries insert before the first agent entry. User entries
      // already in queue keep their FIFO order among themselves.
      if (opts.priority === 'user') {
        const firstAgentIdx = this.queue.findIndex((w) => w.priority === 'agent');
        if (firstAgentIdx === -1) this.queue.push(waiter);
        else this.queue.splice(firstAgentIdx, 0, waiter);
      } else {
        this.queue.push(waiter);
      }

      if (opts.signal) {
        if (opts.signal.aborted) {
          waiter.cancelled = true;
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        const onAbort = () => {
          waiter.cancelled = true;
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new DOMException('aborted', 'AbortError'));
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }).then((release) => release);
  }

  private release(): void {
    this.activeSince = null;
    this.activePriority = null;
    this.activeCallId = undefined;
    this.activeTurnId = undefined;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.cancelled) continue;
      // Hand the lock to the next waiter; busy stays true so a fresh
      // acquire() called between releases can't slip in front of them.
      this.activeSince = Date.now();
      this.activePriority = next.priority;
      this.activeCallId = next.callId;
      next.resolve(() => this.release());
      return;
    }
    this.busy = false;
  }

  status(): {
    busy: boolean;
    queueLength: number;
    userWaiting: number;
    agentWaiting: number;
    activeSince: number | null;
    activePriority: Priority | null;
    activeCallId: string | undefined;
    activeTurnId: string | undefined;
  } {
    return {
      busy: this.busy,
      queueLength: this.queue.length,
      userWaiting: this.queue.filter((w) => w.priority === 'user').length,
      agentWaiting: this.queue.filter((w) => w.priority === 'agent').length,
      activeSince: this.activeSince,
      activePriority: this.activePriority,
      activeCallId: this.activeCallId,
      activeTurnId: this.activeTurnId,
    };
  }
}

const locks = new Map<string, SessionLock>();

function key(agent: string, session: string): string {
  return `${agent}/${session}`;
}

/**
 * Acquire the lock for `<agent>/<session>`. Resolves with a `release()`
 * function — call it (typically in a finally block) when the turn is
 * done. Forgetting to release deadlocks future turns on this session.
 *
 * Re-entry is NOT supported. If a tool handler running inside a turn
 * tries to acquire the same session's lock, it'll deadlock — by design,
 * because that's a sign of accidental recursion (e.g. agent_ask called
 * with `agent: ctx.agent` + `session: ctx.session`). The agent_ask tool
 * guards against that explicitly.
 */
export async function acquireSessionLock(
  agent: string,
  session: string,
  opts: { priority: Priority; callId?: string; signal?: AbortSignal; turnId?: string },
): Promise<() => void> {
  let lock = locks.get(key(agent, session));
  if (!lock) {
    lock = new SessionLock();
    locks.set(key(agent, session), lock);
  }
  const before = lock.status();
  if (before.busy) {
    logger.info({
      msg: 'session_queue.enqueued',
      agent,
      session,
      priority: opts.priority,
      ...(opts.callId ? { call_id: opts.callId } : {}),
      queue_before: before.queueLength,
      user_waiting: before.userWaiting,
      agent_waiting: before.agentWaiting,
    });
  }
  return lock.acquire(opts);
}

export function getSessionLockStatus(agent: string, session: string): ReturnType<SessionLock['status']> {
  const lock = locks.get(key(agent, session));
  return lock?.status() ?? {
    busy: false,
    queueLength: 0,
    userWaiting: 0,
    agentWaiting: 0,
    activeSince: null,
    activePriority: null,
    activeCallId: undefined,
    activeTurnId: undefined,
  };
}

/**
 * Snapshot of every known session lock — busy or not — for diagnostic
 * surfaces (`GET /health`). Returns one entry per (agent, session) that
 * has ever held or queued a turn since server start. Cheap: in-memory
 * map iteration.
 */
export function listAllSessionLockStates(): Array<{
  agent: string;
  session: string;
  busy: boolean;
  queueLength: number;
  userWaiting: number;
  agentWaiting: number;
  activeSince: number | null;
  activePriority: Priority | null;
  activeCallId: string | undefined;
  activeTurnId: string | undefined;
}> {
  const out: ReturnType<typeof listAllSessionLockStates> = [];
  for (const [k, lock] of locks.entries()) {
    const slashIdx = k.indexOf('/');
    if (slashIdx < 0) continue;
    const agent = k.slice(0, slashIdx);
    const session = k.slice(slashIdx + 1);
    out.push({ agent, session, ...lock.status() });
  }
  return out;
}
