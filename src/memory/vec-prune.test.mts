// Tests for pruneOrphanVecRows — vec-ghost cleanup (2026-07-23).
//
// Run: npx tsx src/memory/vec-prune.test.mts
//
// Regression (Juni-Audit): a process WITHOUT the sqlite-vec extension
// deletes/reindexes chunks but can't touch chunks_vec (delete gated on
// hasVec), leaving orphan vector rows. A later vec-enabled process then
// surfaces them as ghosts in top-k KNN results. pruneOrphanVecRows sweeps
// them on the next vec-enabled reindex. Verified live: hans had 14 orphans
// (23 vec rows, 9 valid) — the prune removed exactly the 14.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeMemoryDb,
  ensureVecTable,
  openMemoryDb,
  pruneOrphanVecRows,
  replaceFileChunks,
  upsertFile,
} from './storage.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const DB = join(tmpdir(), `somora-vec-prune-${process.pid}.db`);
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

const db = openMemoryDb(DB);

if (!db.vecExtensionLoaded) {
  // Without the extension the whole scenario can't exist — nothing to test.
  console.log('SKIP: sqlite-vec extension not loaded in this environment');
  process.exit(0);
}

const DIM = 4;
ensureVecTable(db, DIM, 'test-model');
check('hasVec after ensureVecTable', db.hasVec === true);

// One file, three embedded chunks.
upsertFile(db, { path: '/x/note.md', source: 'memory', hash: 'h1', mtime: 1, size: 10 });
const mk = (slug: string, text: string) => ({
  file_path: '/x/note.md',
  source: 'memory',
  slug,
  start_line: 0,
  end_line: 1,
  hash: `c-${slug}`,
  model: 'test-model',
  text,
});
const emb = (a: number) => new Float32Array([a, a, a, a]);
replaceFileChunks(
  db,
  '/x/note.md',
  [mk('a', 'A'), mk('b', 'B'), mk('c', 'C')],
  [emb(0.1), emb(0.2), emb(0.3)],
);

const ids = (db.db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[]).map(
  (r) => r.id,
);
check('3 chunks inserted', ids.length === 3, `${ids.length}`);
const vecCount = () => (db.db.prepare('SELECT rowid FROM chunks_vec').all() as unknown[]).length;
check('3 vec rows inserted', vecCount() === 3, `${vecCount()}`);

// Clean DB has no orphans → prune is a no-op.
check('no orphans on a clean DB', pruneOrphanVecRows(db) === 0);

// Orphan two of them: delete the chunk rows directly, WITHOUT cleaning
// chunks_vec — exactly what an FTS-only (no-extension) process does.
db.db.prepare('DELETE FROM chunks WHERE id IN (?, ?)').run(ids[0], ids[1]);
check('2 vec rows now orphaned', vecCount() === 3); // still 3 in vec, 1 in chunks

const pruned = pruneOrphanVecRows(db);
check('prunes exactly the 2 orphans', pruned === 2, `${pruned}`);

const vecAfter = (db.db.prepare('SELECT rowid FROM chunks_vec').all() as { rowid: number }[]).map(
  (r) => Number(r.rowid),
);
check('1 valid vec row kept', vecAfter.length === 1, `${vecAfter.length}`);
check('kept row is the surviving chunk', vecAfter[0] === ids[2], `${vecAfter[0]} vs ${ids[2]}`);

// Idempotent: a second prune removes nothing.
check('second prune is a no-op', pruneOrphanVecRows(db) === 0);

closeMemoryDb(db);
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
