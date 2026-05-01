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
        logger.debug({ msg: 'memory.watcher_fired', kind, path });
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
