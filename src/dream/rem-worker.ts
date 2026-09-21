// RemWorker — per-agent idle-triggered dream extraction.
// (Phase REM. DECISION #33 (originally Dream-A).)
//
// Lifecycle per agent with rem.enabled = true:
//
//   chat.send arrives  ──►  resetActivity(agent)
//                              │  cancels in-flight REM run (AbortSignal)
//                              │  resets idle timer
//                              ▼
//   idleMinutes pass    ──►  fireIdle(agent)
//                              │  1. resume any paused dream first
//                              │  2. else: find session with delta
//                              │     (ts > meta.dreamReadThroughTs)
//                              │  3. run REM async
//                              │  4. on success: bump dreamReadThroughTs
//                              ▼
//   user chats again    ──►  back to top (cancellation triggers pause)
//
// State is in-process — server crash → all timers + AbortControllers (state in-process)
// gone. Crash-recovery for in-flight dreams happens at server start
// via recoverOrphanRunningDreams() in storage.ts (sets them paused);
// the REM worker picks them up on the next idle for whichever agent
// they belong to.

import type { Config } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { RemConfig } from '../persona/loader.ts';
import { logger } from '../server/logger.ts';
import { listSessions, sessionMetaStore } from '../storage/sessions.ts';
import { listDreams } from './storage.ts';
import { runDream } from './rem-runner.ts';

interface AgentState {
  agent: string;
  rem: RemConfig;
  /** Pending idle-fire timer. null when no timer scheduled. */
  idleTimer: NodeJS.Timeout | null;
  /** Abort controller for the dream currently running for this agent. */
  activeAbort: AbortController | null;
  /** Set while fireIdle is in flight to prevent reentrancy. */
  isWorking: boolean;
  /** In-flight run promise — shutdown() awaits these (bounded) so the
   *  paused/failed dream file lands on disk before process.exit. */
  activeRun: Promise<unknown> | null;
  /** Consecutive self-scheduled retries; reset by real activity. */
  selfHealAttempts: number;
}

export interface RemWorkerDeps {
  config: Config;
  getMemoryManager: (agent: string) => Promise<MemoryManager>;
  /** Test seam: stands in for rem-runner's runDream. */
  runDreamImpl?: typeof runDream;
}

/**
 * Marker key in SessionMeta. Set by the worker after a dream completes
 * successfully — subsequent dreams for the session only consider events
 * with `ts > dreamReadThroughTs`.
 */
const META_KEY = 'dreamReadThroughTs';
/** Sessions one cycle may dream over back to back (see fireIdle). */
const MAX_SESSIONS_PER_CYCLE = 8;

/**
 * Delay multiplier for self-scheduled retry `attempt` (1-based), or
 * null once the budget is spent. Four attempts at 1, 2, 4 and 8 idle
 * intervals: a backend that comes back within the hour is caught, one
 * that is down all afternoon does not turn into an all-afternoon loop.
 * Real chat activity resets the count.
 */
/**
 * Record that REM has read `session` through `throughTs`. Every path
 * that runs a dream over a session must call this on success — the idle
 * worker AND the /reset path (rem-reset-run.ts). A successful run that
 * leaves the marker behind is read again by the next idle cycle.
 */
export async function markSessionDreamed(
  agent: string,
  session: string,
  throughTs: number,
): Promise<void> {
  try {
    // max() so a late-completing resume of an old dream can't rewind a
    // marker a newer fresh run already advanced (rewind = re-dream =
    // duplicate findings).
    await sessionMetaStore.update(agent, session, (current) => ({
      ...current,
      [META_KEY]: Math.max(throughTs, Number(current[META_KEY]) || 0),
    }));
  } catch (err) {
    logger.warn({
      msg: 'dream.rem.marker_write_failed',
      agent,
      session,
      err: (err as Error).message,
    });
  }
}

export function selfHealFactor(attempt: number): number | null {
  const MAX_ATTEMPTS = 4;
  if (attempt < 1 || attempt > MAX_ATTEMPTS) return null;
  return 2 ** (attempt - 1);
}

export class RemWorker {
  private agents = new Map<string, AgentState>();
  private shuttingDown = false;

  constructor(private deps: RemWorkerDeps) {}

  /**
   * Register an agent with the worker. Called once per agent at server
   * startup (only for agents with rem.enabled). The first idle timer
   * is started immediately so the worker can pick up paused dreams from
   * the previous server run without waiting for a chat.send first.
   */
  register(agent: string, rem: RemConfig): void {
    if (this.shuttingDown) return;
    if (this.agents.has(agent)) {
      logger.debug({ msg: 'dream.rem.re_register', agent });
      return;
    }
    const state: AgentState = {
      agent,
      rem,
      idleTimer: null,
      activeAbort: null,
      isWorking: false,
      activeRun: null,
      selfHealAttempts: 0,
    };
    this.agents.set(agent, state);
    this.scheduleIdle(state);
    logger.info({
      msg: 'dream.rem.registered',
      agent,
      idleMinutes: rem.idleMinutes,
      model: rem.model,
    });
  }

