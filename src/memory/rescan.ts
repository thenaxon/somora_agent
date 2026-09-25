// Periodic sweep + watcher retry policy (2026-09-25, Rene: vault files
// edited from another machine reached the index late).
//
// The vault is a network share (CIFS). A file written on another
// machine lands on the share's server; the somora host gets no
// inotify event for it, so the watcher never fires and the file was
// indexed only by the full sweep at the next server start. And when
// the share is unreachable while the server boots (EHOSTDOWN at 09:43
// today, 83 errors), the watcher's initial scan fails and nothing
// retries. Two small pieces fix both:
//
//   RescanLoop  — runs the manager's full sweep every N minutes. The
//                 sweep skips unchanged files by hash (999 files, ~1 s),
//                 so it costs nothing when nothing changed.
//   retry policy — the watcher restarts itself after a transient error
//                 with a growing delay, instead of staying silent until
//                 the next restart.

import { logger } from '../server/logger.ts';

export interface RescanResult {
  indexed: number;
  skipped: number;
}

export interface RescanLoopOptions {
  intervalMs: number;
  run: () => Promise<RescanResult>;
  /** Log context (agent, role). */
  logCtx?: Record<string, unknown>;
}

/**
 * Calls `run` every `intervalMs`, never overlapping: a sweep that is
 * still going when the next tick comes makes the tick a no-op. Timers
 * are unref'd so the loop never keeps the process alive.
 */
export class RescanLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private runs = 0;

  constructor(private readonly opts: RescanLoopOptions) {}

  start(): void {
    if (this.timer || this.opts.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.runNow(), this.opts.intervalMs);
    this.timer.unref?.();
    logger.info({ msg: 'memory.rescan_started', ...this.opts.logCtx, intervalMs: this.opts.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One sweep now; null when a sweep is already in progress. */
  async runNow(): Promise<RescanResult | null> {
    if (this.running) return null;
    this.running = true;
    const t0 = Date.now();
    try {
      const r = await this.opts.run();
      this.runs++;
      // Quiet when nothing changed — a line every N minutes for "0
      // indexed" would be noise; the first run says the loop works.
      if (r.indexed > 0 || this.runs === 1) {
        logger.info({ msg: 'memory.rescan_done', ...this.opts.logCtx, indexed: r.indexed, skipped: r.skipped, ms: Date.now() - t0 });
      }
      return r;
    } catch (err) {
      logger.warn({ msg: 'memory.rescan_failed', ...this.opts.logCtx, err: (err as Error).message, ms: Date.now() - t0 });
      return { indexed: 0, skipped: 0 };
    } finally {
      this.running = false;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}

/** Errors a network share or a not-yet-mounted root produces; a retry
 *  later can succeed. Anything else (EACCES, a bug) is not retried. */
const TRANSIENT_CODES = new Set(['EHOSTDOWN', 'EHOSTUNREACH', 'ENOTCONN', 'ECONNRESET', 'ETIMEDOUT', 'EIO', 'ENOENT', 'ENXIO', 'EAGAIN', 'ESTALE', 'ENODEV']);

export function isTransientWatcherError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const text = String(err);
  return [...TRANSIENT_CODES].some((c) => text.includes(c + ':') || text.includes(c + ' '));
}

/** 30 s, 60 s, 2 min, 4 min, 8 min, then 10 min for every further attempt. */
export function watcherRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(30_000 * 2 ** (n - 1), 10 * 60_000);
}
