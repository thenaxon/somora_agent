// LucidWorker — Wiki maintenance / cleanup. Server-global background
// scheduler that fires Lucid every `intervalDays` (default 7d) and
// on manual trigger from `dream_run({phase: 'lucid'})`.
//
// Real-clock scheduling, reentrancy-safe (skips if a run is in flight).
// Mirrors DeepWorker's structure.
//
// Note: as of v2.1 still wraps the deterministic lint runner from
// `src/wiki/lint-runner.ts`. v2.6 replaces that with an LLM-driven
// `lucid-runner.ts` — this worker stays unchanged structurally.

import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { runLint, type RunLintResult } from '../wiki/lint-runner.ts';

export interface LucidWorkerDeps {
  config: Config;
}

export class LucidWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;

  constructor(private deps: LucidWorkerDeps) {}

  /** Start the real-clock scheduler. First fire happens after
   *  `intervalDays`, not immediately. */
  start(): void {
    if (this.shuttingDown) return;
    if (this.timer) return;
    if (!this.deps.config.wiki.enabled) {
      logger.info({ msg: 'dream.lucid.disabled', hint: 'config.wiki.enabled is false' });
      return;
    }
    if (!this.deps.config.wiki.lucid.enabled) {
      logger.info({ msg: 'dream.lucid.lucid_disabled' });
      return;
    }
    const intervalMs = this.deps.config.wiki.lucid.intervalDays * 24 * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.fire('auto');
    }, intervalMs);
    logger.info({
      msg: 'dream.lucid.scheduled',
      intervalDays: this.deps.config.wiki.lucid.intervalDays,
    });
  }

  async runNow(): Promise<RunLintResult> {
    return this.fire('manual');
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info({ msg: 'dream.lucid.shutdown' });
  }

  private async fire(trigger: 'auto' | 'manual'): Promise<RunLintResult> {
    if (this.shuttingDown) {
      return {
        runId: '(shutdown)',
        findingsCount: 0,
        pagesScanned: 0,
        durationMs: 0,
        status: 'failed',
      };
    }
    if (this.running) {
      logger.warn({
        msg: 'dream.lucid.skip_reentrant',
        trigger,
        hint: 'previous lucid run still in flight',
      });
      return {
        runId: '(reentrant)',
        findingsCount: 0,
        pagesScanned: 0,
        durationMs: 0,
        status: 'failed',
      };
    }
    this.running = true;
    try {
      return await runLint({ config: this.deps.config, trigger });
    } finally {
      this.running = false;
    }
  }
}
