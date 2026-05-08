// AutoDreamWorker — per-agent idle-triggered dream extraction.
// (Phase 2-Stufe-D Phase B; DECISION #33.)
//
// Lifecycle per agent with dream.enabled = true:
//
//   chat.send arrives  ──►  resetActivity(agent)
//                              │  cancels in-flight dream (AbortSignal)
//                              │  resets idle timer
//                              ▼
//   idleMinutes pass    ──►  fireIdle(agent)
//                              │  1. resume any paused dream first
//                              │  2. else: find session with delta
//                              │     (ts > meta.dreamReadThroughTs)
//                              │  3. run dream async
//                              │  4. on success: bump dreamReadThroughTs
//                              ▼
//   user chats again    ──►  back to top (cancellation triggers pause)
//
// State is in-process — server crash → all timers + AbortControllers
// gone. Crash-recovery for in-flight dreams happens at server start
// via recoverOrphanRunningDreams() in storage.ts (sets them paused);
// the auto-worker picks them up on the next idle for whichever agent
// they belong to.

import type { Config } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { DreamConfig } from '../persona/loader.ts';
import { logger } from '../server/logger.ts';
import { listSessions, sessionMetaStore } from '../storage/sessions.ts';
import { listDreams } from './storage.ts';
import { runDream } from './runner.ts';

interface AgentState {
  agent: string;
  dream: DreamConfig;
  /** Pending idle-fire timer. null when no timer scheduled. */
  idleTimer: NodeJS.Timeout | null;
  /** Abort controller for the dream currently running for this agent. */
  activeAbort: AbortController | null;
  /** Set while fireIdle is in flight to prevent reentrancy. */
  isWorking: boolean;
}

export interface AutoDreamWorkerDeps {
  config: Config;
  getMemoryManager: (agent: string) => Promise<MemoryManager>;
}

/**
 * Marker key in SessionMeta. Set by the worker after a dream completes
 * successfully — subsequent dreams for the session only consider events
 * with `ts > dreamReadThroughTs`.
 */
const META_KEY = 'dreamReadThroughTs';

export class AutoDreamWorker {
  private agents = new Map<string, AgentState>();
  private shuttingDown = false;

  constructor(private deps: AutoDreamWorkerDeps) {}

