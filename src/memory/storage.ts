// Memory storage layer.
//
// Source-of-truth (DECISION #25): Markdown files on disk. This module owns
// the SQLite + sqlite-vec index that's *derived* from those files. Lose
// memory.db → run reindex → equivalent state. Don't put any unique data
// here that isn't recoverable from the markdown corpus.
//
// Schema:
//   meta(key, value)               — schema_version, embedding_model, vec_dim
//   files(path, source, hash, mtime, size)
//   chunks(id, file_path, source, slug, start_line, end_line, hash, model,
//          text, updated_at)
//   chunks_fts                     — FTS5 virtual table over chunks.text
//                                    (created up front; tokenizer = unicode61)
//   chunks_vec                     — sqlite-vec vec0 virtual table for
//                                    embeddings; created lazily once we know
//                                    the embedding dimension (model-dependent)

import Database, { type Database as DatabaseT } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { logger } from '../server/logger.ts';

export const SCHEMA_VERSION = 1;

export interface FileRow {
  path: string;
  source: string; // 'memory' | 'vault' | 'wiki' — see ChunkSource in manager.ts
  hash: string;
  mtime: number;
  size: number;
}

export interface ChunkRow {
  id: number;
  file_path: string;
  source: string;
  slug: string;
  start_line: number;
  end_line: number;
  hash: string;
  model: string;
  text: string;
  updated_at: number;
}

export interface MemoryDb {
  db: DatabaseT;
  hasVec: boolean;
  vecDim: number | null;
  embeddingModel: string | null;
}

/**
 * Open (or create) a memory.db at the given path. Loads sqlite-vec if
 * available; falls back to FTS-only operation otherwise (with a warning).
 * Vec table is *not* created here — call ensureVecTable() once you know
 * the embedding dimension.
 */
export function openMemoryDb(dbPath: string): MemoryDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  let hasVec = false;
  try {
    sqliteVec.load(db);
    hasVec = true;
  } catch (err) {
    logger.warn({
      msg: 'memory.sqlite_vec_unavailable',
      dbPath,
      err: (err as Error).message,
      hint: 'falling back to FTS-only retrieval; install platform-specific sqlite-vec binary',
    });
  }

  // Base schema. vec0 table comes later in ensureVecTable() because its
  // column type ("float[N]") depends on the embedding model.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      source TEXT NOT NULL,
      slug TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_slug ON chunks(slug);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61'
    );

    -- Keep FTS in sync with the chunks table via triggers
    CREATE TRIGGER IF NOT EXISTS chunks_fts_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_fts_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_fts_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  setMeta(db, 'schema_version', String(SCHEMA_VERSION));

  const vecDim = getMetaInt(db, 'vec_dim');
  const embeddingModel = getMeta(db, 'embedding_model');

  return { db, hasVec, vecDim, embeddingModel };
}

/**
 * Create the vec0 virtual table if it doesn't exist yet, with the given
 * embedding dimension. Idempotent. Persists `vec_dim` to meta so we can
 * detect mismatches on subsequent opens.
 */
