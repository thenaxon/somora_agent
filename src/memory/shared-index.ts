// Shared retrieval index — vault + wiki chunks, ONE copy per instance.
//
// Until 2026-09 every agent's memory.db carried its own copy of the
// whole vault and wiki (six agents = six identical 1.4k-chunk indexes,
// six watchers on the same folder), and a NEW agent embedded all of it
// on its first turn — 85 s before the model was even asked. The index
// belongs to the source, not to the reader: this module owns
// `~/.somora/index/shared.db`, the only place vault/wiki rows are
// written from now on. Agent managers keep only `source='memory'` in
// their own DB and read vault/wiki from here.
//
// Seamless on update — the design (private/shared-index-design.md):
//   1. First boot on the new version: shared.db is empty → SEED it by
//      copying the vault/wiki rows (files, chunks, FTS via triggers,
//      vectors) from the largest agent DB that used the same embedding
//      model. Seconds, no model call.
//   2. Then the normal hash-skip sweep runs in the background and the
//      watcher starts. State goes `building` → `ready`.
//   3. While not `ready`, agent managers keep answering from their own
//      DB, which still holds the old vault/wiki rows. Nobody waits.
//   4. Those old rows are never deleted (Rene 2026-09-08: leave them);
//      once `ready`, agent managers simply stop reading them.
//   5. On every later boot the persisted `ready` state makes the index
//      usable immediately; the background sweep only catches up on
//      files that changed while the server was down.
//
// The index is a MemoryManager under the hood — same chunker, embedder,
// watcher and self-heal paths as before — pointed at an empty memory
// root and the vault, so the vault/wiki handling is not duplicated.
//
// Roles: the server process is the `owner` (seeds, sweeps, watches).
// The MCP child that serves claude-cli/codex-cli tools is a `reader`:
// it opens shared.db and never writes to it. Before this split the
// child re-swept the whole vault on every tool-process start.

import { readdir } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MemoryConfig } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { MemoryManager, type ObsidianSource, type WikiSource } from './manager.ts';
import { getMeta, openMemoryDb, setMeta, type MemoryDb } from './storage.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

export type SharedIndexState =
  /** No vault configured — nothing to share; agents are memory-only. */
  | 'disabled'
  | 'opening'
  /** DB open, first build (seed and/or sweep) in progress. Agents keep
   *  reading vault/wiki from their own DB meanwhile. */
  | 'building'
  | 'ready'
  | 'failed';

export interface SharedIndexOptions {
  config: MemoryConfig;
  obsidian?: ObsidianSource;
  wiki?: WikiSource;
  searchBoosts?: { wiki: number; memory: number; vault: number };
  role: 'owner' | 'reader';
}

export interface SharedIndexStatus {
  state: SharedIndexState;
  role: 'owner' | 'reader';
  path: string | null;
  files: number;
  chunks: number;
  /** How the current content came to be: seeded from an agent DB, swept
   *  from disk, or carried over from a previous boot. */
  built_by?: string;
  error?: string;
}

const META_BUILD_STATE = 'shared_build_state';
const META_BUILT_BY = 'shared_built_by';

export class SharedIndex {
  readonly role: 'owner' | 'reader';
  private opts: SharedIndexOptions;
  private manager: MemoryManager | null = null;
  private state: SharedIndexState = 'opening';
  private error: string | undefined;
  private builtBy: string | undefined;
  private initPromise: Promise<void> | null = null;

  constructor(opts: SharedIndexOptions) {
    this.opts = opts;
    this.role = opts.role;
  }

