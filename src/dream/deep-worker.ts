// DeepWorker — Memory→Wiki consolidation. Server-global background
// scheduler that fires Deep every `intervalHours` (default 12h) and
// on manual trigger from a tool.
//
// Real-clock scheduling, not idle-driven (REM is per-agent idle; Deep
// runs across all agents on a fixed cadence). Reentrancy-safe: if a
// run is still in flight when the timer fires, we skip the new
// trigger and log it.
//
// Restart-safe: scheduler state is persisted to
// `~/.somora/dream-state/deep.json`. Every server restart re-reads the
// last completion and schedules `setTimeout(nextDueAt - now)` so
// restart-frequency-shorter-than-interval doesn't starve auto-runs.
//
// See `private/dream-system-v2.md` for the full design.

import type { Config } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import { logger } from '../server/logger.ts';
import { runDreamB, type RunDreamBResult } from './deep-runner.ts';
import type { PromotionDispatcher } from '../wiki/types.ts';
import {
  nextDelayMs,
  readSchedulerState,
  writeSchedulerState,
  type SchedulerState,
} from './scheduler-state.ts';

export interface DeepWorkerDeps {
  config: Config;
  /** Resolves agents currently configured to participate in the wiki. */
  getParticipatingAgents: () => Promise<Array<{ name: string; vaultPath: string }>>;
  /** Resolves a per-agent MemoryManager — Deep needs it for the wiki-
   *  context embedding-search (index + top-N relevant pages). */
  getMemoryManager: (agent: string) => Promise<MemoryManager>;
  /** Test injection point. Production passes undefined → Default. */
  dispatcher?: PromotionDispatcher;
}

export class DeepWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;
  private currentAbort: AbortController | null = null;

  constructor(private deps: DeepWorkerDeps) {}

  /** Start the persistent-state scheduler. Reads
   *  `~/.somora/dream-state/deep.json` to compute the next due time
   *  from the last completed run and schedules a single setTimeout.
   *  The timer is re-armed recursively after each fire so the cadence
   *  survives restarts. */
  async start(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.timer) return;
    if (!this.deps.config.wiki.enabled) {
      logger.info({ msg: 'dream.deep.disabled', hint: 'config.wiki.enabled is false' });
      return;
    }
    if (!this.deps.config.wiki.deep.enabled) {
      logger.info({ msg: 'dream.deep.deep_disabled' });
      return;
    }
    await this.scheduleNext('startup');
  }

  /** Manual trigger. Returns the run result for logging by the caller
   *  (e.g. the dream_run({phase:'deep'}) tool surfaces it back to the
   *  user).
   *
   *  `force=true` bypasses the per-agent skip-cache so every memory
   *  file gets re-evaluated by the LLM. Use after prompt changes or
   *  when debugging a specific candidate's decision. */
  async runNow(opts?: { force?: boolean }): Promise<RunDreamBResult> {
    return this.fire('manual', opts?.force ?? false);
  }

  isRunning(): boolean {
    return this.running;
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    logger.info({ msg: 'dream.deep.shutdown' });
  }

  private async scheduleNext(after: 'startup' | 'fire-completed' | 'fire-failed'): Promise<void> {
    if (this.shuttingDown) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const intervalMs = this.deps.config.wiki.deep.intervalHours * 60 * 60 * 1000;
    let state = await readSchedulerState('deep');
    // Bootstrap on first-ever start. See LucidWorker.scheduleNext for
    // the full rationale — short version: without this, a fresh install
    // suffers restart-starvation before the first auto-fire because
    // `state.empty → wait full interval` resets on every boot.
    if (after === 'startup' && state.lastCompletedAt === null && state.lastStartedAt === null && state.lastFailedAt === null) {
      const bootstrappedAt = Date.now();
      state = { ...state, lastCompletedAt: bootstrappedAt };
      try {
        await writeSchedulerState('deep', state);
        logger.info({
          msg: 'dream.deep.bootstrap',
          bootstrappedAt,
          hint: 'first-ever start, anchored cadence to now so restarts before first fire do not reset the timer',
        });
      } catch (err) {
        logger.warn({ msg: 'dream.deep.state_write_fail', when: 'bootstrap', err: String(err) });
      }
    }
    const { delayMs, nextDueAt, reason } = nextDelayMs(state, intervalMs);
    this.timer = setTimeout(() => {
      void this.fire('scheduled');
    }, delayMs);
    logger.info({
      msg: 'dream.deep.scheduled',
      intervalHours: this.deps.config.wiki.deep.intervalHours,
      after,
      reason,
      lastCompletedAt: state.lastCompletedAt,
      lastStartedAt: state.lastStartedAt,
      nextDueAt,
      delayMs,
    });
  }

  private async fire(
    trigger: 'scheduled' | 'manual',
    force = false,
  ): Promise<RunDreamBResult> {
    if (this.shuttingDown) {
      return { outcomes: [], candidatesSeen: 0, cachedSkips: 0, durationMs: 0 };
    }
    if (this.running) {
      logger.warn({
        msg: 'dream.deep.skip_reentrant',
        trigger,
        hint: 'previous run still in flight — manual trigger waits for next cycle',
      });
      return { outcomes: [], candidatesSeen: 0, cachedSkips: 0, durationMs: 0 };
    }
    this.running = true;
    this.currentAbort = new AbortController();
    const startedAt = Date.now();
    const stateBefore = await readSchedulerState('deep');
    const nextState: SchedulerState = { ...stateBefore, lastStartedAt: startedAt };
    try {
      await writeSchedulerState('deep', nextState);
    } catch (err) {
      logger.warn({ msg: 'dream.deep.state_write_fail', when: 'pre-run', err: String(err) });
    }

    try {
      const agents = await this.deps.getParticipatingAgents();
      logger.info({
        msg: 'dream.deep.start',
        trigger,
        agents: agents.length,
      });

      const result = await runDreamB({
        config: this.deps.config,
        agents,
        getMemoryManager: this.deps.getMemoryManager,
        force,
        ...(this.deps.dispatcher ? { dispatcher: this.deps.dispatcher } : {}),
        signal: this.currentAbort.signal,
      });

      const counts = result.outcomes.reduce(
        (acc, o) => {
          acc[o.kind] = (acc[o.kind] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      logger.info({
        msg: 'dream.deep.done',
        trigger,
        force,
        candidatesSeen: result.candidatesSeen,
        cachedSkips: result.cachedSkips,
        outcomes: counts,
        durationMs: result.durationMs,
      });

      const completedAt = Date.now();
      const after: SchedulerState = {
        ...nextState,
        lastCompletedAt: completedAt,
        lastStatus: 'completed',
      };
      try {
        await writeSchedulerState('deep', after);
      } catch (err) {
        logger.warn({ msg: 'dream.deep.state_write_fail', when: 'post-run', err: String(err) });
      }
      void this.scheduleNext('fire-completed');
      return result;
    } catch (err) {
      const failedAt = Date.now();
      const after: SchedulerState = {
        ...nextState,
        lastFailedAt: failedAt,
        lastStatus: 'failed',
      };
      try {
        await writeSchedulerState('deep', after);
      } catch (writeErr) {
        logger.warn({ msg: 'dream.deep.state_write_fail', when: 'post-throw', err: String(writeErr) });
      }
      void this.scheduleNext('fire-failed');
      throw err;
    } finally {
      this.running = false;
      this.currentAbort = null;
    }
  }
}
