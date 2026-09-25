// File-system watcher with debounced re-index. Watches the markdown roots
// for an agent (own memory dir + optional Obsidian vault) and fires a
// callback per file change. Caller (the manager) decides what to do with it.
//
// Debounce is per-path so a burst of editor saves on different files all
// fire after one quiet period — no head-of-line blocking.
//
// IMPORTANT: chokidar 5+ removed glob-pattern support. We pass directories
// to chokidar.watch() and filter for .md extensions inside our event
// handlers. Pre-5 code that passed `**/*.md` patterns silently watched
// nothing on chokidar 5 (literal path interpretation).

import chokidar, { type FSWatcher } from 'chokidar';
import { logger } from '../server/logger.ts';
import { isTransientWatcherError, watcherRetryDelayMs } from './rescan.ts';

export type FileEvent =
  | { kind: 'change'; path: string }
  | { kind: 'unlink'; path: string };

export interface WatcherOptions {
  /** Directory roots to watch (absolute paths). All .md files within (recursive) are observed. */
  roots: string[];
  /**
   * Paths to ignore. Strings, RegExp, or a (path, stats?) → boolean function.
   * chokidar 5 calls this with an optional fs.Stats arg; only pass file-stat
   * to it for files (not directories) so we don't accidentally prune dirs.
   */
  ignored?: Array<string | RegExp | ((path: string) => boolean)>;
  /** Fire change events at most every N ms per path. Default 1500. */
  debounceMs?: number;
  /** Callback per coalesced event. */
  onEvent: (e: FileEvent) => void | Promise<void>;
}

export class MarkdownWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  /** Retry state: attempts since the last clean initial scan, and the
   *  pending restart timer. A share that is down while the server boots
   *  (EHOSTDOWN) fails the scan; the watcher then restarts itself with a
   *  growing delay instead of staying silent until the next restart. */
  private retryAttempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private opts: Required<Omit<WatcherOptions, 'ignored'>> & Pick<WatcherOptions, 'ignored'>;

  constructor(opts: WatcherOptions) {
    this.opts = {
      debounceMs: 1500,
      ...opts,
    };
  }

  start(): void {
    if (this.watcher) return;
    if (this.opts.roots.length === 0) {
      logger.info({ msg: 'memory.watcher_no_roots' });
      return;
    }
    this.watcher = chokidar.watch(this.opts.roots, {
      ignored: this.opts.ignored,
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    });

    const schedule = (kind: 'change' | 'unlink', path: string) => {
      // Hard filter: only markdown files reach the manager. Watching dirs
      // means we get events for every file; we ignore non-.md here.
      if (!path.toLowerCase().endsWith('.md')) return;
      const existing = this.timers.get(path);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        this.timers.delete(path);
        logger.info({ msg: 'memory.watcher_fired', kind, path });
        Promise.resolve(this.opts.onEvent({ kind, path })).catch((err) =>
          logger.error({ msg: 'memory.watcher_event_handler_failed', path, err: String(err) }),
        );
      }, this.opts.debounceMs);
      this.timers.set(path, t);
    };

    this.watcher.on('add', (path) => schedule('change', path));
    this.watcher.on('change', (path) => schedule('change', path));
    this.watcher.on('unlink', (path) => schedule('unlink', path));
    this.watcher.on('ready', () => {
      if (this.retryAttempt > 0) logger.info({ msg: 'memory.watcher_recovered', roots: this.opts.roots, attempts: this.retryAttempt });
      this.retryAttempt = 0;
    });
    this.watcher.on('error', (err) => {
      logger.error({ msg: 'memory.watcher_error', err: String(err) });
      if (isTransientWatcherError(err)) this.scheduleRestart(String(err));
    });
    logger.info({ msg: 'memory.watcher_started', roots: this.opts.roots, debounceMs: this.opts.debounceMs });
  }

  /** Tear down and start again after a delay that grows per attempt.
   *  One pending restart at a time; a later error while one is pending
   *  changes nothing. */
  private scheduleRestart(reason: string): void {
    if (this.retryTimer || this.stopped) return;
    this.retryAttempt += 1;
    const delayMs = watcherRetryDelayMs(this.retryAttempt);
    logger.warn({ msg: 'memory.watcher_retry', roots: this.opts.roots, attempt: this.retryAttempt, delayMs, err: reason.slice(0, 160) });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      void this.closeInner().then(() => {
        if (!this.stopped) this.start();
      });
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private async closeInner(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.watcher) {
      const w = this.watcher;
      this.watcher = null;
      await w.close().catch((err) => logger.warn({ msg: 'memory.watcher_close_failed', err: String(err) }));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.closeInner();
  }
}