  static get dir(): string {
    return join(SOMORA_HOME, 'index');
  }
  static get dbPath(): string {
    return join(SharedIndex.dir, 'shared.db');
  }
  /** An always-empty directory the underlying manager uses as its
   *  "memory root", so the only real root it indexes is the vault. */
  static get emptyRoot(): string {
    return join(SharedIndex.dir, 'no-memory');
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  /** The shared DB for reads — only while ready. */
  db(): MemoryDb | null {
    if (this.state !== 'ready' || !this.manager) return null;
    return this.manager.rawDb();
  }

  status(): SharedIndexStatus {
    const db = this.manager?.rawDb() ?? null;
    let files = 0;
    let chunks = 0;
    if (db) {
      try {
        files = (db.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
        chunks = (db.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
      } catch {
        /* counting is diagnostics only */
      }
    }
    return {
      state: this.state,
      role: this.role,
      path: this.opts.obsidian ? SharedIndex.dbPath : null,
      files,
      chunks,
      ...(this.builtBy ? { built_by: this.builtBy } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Open the DB and — as owner — bring it to `ready`. Resolves once the
   *  DB is OPEN (fast); the build continues in the background. Idempotent. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (!this.opts.obsidian) {
      this.state = 'disabled';
      return;
    }
    try {
      mkdirSync(SharedIndex.emptyRoot, { recursive: true });
      this.manager = new MemoryManager({
        agent: '_shared',
        config: this.opts.config,
        obsidian: this.opts.obsidian,
        ...(this.opts.wiki ? { wiki: this.opts.wiki } : {}),
        ...(this.opts.searchBoosts ? { searchBoosts: this.opts.searchBoosts } : {}),
        dbPath: SharedIndex.dbPath,
        memoryRoot: SharedIndex.emptyRoot,
        indexVault: true,
        // Reader: open only. Owner: open only too — the sweep/watcher are
        // started explicitly below so the seed can run first.
        openOnly: true,
      });
      await this.manager.init();
      const db = this.manager.rawDb()!;
      const persisted = getMeta(db.db, META_BUILD_STATE);
      this.builtBy = getMeta(db.db, META_BUILT_BY) ?? undefined;

      if (this.role === 'reader') {
        // Trust the owner's verdict; a reader never builds.
        this.state = persisted === 'ready' ? 'ready' : 'building';
        logger.info({ msg: 'memory.shared_index_opened', role: 'reader', state: this.state });
        return;
      }

      if (persisted === 'ready') {
        // Usable right away; the sweep below only catches up on changes
        // made while the server was down.
        this.state = 'ready';
        logger.info({ msg: 'memory.shared_index_ready', built_by: this.builtBy ?? 'unknown', resumed: true });
      } else {
        this.state = 'building';
        setMeta(db.db, META_BUILD_STATE, 'building');
      }
      void this.build().catch((err) => {
        this.state = 'failed';
        this.error = (err as Error).message;
        logger.error({ msg: 'memory.shared_index_build_failed', err: this.error });
      });
    } catch (err) {
      this.state = 'failed';
      this.error = (err as Error).message;
      logger.error({ msg: 'memory.shared_index_open_failed', err: this.error, path: SharedIndex.dbPath });
    }
  }

  /** Owner only: seed if empty, sweep, mark ready, start watching. */
  private async build(): Promise<void> {
    const mgr = this.manager!;
    const db = mgr.rawDb()!;
    const t0 = Date.now();
    const fileCount = (db.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    if (fileCount === 0) {
      const seeded = await this.seedFromAgentDb(db);
      if (seeded) {
        this.builtBy = `seed:${seeded.agent}`;
        setMeta(db.db, META_BUILT_BY, this.builtBy);
        logger.info({
          msg: 'memory.shared_index_seeded',
          from: seeded.agent,
          files: seeded.files,
          chunks: seeded.chunks,
          vectors: seeded.vectors,
          ms: Date.now() - t0,
        });
      } else {
        logger.info({
          msg: 'memory.shared_index_seed_skipped',
          reason: 'no agent DB with vault/wiki rows for the configured embedding model — full sweep',
        });
      }
    }
    const sweepStart = Date.now();
    const r = await mgr.reindexAll();
    if (!this.builtBy) {
      this.builtBy = 'sweep';
      setMeta(db.db, META_BUILT_BY, this.builtBy);
    }
    setMeta(db.db, META_BUILD_STATE, 'ready');
    const first = this.state !== 'ready';
    this.state = 'ready';
    mgr.startWatcher();
    logger.info({
      msg: 'memory.shared_index_ready',
      built_by: this.builtBy,
      indexed: r.indexed,
      skipped: r.skipped,
      sweepMs: Date.now() - sweepStart,
      totalMs: Date.now() - t0,
      resumed: !first,
    });
  }

  /** Pick the best donor among the agent DBs and copy its vault/wiki
   *  rows into the (empty) shared DB. See pickSeedDonor / copyVaultWikiRows. */
  private async seedFromAgentDb(
    target: MemoryDb,
  ): Promise<{ agent: string; files: number; chunks: number; vectors: number } | null> {
    const best = await pickSeedDonor(join(SOMORA_HOME, 'agents'), target.embeddingModel, target.vecDim);
    if (!best) return null;
    const result = copyVaultWikiRows(target, best.path);
    return { agent: best.agent, ...result };
  }

  async close(): Promise<void> {
    if (this.manager) {
      await this.manager.close();
      this.manager = null;
    }
  }
}

/**
 * Among `agentsDir/<agent>/memory.db`, the DB with the most vault/wiki files
 * whose embedding model and vec dim match the target's. Vectors only
 * transfer between identical models; when either side has no vec table
 * yet, an FTS-only copy is still worth it. Null when no agent DB holds
 * vault/wiki rows (fresh install) — the caller then sweeps from disk.
 */
export async function pickSeedDonor(
  agentsDir: string,
  wantModel: string | null,
  wantDim: number | null,
): Promise<{ agent: string; path: string; files: number } | null> {
  let names: string[];
  try {
    names = (await readdir(agentsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return null;
  }
  let best: { agent: string; path: string; files: number } | null = null;
  for (const agent of names) {
    const path = join(agentsDir, agent, 'memory.db');
    if (!existsSync(path)) continue;
    let donor: MemoryDb | null = null;
    try {
      donor = openMemoryDb(path);
      const model = getMeta(donor.db, 'embedding_model');
      const compatible =
        wantModel === null || model === null ? true : model === wantModel && donor.vecDim === wantDim;
      if (!compatible) continue;
      const n = (
        donor.db
          .prepare(`SELECT COUNT(*) AS n FROM files WHERE source IN ('vault','wiki')`)
          .get() as { n: number }
      ).n;
      if (n > 0 && (!best || n > best.files)) best = { agent, path, files: n };
    } catch (err) {
      logger.debug({ msg: 'memory.shared_index_seed_probe_failed', agent, err: (err as Error).message });
    } finally {
      donor?.db.close();
    }
  }
  return best;
}

/**
 * Copy the vault/wiki rows of `donorPath` into `target` (which must be
 * empty). Chunk ids are preserved — nothing collides in an empty DB —
 * which is what lets the vectors be copied by rowid. FTS rows follow
 * from the insert triggers on `chunks`. One transaction; the donor is
 * attached read-only for its duration.
 */
export function copyVaultWikiRows(
  target: MemoryDb,
  donorPath: string,
): { files: number; chunks: number; vectors: number } {
  const existing = (target.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
  if (existing > 0) throw new Error(`copyVaultWikiRows: target already holds ${existing} files`);
  target.db.prepare(`ATTACH DATABASE ? AS donor`).run(donorPath);
  try {
    const copy = target.db.transaction(() => {
      target.db.exec(
        `INSERT INTO files(path, source, hash, mtime, size)
           SELECT path, source, hash, mtime, size FROM donor.files WHERE source IN ('vault','wiki');
         INSERT INTO chunks(id, file_path, source, slug, start_line, end_line, hash, model, text, updated_at)
           SELECT id, file_path, source, slug, start_line, end_line, hash, model, text, updated_at
           FROM donor.chunks WHERE source IN ('vault','wiki');`,
      );
      let vectors = 0;
      if (target.hasVec) {
        const donorVec = target.db
          .prepare(`SELECT 1 FROM donor.sqlite_master WHERE type='table' AND name='chunks_vec' LIMIT 1`)
          .get();
        if (donorVec) {
          const r = target.db
            .prepare(
              `INSERT INTO chunks_vec(rowid, embedding)
                 SELECT rowid, embedding FROM donor.chunks_vec
                 WHERE rowid IN (SELECT id FROM donor.chunks WHERE source IN ('vault','wiki'))`,
            )
            .run();
          vectors = Number(r.changes);
        }
      }
      // Keep the AUTOINCREMENT sequence past the copied ids so a new
      // chunk never reuses an id that still has a vector row.
      target.db.exec(
        `INSERT OR REPLACE INTO sqlite_sequence(name, seq) SELECT 'chunks', COALESCE(MAX(id), 0) FROM chunks`,
      );
      const files = (target.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
      const chunks = (target.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
      return { files, chunks, vectors };
    });
    return copy();
  } finally {
    target.db.prepare(`DETACH DATABASE donor`).run();
  }
}