export function ensureVecTable(memDb: MemoryDb, dim: number, model: string): void {
  if (!memDb.hasVec) return;
  const existing = getMetaInt(memDb.db, 'vec_dim');
  const existingModel = getMeta(memDb.db, 'embedding_model');
  if (existing && existing !== dim) {
    throw new Error(
      `memory.db has vec_dim=${existing} (model=${existingModel ?? '?'}), incompatible with new dim=${dim} (model=${model}). Delete memory.db to re-index from scratch with the new model.`,
    );
  }
  if (existingModel && existingModel !== model) {
    logger.warn({
      msg: 'memory.embedding_model_changed',
      old: existingModel,
      new: model,
      hint: 'existing chunks were embedded with the old model; consider full reindex',
    });
  }
  // Note: vec0 column type uses brackets — bind with literal SQL.
  memDb.db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      embedding float[${dim}]
    );
  `);
  setMeta(memDb.db, 'vec_dim', String(dim));
  setMeta(memDb.db, 'embedding_model', model);
  memDb.vecDim = dim;
  memDb.embeddingModel = model;
}

export function setMeta(db: DatabaseT, key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function getMeta(db: DatabaseT, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function getMetaInt(db: DatabaseT, key: string): number | null {
  const v = getMeta(db, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Upsert a file row. Returns true if hash changed (i.e. needs re-indexing). */
export function upsertFile(memDb: MemoryDb, row: FileRow): { changed: boolean } {
  const existing = memDb.db
    .prepare(`SELECT hash FROM files WHERE path = ?`)
    .get(row.path) as { hash: string } | undefined;
  if (existing && existing.hash === row.hash) {
    return { changed: false };
  }
  memDb.db
    .prepare(
      `INSERT INTO files(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET source=excluded.source, hash=excluded.hash,
       mtime=excluded.mtime, size=excluded.size`,
    )
    .run(row.path, row.source, row.hash, row.mtime, row.size);
  return { changed: true };
}

/** Remove a file row + cascading chunks (and their FTS/vec entries). */
export function deleteFile(memDb: MemoryDb, path: string): void {
  // Capture chunk ids first so we can clean up the vec table
  const ids = memDb.db
    .prepare(`SELECT id FROM chunks WHERE file_path = ?`)
    .all(path) as { id: number }[];
  if (memDb.hasVec && ids.length > 0) {
    const stmt = memDb.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`);
    for (const { id } of ids) stmt.run(BigInt(id));
  }
  memDb.db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
}

export interface ChunkInsert {
  file_path: string;
  source: string;
  slug: string;
  start_line: number;
  end_line: number;
  hash: string;
  model: string;
  text: string;
}

/**
 * Replace all chunks for a file in one transaction. Inserts FTS and vec
 * rows alongside. Embeddings array must align with chunks array.
 */
export function replaceFileChunks(
  memDb: MemoryDb,
  filePath: string,
  chunks: ChunkInsert[],
  embeddings: Float32Array[] | null,
): void {
  if (embeddings && embeddings.length !== chunks.length) {
    throw new Error(`embeddings.length=${embeddings.length} mismatches chunks.length=${chunks.length}`);
  }
  const now = Date.now();
  const tx = memDb.db.transaction(() => {
    // Old chunks
    const oldIds = memDb.db
      .prepare(`SELECT id FROM chunks WHERE file_path = ?`)
      .all(filePath) as { id: number }[];
    if (memDb.hasVec) {
      const delVec = memDb.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`);
      for (const { id } of oldIds) delVec.run(BigInt(id));
    }
    memDb.db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath);

    // New chunks
    const insertChunk = memDb.db.prepare(
      `INSERT INTO chunks(file_path, source, slug, start_line, end_line, hash, model, text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVec = memDb.hasVec
      ? memDb.db.prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)`)
      : null;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const result = insertChunk.run(
        c.file_path,
        c.source,
        c.slug,
        c.start_line,
        c.end_line,
        c.hash,
        c.model,
        c.text,
        now,
      );
      const id = result.lastInsertRowid;
      if (insertVec && embeddings) {
        // sqlite-vec's vec0 virtual table requires bigint rowids and accepts
        // Float32Array directly — Buffer wrapping doesn't work cleanly here.
        const rowidBig = typeof id === 'bigint' ? id : BigInt(id);
        insertVec.run(rowidBig, embeddings[i]!);
      }
    }
  });
  tx();
}

export function listChunksByFile(memDb: MemoryDb, path: string): ChunkRow[] {
  return memDb.db
    .prepare(`SELECT * FROM chunks WHERE file_path = ? ORDER BY start_line`)
    .all(path) as ChunkRow[];
}

export function listAllFiles(memDb: MemoryDb, source?: string): FileRow[] {
  if (source) {
    return memDb.db
      .prepare(`SELECT * FROM files WHERE source = ? ORDER BY path`)
      .all(source) as FileRow[];
  }
  return memDb.db.prepare(`SELECT * FROM files ORDER BY path`).all() as FileRow[];
}

export function closeMemoryDb(memDb: MemoryDb): void {
  memDb.db.close();
}