  /**
   * Called by the server on every chat.send for this agent. Cancels any
   * in-flight dream (becomes `paused`) and resets the idle timer.
   */
  resetActivity(agent: string): void {
    const state = this.agents.get(agent);
    if (!state) return;
    if (state.activeAbort) {
      logger.info({ msg: 'dream.rem.aborted_by_activity', agent });
      state.activeAbort.abort();
      // We don't null this out yet — the running dream will set it null
      // when it returns. Leaving the reference is harmless: a second abort
      // is a no-op.
    }
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    // Real activity means the user is here: start the retry budget over.
    state.selfHealAttempts = 0;
    this.scheduleIdle(state);
  }

  /**
   * Stop all timers, abort in-flight work, and wait (bounded) for the
   * aborted runs to persist their state. Called at server shutdown.
   *
   * The wait matters: before 2026-07-25, shutdown() fired the aborts and
   * the server exited while runDream was still mid-flight — the abort
   * surfaced as a transport error ("terminated"), got counted as a chunk
   * failure, and the dream was archived as empty-processed (follow-up
   * report 2026-07-25). With the signal now wired into the LLM request,
   * an abort resolves within milliseconds into a clean `paused` dream —
   * we just have to stay alive long enough for that file write.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const inFlight: Promise<void>[] = [];
    for (const state of this.agents.values()) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.activeAbort?.abort();
      if (state.activeRun) inFlight.push(state.activeRun.then(() => {}, () => {}));
    }
    if (inFlight.length > 0) {
      // Bounded — a wedged run must not block process exit forever.
      await Promise.race([
        Promise.allSettled(inFlight),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
    this.agents.clear();
    logger.info({ msg: 'dream.rem.shutdown', awaited_runs: inFlight.length });
  }

  private scheduleIdle(state: AgentState, factor = 1): void {
    if (this.shuttingDown) return;
    const ms = Math.max(1, state.rem.idleMinutes) * 60_000 * factor;
    state.idleTimer = setTimeout(() => {
      void this.fireIdle(state.agent);
    }, ms);
  }

  /**
   * Come back on our own while work is left over.
   *
   * The worker used to wait for the next `chat.send` and nothing else.
   * A range that failed — backend down, worker model missing — was
   * therefore retried only if the user happened to keep talking to that
   * agent, and a conversation that ended right after the failure never
   * made it into memory at all (2026-09-08 report). Users reasonably
   * assume their conversations are dreamed, so the worker now retries
   * itself.
   *
   * Bounded on purpose: a handful of attempts with a growing gap, then
   * quiet until real activity. A backend that is down for the afternoon
   * must not turn into an all-afternoon retry loop.
   */
  private async rearmIfWorkRemains(state: AgentState): Promise<void> {
    if (this.shuttingDown || state.idleTimer) return;
    const factor = selfHealFactor(state.selfHealAttempts + 1);
    if (factor === null) {
      logger.info({
        msg: 'dream.rem.self_heal_exhausted',
        agent: state.agent,
        attempts: state.selfHealAttempts,
        hint: 'next chat activity for this agent starts a fresh cycle',
      });
      return;
    }
    let remains = false;
    try {
      remains = await this.workRemaining(state.agent);
    } catch (err) {
      logger.debug({ msg: 'dream.rem.self_heal_check_failed', agent: state.agent, err: (err as Error).message });
      return;
    }
    if (!remains) {
      state.selfHealAttempts = 0;
      return;
    }
    state.selfHealAttempts++;
    logger.info({
      msg: 'dream.rem.self_heal_scheduled',
      agent: state.agent,
      attempt: state.selfHealAttempts,
      inMinutes: Math.max(1, state.rem.idleMinutes) * factor,
    });
    this.scheduleIdle(state, factor);
  }

  /**
   * Is there anything left to dream for this agent — a paused run, or a
   * session (archived included) with events past its marker?
   */
  /**
   * Start a REM cycle for `agent` now instead of waiting for the idle
   * timer — "catch up now" after an outage. Same cycle, same lock, same
   * abort-on-activity as the timer path; nothing runs twice.
   */
  async runNow(agent: string): Promise<'started' | 'busy' | 'nothing_to_do' | 'not_registered'> {
    const state = this.agents.get(agent);
    if (!state || this.shuttingDown) return 'not_registered';
    if (state.isWorking) return 'busy';
    if (!(await this.workRemaining(agent))) return 'nothing_to_do';
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
    // A person asked for it: a fresh retry budget, like chat activity gives.
    state.selfHealAttempts = 0;
    void this.fireIdle(agent);
    return 'started';
  }

