// Per-session lock with a FIFO queue. Used by /chat/send
// and /chat/send-sync (and by extension agent_ask) so that two writers
// to the same agent's session never run concurrent turns — JSONL stays
// sane and the engine isn't double-driven.
//
// One queue, FIFO, no classes. The currently-running holder always
// finishes; we never preempt mid-turn — that would corrupt JSONL and
// confuse the engine.
//
// Turns still SAY where they come from:
//   user  — human-driven turn (POST /chat/send without from_agent)
//   agent — A2A turn, sentinel, job, or a question asked in a voice call
// That label is diagnostics (/health, logs), not order. Until
// 2026-09-12 user turns jumped the queue; a voice call broke the rule,
// because a question asked out loud runs as an agent turn and so waited
// behind errands that a typed question would have overtaken.
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

/** Thrown to a waiter that was taken out of the queue by
 *  `dequeueSessionTurn` (DELETE /chat/queue/:turnId) — the turn never
 *  ran, and the caller must not treat it as a failure of the turn. */
export class DequeuedError extends Error {
  constructor(readonly turnId: string) {
    super(`turn ${turnId} was dequeued before it started`);
    this.name = 'DequeuedError';
  }
}

export type DequeueOutcome =
  | { status: 'removed'; remaining: Array<{ turnId: string; ahead: number }> }
  | { status: 'running' }
  | { status: 'unknown' };

interface Waiter {
  priority: Priority;
  enqueuedAt: number;
  callId: string | undefined;
  /** The work-ledger item this waiter runs for (Phase 2). Lets the
   *  ledger take any waiter back, not only a human one. */
  workId: string | undefined;
  /** Turn-lifecycle id — carried through the queue so /health's
   *  activeTurnId is populated for queued-then-run turns too, not only
   *  for immediately-granted ones (Juni-Audit 2026-06). */
  turnId: string | undefined;
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
  private activeWorkId: string | undefined = undefined;

