// LucidWorker — Wiki maintenance / cleanup. Server-global background
// scheduler that fires Lucid every `intervalDays` (default 7d) and
// on manual trigger from `dream_run({phase: 'lucid'})`.
//
// Real-clock scheduling. Reentrancy-safe (skips if a run is in flight).
// Mirrors DeepWorker's structure.
//
// Restart-safe: scheduler state is persisted to
// `~/.somora/dream-state/lucid.json`. On every start the worker reads
// the last successful completion and schedules `setTimeout(nextDueAt -
// now)` so a server that restarts more often than `intervalDays`
// doesn't starve auto-runs.
//
// As of v2.6 wraps `runLucid` (LLM-driven). The deterministic lint
// runner is retired.

import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { listLucidRuns, pendingLucidRun, setRunStatus, writeLucidRun } from './lucid-storage.ts';
import { runLucid, type RunLucidResult } from './lucid-runner.ts';
import {
  interruptedRetryDelay,
  MAX_INTERRUPTED_RETRIES,
  nextDelayMs,
  readSchedulerState,
  writeSchedulerState,
  type SchedulerState,
} from './scheduler-state.ts';

export interface LucidWorkerDeps {
  config: Config;
}

export class LucidWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private shuttingDown = false;
  private currentAbort: AbortController | null = null;

  constructor(private deps: LucidWorkerDeps) {}

  /** Start the persistent-state scheduler. Reads
   *  `~/.somora/dream-state/lucid.json` to compute the next due time
   *  from the last completed run, then schedules a single setTimeout.
   *  After each fire the next timer is scheduled recursively, again
   *  from disk state — so an in-flight server restart doesn't reset
   *  the cadence. */
  async start(): Promise<void> {
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
    await this.markInterruptedRuns();
    await this.scheduleNext('startup');
  }

  /** A run file still on `running` at startup belongs to a run the last
   *  server stopped mid-way (restart, update, crash): nothing will ever
   *  finish it. Mark it failed with that reason, so it no longer reads as
   *  in progress anywhere. */
  private async markInterruptedRuns(): Promise<void> {
    try {
      for (const run of await listLucidRuns()) {
        if (run.status !== 'running') continue;
        setRunStatus(run, 'failed', 'interrupted: the server stopped during the run (restart, update or crash)');
        await writeLucidRun(run);
        logger.warn({ msg: 'dream.lucid.run_interrupted', runId: run.id, startedAt: run.created_at });
      }
    } catch (err) {
      logger.warn({ msg: 'dream.lucid.mark_interrupted_failed', err: String(err) });
    }
  }

  async runNow(opts: { force?: boolean } = {}): Promise<RunLucidResult> {
    return this.fire('manual', opts.force === true);
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
    logger.info({ msg: 'dream.lucid.shutdown' });
  }

  private async scheduleNext(after: 'startup' | 'fire-completed' | 'fire-failed'): Promise<void> {
    if (this.shuttingDown) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const intervalMs = this.deps.config.wiki.lucid.intervalDays * 24 * 60 * 60 * 1000;
    let state = await readSchedulerState('lucid');
    // Bootstrap on first-ever start. Without this, a fresh install
    // suffers restart-starvation _before_ the first auto-fire: every
    // restart sees `state.empty → schedule full interval out`, so a
    // user who restarts even once per week never gets the first auto-
    // Lucid. Writing `lastCompletedAt = now` here anchors the cadence
    // to the install moment and is durable across restarts.
    if (after === 'startup' && state.lastCompletedAt === null && state.lastStartedAt === null && state.lastFailedAt === null) {
      const bootstrappedAt = Date.now();
      state = { ...state, lastCompletedAt: bootstrappedAt };
      try {
        await writeSchedulerState('lucid', state);
        logger.info({
          msg: 'dream.lucid.bootstrap',
          bootstrappedAt,
          hint: 'first-ever start, anchored cadence to now so restarts before first fire do not reset the timer',
        });
      } catch (err) {
        logger.warn({ msg: 'dream.lucid.state_write_fail', when: 'bootstrap', err: String(err) });
      }
    }
    // A run the last server cut off is retried after an hour, at most
    // MAX_INTERRUPTED_RETRIES times in a row — instead of waiting a whole
    // interval from its start (2026-10-07: a restart at batch 15 of 41
    // pushed the next Lucid a week out, two weeks after the last one).
    const retry = after === 'startup' ? interruptedRetryDelay(state) : null;
    if (retry) {
      this.timer = setTimeout(() => {
        void this.fire('auto', false, true);
      }, retry.delayMs);
      logger.info({
        msg: 'dream.lucid.scheduled',
        intervalDays: this.deps.config.wiki.lucid.intervalDays,
        after,
        reason: 'interrupted',
        attempt: retry.attempt,
        maxAttempts: MAX_INTERRUPTED_RETRIES,
        lastStartedAt: state.lastStartedAt,
        nextDueAt: retry.nextDueAt,
        delayMs: retry.delayMs,
      });
      return;
    }
    const { delayMs, nextDueAt, reason } = nextDelayMs(state, intervalMs);
    this.timer = setTimeout(() => {
      void this.fire('auto');
    }, delayMs);
    logger.info({
      msg: 'dream.lucid.scheduled',
      intervalDays: this.deps.config.wiki.lucid.intervalDays,
      after,
      reason,
      lastCompletedAt: state.lastCompletedAt,
      lastStartedAt: state.lastStartedAt,
      nextDueAt,
      delayMs,
    });
  }

  private async fire(trigger: 'auto' | 'manual', force = false, interruptedRetry = false): Promise<RunLucidResult> {
    // A run whose findings nobody has looked at yet is not followed by
    // another one — that made the same findings pile up twice (the operator,
    // 2026-09-29). `force` (dream_run / POST /dream/run-lucid) overrides.
    if (!force) {
      const waiting = await pendingLucidRun();
      if (waiting) {
        const open = waiting.findings.filter((f) => f.status === 'pending').length;
        logger.info({ msg: 'dream.lucid.skip_pending', trigger, waitingRun: waiting.id, openFindings: open, hint: 'review or dismiss that run first; force:true runs anyway' });
        if (trigger === 'auto' && !this.shuttingDown) {
          // Look again in six hours — the cadence state is untouched, so
          // the regular schedule would fire right away and skip again.
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            void this.fire('auto');
          }, 6 * 60 * 60_000);
        }
        return { runId: waiting.id, findingsCount: open, pagesScanned: 0, durationMs: 0, status: 'completed' };
      }
    }
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
    this.currentAbort = new AbortController();
    const startedAt = Date.now();
    // Persist the start eagerly so an auto-run that crashes the server
    // mid-flight still bumps the cadence (otherwise repeat-crashes
    // would re-fire the same heavy run on every restart).
    const stateBefore = await readSchedulerState('lucid');
    // A retry of a cut-off run counts up; any other start begins at 0.
    const nextState: SchedulerState = {
      ...stateBefore,
      lastStartedAt: startedAt,
      interruptedRetries: interruptedRetry ? (stateBefore.interruptedRetries ?? 0) + 1 : 0,
    };
    try {
      await writeSchedulerState('lucid', nextState);
    } catch (err) {
      logger.warn({ msg: 'dream.lucid.state_write_fail', when: 'pre-run', err: String(err) });
    }
    try {
      const result = await runLucid({
        config: this.deps.config,
        trigger,
        signal: this.currentAbort.signal,
      });
      const completedAt = Date.now();
      const after: SchedulerState = {
        ...nextState,
        interruptedRetries: 0,
        lastCompletedAt: completedAt,
        lastStatus: result.status === 'failed' ? 'failed' : 'completed',
        ...(result.status === 'failed' ? { lastFailedAt: completedAt } : {}),
      };
      try {
        await writeSchedulerState('lucid', after);
      } catch (err) {
        logger.warn({ msg: 'dream.lucid.state_write_fail', when: 'post-run', err: String(err) });
      }
      // Reschedule the next auto-run from the just-completed timestamp.
      // Manual runs also reset the cadence — that matches user
      // expectation ("if I ran it just now, next auto should be a
      // full interval from now, not the original schedule").
      void this.scheduleNext(result.status === 'failed' ? 'fire-failed' : 'fire-completed');
      return result;
    } catch (err) {
      const failedAt = Date.now();
      const after: SchedulerState = {
        ...nextState,
        interruptedRetries: 0,
        lastFailedAt: failedAt,
        lastStatus: 'failed',
      };
      try {
        await writeSchedulerState('lucid', after);
      } catch (writeErr) {
        logger.warn({ msg: 'dream.lucid.state_write_fail', when: 'post-throw', err: String(writeErr) });
      }
      void this.scheduleNext('fire-failed');
      throw err;
    } finally {
      this.running = false;
      this.currentAbort = null;
    }
  }
}