  /**
   * Register an agent with the worker. Called once per agent at server
   * startup (only for agents with dream.enabled). The first idle timer
   * is started immediately so the worker can pick up paused dreams from
   * the previous server run without waiting for a chat.send first.
   */
  register(agent: string, dream: DreamConfig): void {
    if (this.shuttingDown) return;
    if (this.agents.has(agent)) {
      logger.debug({ msg: 'dream.auto.re_register', agent });
      return;
    }
    const state: AgentState = {
      agent,
      dream,
      idleTimer: null,
      activeAbort: null,
      isWorking: false,
    };
    this.agents.set(agent, state);
    this.scheduleIdle(state);
    logger.info({
      msg: 'dream.auto.registered',
      agent,
      idleMinutes: dream.idleMinutes,
      model: dream.model,
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
      logger.info({ msg: 'dream.auto.aborted_by_activity', agent });
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
   * Force a Dream-A sweep over all registered agents in sequence —
   * called by the WikiPromotionWorker (Dream-B) before its run, so
   * that any agent with un-processed sessions has its findings
   * settled into memory before Dream-B reads them.
   *
   * Reentrancy: agents currently `isWorking` are skipped (their
   * regular fireIdle is in flight); the rest are forced.
   *
   * Idle-timer state is preserved — fire-from-sweep does not
   * reschedule the idle timer; the user's next chat does that.
   *
   * Phase 4 / Stufe 3.
   */
  async runPreSweep(): Promise<{ visited: number; skippedBusy: number }> {
    let visited = 0;
    let skippedBusy = 0;
    for (const agent of [...this.agents.keys()]) {
      const state = this.agents.get(agent);
      if (!state) continue;
      if (state.isWorking) {
        skippedBusy++;
        continue;
      }
      try {
        // Mirror fireIdle's path without resetting timers.
        await this.fireIdle(agent);
        visited++;
      } catch (err) {
        logger.warn({ msg: 'dream.auto.pre_sweep_failed', agent, err: (err as Error).message });
      }
    }
    logger.info({ msg: 'dream.auto.pre_sweep_done', visited, skippedBusy });
    return { visited, skippedBusy };
  }

  /**
   * Stop all timers + abort in-flight work. Called at server shutdown.
   */
  shutdown(): void {
    this.shuttingDown = true;
    for (const state of this.agents.values()) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.activeAbort?.abort();
    }
    this.agents.clear();
    logger.info({ msg: 'dream.auto.shutdown' });
  }

  private scheduleIdle(state: AgentState): void {
    if (this.shuttingDown) return;
    const ms = Math.max(1, state.dream.idleMinutes) * 60_000;
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
      logger.warn({ msg: 'dream.auto.fire_while_working', agent });
      this.scheduleIdle(state);
      return;
    }
    state.isWorking = true;

    try {
      // 1. Resume any paused dream first — don't waste prior progress.
      const paused = await this.findPausedDream(agent);
      if (paused) {
        logger.info({
          msg: 'dream.auto.resume_picked',
          agent,
          id: paused.id,
          source_session: paused.sourceSession,
          remaining_paused: paused.remaining,
        });
        await this.runForAgent(state, {
          kind: 'resume',
          dreamId: paused.id,
          sourceSession: paused.sourceSession,
        });
        return;
      }
      // 2. Otherwise pick a session with new delta to dream over.
      const session = await this.findSessionWithDelta(agent);
      if (!session) {
        logger.debug({ msg: 'dream.auto.no_work', agent });
        return;
      }
      await this.runForAgent(state, {
        kind: 'fresh',
        sourceSession: session.id,
        rangeFromTs: session.dreamReadThroughTs,
      });
    } catch (err) {
      logger.error({
        msg: 'dream.auto.fire_failed',
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
        const result = await runDream({
          agent: state.agent,
          sourceSession: target.sourceSession,
          trigger: 'auto',
          rangeFromTs: target.rangeFromTs,
          rangeThroughTs: Date.now(),
          dream: state.dream,
          config: this.deps.config,
          mgr,
          signal,
        });
        if (result.finalStatus === 'completed' || result.finalStatus === 'processed') {
          await this.markSessionDreamed(state.agent, target.sourceSession);
        }
      } else {
        // Resume path — runner.ts:resumeDream re-runs from scratch in v1
        // (DECISION #32: cleaner dedup story). We pass the same source
        // session + the dream's id to clean up the paused file.
        const { resumeDream } = await import('./runner.ts');
        const result = await resumeDream({
          agent: state.agent,
          id: target.dreamId,
          dream: state.dream,
          config: this.deps.config,
          mgr,
          signal,
        });
        if (result.finalStatus === 'completed' || result.finalStatus === 'processed') {
          await this.markSessionDreamed(state.agent, target.sourceSession);
        }
      }
    } catch (err) {
      logger.error({
        msg: 'dream.auto.run_failed',
        agent: state.agent,
        target,
        err: (err as Error).message,
      });
    } finally {
      state.activeAbort = null;
    }
  }

  private async markSessionDreamed(agent: string, session: string): Promise<void> {
    try {
      const meta = await sessionMetaStore.get(agent, session);
      const next = { ...meta, [META_KEY]: Date.now() };
      await sessionMetaStore.set(agent, session, next);
    } catch (err) {
      logger.warn({
        msg: 'dream.auto.marker_write_failed',
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
          msg: 'dream.auto.session_meta_read_failed',
          agent,
          session: s.id,
          err: (err as Error).message,
        });
      }
    }
    return null;
  }
}