  async workRemaining(agent: string): Promise<boolean> {
    return Boolean((await this.findPausedDream(agent)) ?? (await this.findSessionWithDelta(agent)));
  }

  private async fireIdle(agent: string): Promise<void> {
    if (this.shuttingDown) return;
    const state = this.agents.get(agent);
    if (!state) return;
    state.idleTimer = null;

    if (state.isWorking) {
      // Defensive — shouldn't happen given resetActivity always aborts
      // before scheduling. If it does, just re-arm without starting new work.
      logger.warn({ msg: 'dream.rem.fire_while_working', agent });
      this.scheduleIdle(state);
      return;
    }
    state.isWorking = true;

    try {
      // 1. Resume any paused dream first — don't waste prior progress.
      const paused = await this.findPausedDream(agent);
      if (paused) {
        logger.info({
          msg: 'dream.rem.resume_picked',
          agent,
          id: paused.id,
          source_session: paused.sourceSession,
          remaining_paused: paused.remaining,
        });
        const resumeRun = this.runForAgent(state, {
          kind: 'resume',
          dreamId: paused.id,
          sourceSession: paused.sourceSession,
        });
        state.activeRun = resumeRun;
        try {
          await resumeRun;
        } finally {
          state.activeRun = null;
        }
        return;
      }
      // 2. Otherwise dream over sessions with new delta — and keep
      // going while that works. One session per idle interval meant a
      // backlog of N sessions took N × idleMinutes of silence, and any
      // chat message in between reset the clock: after a worker outage
      // (18 failed runs across agents, 2026-09-16) catching up took
      // days, for a busy agent it never finished. Stops at the first
      // run that does not succeed (the backend is probably still down —
      // the self-heal schedule takes it from there), when activity
      // aborts the cycle, or at the cap.
      for (let done = 0; done < MAX_SESSIONS_PER_CYCLE; done++) {
        if (this.shuttingDown) break;
        const session = await this.findSessionWithDelta(agent);
        if (!session) {
          if (done === 0) logger.debug({ msg: 'dream.rem.no_work', agent });
          break;
        }
        const freshRun = this.runForAgent(state, {
          kind: 'fresh',
          sourceSession: session.id,
          rangeFromTs: session.dreamReadThroughTs,
        });
        state.activeRun = freshRun;
        let ok = false;
        try {
          ok = await freshRun;
        } finally {
          state.activeRun = null;
        }
        if (!ok) break;
        if (done > 0) logger.info({ msg: 'dream.rem.backlog_drained_one', agent, session: session.id, inThisCycle: done + 1 });
      }
    } catch (err) {
      logger.error({
        msg: 'dream.rem.fire_failed',
        agent,
        err: (err as Error).message,
      });
    } finally {
      state.isWorking = false;
      // Quiet by default still holds: with nothing left over this does
      // not schedule anything, and the next chat.send starts the next
      // cycle. What it no longer does is leave a failed or archived
      // range lying there until the user happens to come back.
      await this.rearmIfWorkRemains(state);
    }
  }

  private async runForAgent(
    state: AgentState,
    target:
      | { kind: 'fresh'; sourceSession: string; rangeFromTs: number }
      | { kind: 'resume'; dreamId: string; sourceSession: string },
  ): Promise<boolean> {
    state.activeAbort = new AbortController();
    const signal = state.activeAbort.signal;
    let succeeded = false;
    try {
      const mgr = await this.deps.getMemoryManager(state.agent);
      if (target.kind === 'fresh') {
        // Capture the range end BEFORE the run and stamp exactly that on
        // success. Stamping Date.now() after the run would mark events
        // that landed mid-dream as dreamed without ever analyzing them.
        const rangeThroughTs = Date.now();
        const result = await (this.deps.runDreamImpl ?? runDream)({
          agent: state.agent,
          sourceSession: target.sourceSession,
          trigger: 'auto',
          rangeFromTs: target.rangeFromTs,
          rangeThroughTs,
          rem: state.rem,
          config: this.deps.config,
          mgr,
          signal,
        });
        if (result.finalStatus === 'completed' || result.finalStatus === 'processed') {
          await this.markSessionDreamed(state.agent, target.sourceSession, rangeThroughTs);
          // Progress, not a retry: draining a backlog of several sessions
          // must not run into the self-heal budget.
          state.selfHealAttempts = 0;
          succeeded = true;
        }
      } else {
        // Resume path — runner.ts:resumeDream re-runs from scratch in v1
        // (DECISION #32: cleaner dedup story). We pass the same source
        // session + the dream's id to clean up the paused file. The
        // marker moves only to the dream's ORIGINAL range end — a resume
        // days later must not swallow everything since.
        const { resumeDream } = await import('./rem-runner.ts');
        const result = await resumeDream({
          agent: state.agent,
          id: target.dreamId,
          rem: state.rem,
          config: this.deps.config,
          mgr,
          signal,
        });
        if (result.finalStatus === 'completed' || result.finalStatus === 'processed') {
          await this.markSessionDreamed(state.agent, target.sourceSession, result.rangeThroughTs);
          state.selfHealAttempts = 0;
          succeeded = true;
        }
      }
    } catch (err) {
      logger.error({
        msg: 'dream.rem.run_failed',
        agent: state.agent,
        target,
        err: (err as Error).message,
      });
    } finally {
      state.activeAbort = null;
    }
    return succeeded && !signal.aborted;
  }

