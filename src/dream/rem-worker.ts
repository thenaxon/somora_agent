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
  activeRun: Promise<void> | null;
}

export interface RemWorkerDeps {
  config: Config;
  getMemoryManager: (agent: string) => Promise<MemoryManager>;
}

/**
 * Marker key in SessionMeta. Set by the worker after a dream completes
 * successfully — subsequent dreams for the session only consider events
 * with `ts > dreamReadThroughTs`.
 */
const META_KEY = 'dreamReadThroughTs';

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
      if (state.activeRun) inFlight.push(state.activeRun.catch(() => {}));
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

  private scheduleIdle(state: AgentState): void {
    if (this.shuttingDown) return;
    const ms = Math.max(1, state.rem.idleMinutes) * 60_000;
    state.idleTimer = setTimeout(() => {
      void this.fireIdle(state.agent);
    }, ms);
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
      // 2. Otherwise pick a session with new delta to dream over.
      const session = await this.findSessionWithDelta(agent);
      if (!session) {
        logger.debug({ msg: 'dream.rem.no_work', agent });
        return;
      }
      const freshRun = this.runForAgent(state, {
        kind: 'fresh',
        sourceSession: session.id,
        rangeFromTs: session.dreamReadThroughTs,
      });
      state.activeRun = freshRun;
      try {
        await freshRun;
      } finally {
        state.activeRun = null;
      }
    } catch (err) {
      logger.error({
        msg: 'dream.rem.fire_failed',
        agent,
        err: (err as Error).message,
      });
    } finally {
      state.isWorking = false;
      // We intentionally do NOT auto-reschedule here. Next chat.send
      // will trigger the next idle cycle. If the user never chats
      // again, the agent's dreams stay where they are — quiet by default.
    }
  }

  private async runForAgent(
    state: AgentState,
    target:
      | { kind: 'fresh'; sourceSession: string; rangeFromTs: number }
      | { kind: 'resume'; dreamId: string; sourceSession: string },
  ): Promise<void> {
    state.activeAbort = new AbortController();
    const signal = state.activeAbort.signal;
    try {
      const mgr = await this.deps.getMemoryManager(state.agent);
      if (target.kind === 'fresh') {
        // Capture the range end BEFORE the run and stamp exactly that on
        // success. Stamping Date.now() after the run would mark events
        // that landed mid-dream as dreamed without ever analyzing them.
        const rangeThroughTs = Date.now();
        const result = await runDream({
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
  }

  private async markSessionDreamed(
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
    const sessions = await listSessions(agent);
    // Sort newest-first so the most recently active session gets dreamed
    // first when multiple have delta.
    sessions.sort((a, b) => {
      const aT = Date.parse(a.lastActivity ?? a.createdAt ?? '');
      const bT = Date.parse(b.lastActivity ?? b.createdAt ?? '');
      return (Number.isFinite(bT) ? bT : 0) - (Number.isFinite(aT) ? aT : 0);
    });
    for (const s of sessions) {
      try {
        const meta = await sessionMetaStore.get(agent, s.id);
        const marker = typeof meta[META_KEY] === 'number' ? (meta[META_KEY] as number) : 0;
        // Use the session's lastActivity timestamp as a proxy for "has new
        // content since marker". If lastActivity > marker, there's something
        // worth dreaming.
        const lastTs = s.lastActivity ? Date.parse(s.lastActivity) : 0;
        if (Number.isFinite(lastTs) && lastTs > marker) {
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
    return null;
  }
}
