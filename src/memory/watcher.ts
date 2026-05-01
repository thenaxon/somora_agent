// File-system watcher with debounced re-index. Watches the markdown roots
// for an agent (own memory dir + optional Obsidian vault) and fires a
// callback per file change. Caller (the manager) decides what to do with it.
//
// Debounce is per-path so a burst of editor saves on different files all
// fire after one quiet period — no head-of-line blocking.

import chokidar, { type FSWatcher } from 'chokidar';
import { logger } from '../server/logger.ts';

export type FileEvent =
  | { kind: 'change'; path: string }
  | { kind: 'unlink'; path: string };

export interface WatcherOptions {
  /** Roots to watch (absolute paths). Glob `**\/*.md` is applied per root. */
  roots: string[];
  /** Paths to ignore (passed to chokidar `ignored`). */
  ignored?: Array<string | RegExp>;
  /** Fire change events at most every N ms per path. Default 1500. */
  debounceMs?: number;
  /** Callback per coalesced event. */
  onEvent: (e: FileEvent) => void | Promise<void>;
}

export class MarkdownWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
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
    const patterns = this.opts.roots.map((r) => `${r}/**/*.md`);
    this.watcher = chokidar.watch(patterns, {
      ignored: this.opts.ignored,
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    });

    const schedule = (kind: 'change' | 'unlink', path: string) => {
      const existing = this.timers.get(path);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        this.timers.delete(path);
        Promise.resolve(this.opts.onEvent({ kind, path })).catch((err) =>
          logger.error({ msg: 'memory.watcher_event_handler_failed', path, err: String(err) }),
        );
      }, this.opts.debounceMs);
      this.timers.set(path, t);
    };

    this.watcher.on('add', (path) => schedule('change', path));
    this.watcher.on('change', (path) => schedule('change', path));
    this.watcher.on('unlink', (path) => schedule('unlink', path));
    this.watcher.on('error', (err) =>
      logger.error({ msg: 'memory.watcher_error', err: String(err) }),
    );
    logger.info({ msg: 'memory.watcher_started', roots: this.opts.roots, debounceMs: this.opts.debounceMs });
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