  acquire(opts: {
    priority: Priority;
    callId?: string;
    signal?: AbortSignal;
    turnId?: string;
    workId?: string;
    /** Called synchronously AFTER the waiter has been pushed to the queue.
     *  `ahead` = number of turns this waiter must wait for, INCLUDING the
     *  currently-running one (1 = next in line). Used by /chat/send to
     *  emit a `turn_queued` SSE event so clients can render a queue
     *  indicator on the optimistic user-bubble. Not called when the lock
     *  is immediately granted. */
    onQueued?: (ahead: number) => void;
  }): Promise<() => void> {
    if (!this.busy) {
      this.busy = true;
      this.activeSince = Date.now();
      this.activePriority = opts.priority;
      this.activeCallId = opts.callId;
      this.activeTurnId = opts.turnId;
      this.activeWorkId = opts.workId;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        priority: opts.priority,
        enqueuedAt: Date.now(),
        callId: opts.callId,
        turnId: opts.turnId,
        workId: opts.workId,
        resolve: (release) => resolve(release),
        reject: (err) => reject(err),
        cancelled: false,
      };
      // First come, first served, whoever it is.
      //
      // Human turns used to jump ahead of agent turns. With a voice call
      // in the picture that stopped being a clean rule: a spoken
      // question runs as an agent turn, so the person at the microphone
      // queued behind another agent's errand while the person typing did
      // not — two humans, two answers (Rene, 2026-09-12: "alle haben die
      // selbe prio wer als erster kommt mahlt zuerst das ist dann
      // leichter zu warten").
      //
      // `priority` stays as a LABEL: /health shows who is waiting, and
      // the logs say where a turn came from. It no longer decides order.
      this.queue.push(waiter);
      if (opts.onQueued) {
        const idx = this.queue.indexOf(waiter);
        // ahead = waiters in front of us (idx) + the currently-running turn (1)
        opts.onQueued(idx + 1);
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

  /** Take a still-waiting USER turn out of the queue. Only user
   *  turns: A2A / sentinel waiters are not the human's to edit. The
   *  waiter's acquire() promise rejects with DequeuedError so the
   *  /chat/send continuation skips the turn. Atomic with respect to
   *  release(): both run on the event loop, and a waiter that release()
   *  already promoted is `activeTurnId`, not in `queue`. */
  dequeue(turnId: string): DequeueOutcome {
    const idx = this.queue.findIndex((w) => w.turnId === turnId && w.priority === 'user');
    if (idx >= 0) {
      const [waiter] = this.queue.splice(idx, 1);
      waiter!.cancelled = true;
      waiter!.reject(new DequeuedError(turnId));
      return { status: 'removed', remaining: this.waitingUserTurns() };
    }
    if (this.activeTurnId === turnId) return { status: 'running' };
    return { status: 'unknown' };
  }

  /** Take a waiter out by its work-ledger id — any priority. The
   *  ledger decides who may (a person: anything; an agent: its own),
   *  this only does it. Same atomicity as dequeue(). */
  dequeueWork(workId: string): DequeueOutcome {
    const idx = this.queue.findIndex((w) => w.workId === workId);
    if (idx >= 0) {
      const [waiter] = this.queue.splice(idx, 1);
      waiter!.cancelled = true;
      waiter!.reject(new DequeuedError(workId));
      return { status: 'removed', remaining: this.waitingUserTurns() };
    }
    if (this.activeWorkId === workId) return { status: 'running' };
    return { status: 'unknown' };
  }

  /** Every waiter in line, in order (Phase 2: the queue has names). */
  waiting(): Array<{ workId?: string; turnId?: string; priority: Priority; enqueuedAt: number; position: number }> {
    const out: Array<{ workId?: string; turnId?: string; priority: Priority; enqueuedAt: number; position: number }> = [];
    let pos = 0;
    for (const w of this.queue) {
      if (w.cancelled) continue;
      pos++;
      out.push({ ...(w.workId ? { workId: w.workId } : {}), ...(w.turnId ? { turnId: w.turnId } : {}), priority: w.priority, enqueuedAt: w.enqueuedAt, position: pos });
    }
    return out;
  }

  /** User turns still waiting, with their current `ahead` (same
   *  semantics as onQueued: waiters in front + the running turn). */
  waitingUserTurns(): Array<{ turnId: string; ahead: number }> {
    const out: Array<{ turnId: string; ahead: number }> = [];
    this.queue.forEach((w, idx) => {
      if (w.priority === 'user' && w.turnId && !w.cancelled) out.push({ turnId: w.turnId, ahead: idx + 1 });
    });
    return out;
  }

  private release(): void {
    this.activeSince = null;
    this.activePriority = null;
    this.activeCallId = undefined;
    this.activeTurnId = undefined;
    this.activeWorkId = undefined;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.cancelled) continue;
      // Hand the lock to the next waiter; busy stays true so a fresh
      // acquire() called between releases can't slip in front of them.
      this.activeSince = Date.now();
      this.activePriority = next.priority;
      this.activeCallId = next.callId;
      this.activeTurnId = next.turnId;
      this.activeWorkId = next.workId;
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
    activeWorkId: string | undefined;
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
      activeWorkId: this.activeWorkId,
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
  opts: {
    priority: Priority;
    callId?: string;
    signal?: AbortSignal;
    turnId?: string;
    workId?: string;
    onQueued?: (ahead: number) => void;
  },
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

/**
 * Take a queued user turn back out before it starts. `removed` means
 * the waiter is gone and its acquire() rejected with DequeuedError;
 * `running` means the lock already went to it (too late — the turn is
 * in flight, /chat/abort is the tool for that); `unknown` means no such
 * waiter on this session (finished, or never queued here).
 */
export function dequeueSessionTurn(agent: string, session: string, turnId: string): DequeueOutcome {
  const lock = locks.get(key(agent, session));
  if (!lock) return { status: 'unknown' };
  const outcome = lock.dequeue(turnId);
  logger.info({
    msg: 'session_queue.dequeue',
    agent,
    session,
    turnId,
    status: outcome.status,
    ...(outcome.status === 'removed' ? { remaining: outcome.remaining.length } : {}),
  });
  return outcome;
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
    activeWorkId: undefined,
  };
}

/** Take any waiter back by its work-ledger id (see work-ledger.ts
 *  dequeueWork for who may). */
export function dequeueSessionWork(agent: string, session: string, workId: string): DequeueOutcome {
  const lock = locks.get(key(agent, session));
  if (!lock) return { status: 'unknown' };
  const outcome = lock.dequeueWork(workId);
  logger.info({ msg: 'session_queue.dequeue_work', agent, session, workId, status: outcome.status });
  return outcome;
}

/** The waiters of a session, in order, with their work ids. */
export function listSessionWaiters(agent: string, session: string): ReturnType<SessionLock['waiting']> {
  const lock = locks.get(key(agent, session));
  return lock ? lock.waiting() : [];
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
  activeWorkId: string | undefined;
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
