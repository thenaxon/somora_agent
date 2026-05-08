// Wiki-Lint Auto-Worker (Dream-C). Server-global background scheduler
// that fires Dream-C every `intervalDays` (default 7d) and on manual
// trigger from `dream_run({mode: 'c'})`.
//
// Real-clock scheduling, reentrancy-safe (skips if a run is in flight).
// Mirrors WikiPromotionWorker's structure.

import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { runLint, type RunLintResult } from './lint-runner.ts';

export interface WikiLintWorkerDeps {
  config: Config;
}

export class WikiLintWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;

  constructor(private deps: WikiLintWorkerDeps) {}

  /** Start the real-clock scheduler. First fire happens after
   *  `intervalDays`, not immediately. */
  start(): void {
    if (this.shuttingDown) return;
    if (this.timer) return;
    if (!this.deps.config.wiki.enabled) {
      logger.info({ msg: 'wiki.lint.disabled', hint: 'config.wiki.enabled is false' });
      return;
    }
    if (!this.deps.config.wiki.lint.enabled) {
      logger.info({ msg: 'wiki.lint.lint_disabled' });
      return;
    }
    const intervalMs = this.deps.config.wiki.lint.intervalDays * 24 * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      void this.fire('auto');
    }, intervalMs);
    logger.info({
      msg: 'wiki.lint.scheduled',
      intervalDays: this.deps.config.wiki.lint.intervalDays,
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
    logger.info({ msg: 'wiki.lint.shutdown' });
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
        msg: 'wiki.lint.skip_reentrant',
        trigger,
        hint: 'previous lint run still in flight',
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