  private markSessionDreamed(agent: string, session: string, throughTs: number): Promise<void> {
    return markSessionDreamed(agent, session, throughTs);
  }

  private async findPausedDream(
    agent: string,
  ): Promise<{ id: string; sourceSession: string; remaining: number } | null> {
    const all = await listDreams(agent);
    const allPaused = all.filter(
      (d) => d.meta.status === 'paused' && d.meta.trigger === 'auto',
    );
    if (allPaused.length === 0) return null;
    // listDreams sorts oldest-first by created_at; that's the order we
    // process — older paused entries get a chance before newer fresh ones.
    // remaining tells diagnostic logs how many other paused are still
    // queued for subsequent idle cycles (visibility into backlog drain).
    const picked = allPaused[0]!;
    return {
      id: picked.meta.id,
      sourceSession: picked.meta.source_session,
      remaining: allPaused.length - 1,
    };
  }

  private async findSessionWithDelta(agent: string): Promise<
    { id: string; dreamReadThroughTs: number } | null
  > {
    // Archived too. Archiving a conversation says "I am done with it",
    // not "forget what was said": a session archived before REM caught
    // up used to fall out of the selection and its last stretch never
    // reached memory (2026-09-08 report). The marker still advances on
    // success, so an archived session is read once and then stops
    // showing up. Newest-first ordering below keeps live sessions ahead
    // of archived ones, which are old by definition.
    const sessions = await listSessions(agent, { includeArchived: true });
    // Sort newest-first so the most recently active session gets dreamed
    // first when multiple have delta.
    sessions.sort((a, b) => {
      const aT = Date.parse(a.lastActivity ?? a.createdAt ?? '');
      const bT = Date.parse(b.lastActivity ?? b.createdAt ?? '');
      return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
    });
    // Two kinds of session step aside (dream files are the evidence):
    //  - `running`: a dream over it is in flight right now — the /reset
    //    path dreams the archive it just made, outside this worker. A
    //    second run over the same range would duplicate every finding.
    //    (Orphaned `running` files are parked as paused at boot, so a
    //    running file means a live run.)
    //  - `failed`: its last attempt failed. It goes to the BACK of the
    //    line instead of the front — one session whose range keeps
    //    failing (say, a chunk the worker rejects every time) used to be
    //    picked again on every cycle, being the newest, and every older
    //    session with unread events waited behind it for good.
    const inFlight = new Set<string>();
    const lastFailed = new Set<string>();
    try {
      for (const d of await listDreams(agent)) {
        if (d.meta.status === 'running') inFlight.add(d.meta.source_session);
        else if (d.meta.status === 'failed') lastFailed.add(d.meta.source_session);
      }
    } catch (err) {
      logger.debug({ msg: 'dream.rem.dream_list_failed', agent, err: (err as Error).message });
    }
    let failedCandidate: { id: string; dreamReadThroughTs: number } | null = null;
    for (const s of sessions) {
      try {
        if (inFlight.has(s.id)) continue;
        const meta = await sessionMetaStore.get(agent, s.id);
        const marker = typeof meta[META_KEY] === 'number' ? (meta[META_KEY] as number) : 0;
        // Use the session's lastActivity timestamp as a proxy for "has new
        // content since marker". If lastActivity > marker, there's something
        // worth dreaming.
        const lastTs = s.lastActivity ? Date.parse(s.lastActivity) : 0;
        if (Number.isFinite(lastTs) && lastTs > marker) {
          if (lastFailed.has(s.id)) {
            failedCandidate ??= { id: s.id, dreamReadThroughTs: marker };
            continue;
          }
          return { id: s.id, dreamReadThroughTs: marker };
        }
      } catch (err) {
        logger.debug({
          msg: 'dream.rem.session_meta_read_failed',
          agent,
          session: s.id,
          err: (err as Error).message,
        });
      }
    }
    return failedCandidate;
  }
}
