// Wiki-Promotion Auto-Worker (Dream-B). Server-global background
// scheduler that fires Dream-B every `intervalHours` (default 12h)
// and on manual trigger from a tool.
//
// Real-clock scheduling, not idle-driven (Dream-A is per-agent idle;
// Dream-B runs across all agents on a fixed cadence). Reentrancy-safe:
// if a run is still in flight when the timer fires, we skip the new
// trigger and log it.
//
// See `private/wiki-design.md` § "Drei Dream-Modes".

import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { runDreamB, type RunDreamBResult } from './dream-b-runner.ts';
import type { PromotionDispatcher } from './types.ts';

export interface WikiAutoWorkerDeps {
  config: Config;
  /** Resolves agents currently configured to participate in the wiki. */
  getParticipatingAgents: () => Promise<Array<{ name: string; vaultPath: string }>>;
  /** Test injection point. Production passes undefined → Default. */
  dispatcher?: PromotionDispatcher;
  /** Optional callback fired before/after Dream-B for the pre-sweep
   *  (Dream-A force-run on agents with un-processed sessions). Caller
   *  wires this from the existing AutoDreamWorker. */
  preSweep?: () => Promise<void>;
}

export class WikiPromotionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;
  private currentAbort: AbortController | null = null;

  constructor(private deps: WikiAutoWorkerDeps) {}

  /** Start the real-clock scheduler. First fire happens after
   *  `intervalHours`, not immediately on start — server-fresh
   *  Dream-A runs need to populate memory first. */
  start(): void {
    if (this.shuttingDown) return;
    if (this.timer) return;
    if (!this.deps.config.wiki.enabled) {
      logger.info({ msg: 'wiki.dream_b.disabled', hint: 'config.wiki.enabled is false' });
      return;
    }
    if (!this.deps.config.wiki.promotion.enabled) {
      logger.info({ msg: 'wiki.dream_b.promotion_disabled' });
      return;
    }
    const intervalMs = this.deps.config.wiki.promotion.intervalHours * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.fire('scheduled');
    }, intervalMs);
    logger.info({
      msg: 'wiki.dream_b.scheduled',
      intervalHours: this.deps.config.wiki.promotion.intervalHours,
      preSweepMinutes: this.deps.config.wiki.promotion.preSweepMinutes,
    });
  }

  /** Manual trigger. Returns the run result for logging by the caller
   *  (e.g. the dream_b_run_now tool surfaces it back to the user). */
  async runNow(): Promise<RunDreamBResult> {
    return this.fire('manual');
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    logger.info({ msg: 'wiki.dream_b.shutdown' });
  }

  private async fire(trigger: 'scheduled' | 'manual'): Promise<RunDreamBResult> {
    if (this.shuttingDown) {
      return { outcomes: [], candidatesSeen: 0, durationMs: 0 };
    }
    if (this.running) {
      logger.warn({
        msg: 'wiki.dream_b.skip_reentrant',
        trigger,
        hint: 'previous run still in flight — manual trigger waits for next cycle',
      });
      return { outcomes: [], candidatesSeen: 0, durationMs: 0 };
    }
    this.running = true;
    this.currentAbort = new AbortController();

    try {
      // Pre-sweep: force Dream-A on agents with unprocessed sessions
      // before we go to Dream-B. Caller wires this from the existing
      // AutoDreamWorker.
      if (this.deps.preSweep) {
        try {
          await this.deps.preSweep();
        } catch (err) {
          logger.warn({ msg: 'wiki.dream_b.pre_sweep_failed', err: (err as Error).message });
        }
      }

      const agents = await this.deps.getParticipatingAgents();
      logger.info({
        msg: 'wiki.dream_b.start',
        trigger,
        agents: agents.length,
      });

      const result = await runDreamB({
        config: this.deps.config,
        agents,
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
        msg: 'wiki.dream_b.done',
        trigger,
        candidatesSeen: result.candidatesSeen,
        outcomes: counts,
        durationMs: result.durationMs,
      });
      return result;
    } finally {
      this.running = false;
      this.currentAbort = null;
    }
  }
}
