// Shared index: seeding a shared DB from an agent DB, and searching
// agent DB (memory only) + shared DB (vault/wiki) as ONE candidate pool.
// Pure storage + retrieval, fake 4-dim vectors — no embedder, no server.
//
// The equivalence test is the contract the split must keep: for a
// query, [agentDb∖memory + sharedDb] must rank exactly like the old
// single DB that held everything, because the fusion runs over the
// union of candidates either way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureVecTable, openMemoryDb, replaceFileChunks, upsertFile, type MemoryDb } from './storage.ts';
import { hybridSearch } from './retrieval.ts';
import { copyVaultWikiRows, pickSeedDonor } from './shared-index.ts';

const DIM = 4;
const MODEL = 'test-model';
const dir = mkdtempSync(join(tmpdir(), 'somora-shared-index-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

type Doc = { path: string; source: 'memory' | 'vault' | 'wiki'; slug: string; text: string; vec: number[] };
const DOCS: Doc[] = [
  { path: '/mem/a.md', source: 'memory', slug: 'a', text: 'pool terrasse sommer memory note', vec: [1, 0, 0, 0] },
  { path: '/mem/b.md', source: 'memory', slug: 'b', text: 'knx licht wohnzimmer', vec: [0, 1, 0, 0] },
  { path: '/vault/somora/p.md', source: 'wiki', slug: 'orte/pool', text: 'pool terrasse villa wiki seite', vec: [0.9, 0.1, 0, 0] },
  { path: '/vault/somora/k.md', source: 'wiki', slug: 'wissen/knx', text: 'knx rgb device wiki', vec: [0, 0.9, 0.1, 0] },
  { path: '/vault/notes/n.md', source: 'vault', slug: 'notes--n', text: 'vault notiz garten pool', vec: [0.5, 0, 0.5, 0] },
];

function fill(db: MemoryDb, docs: Doc[]): void {
  for (const d of docs) {
    db.db.transaction(() => {
      upsertFile(db, { path: d.path, source: d.source, hash: 'h' + d.slug, mtime: 1, size: d.text.length });
      replaceFileChunks(
        db,
        d.path,
        [{ file_path: d.path, source: d.source, slug: d.slug, start_line: 1, end_line: 2, hash: 'h' + d.slug, model: MODEL, text: d.text }],
        [Float32Array.from(d.vec)],
      );
    })();
  }
}

function open(name: string): MemoryDb {
  const db = openMemoryDb(join(dir, name));
  ensureVecTable(db, DIM, MODEL);
  return db;
}

test('copyVaultWikiRows copies vault/wiki files, chunks, FTS and vectors — not memory', () => {
  const agentsDir = join(dir, 'agents');
  const donor = openMemoryDb(join(agentsDir, 'lisa', 'memory.db'));
  ensureVecTable(donor, DIM, MODEL);
  fill(donor, DOCS);
  donor.db.close();

  const shared = open('shared.db');
  const r = copyVaultWikiRows(shared, join(agentsDir, 'lisa', 'memory.db'));
  assert.deepEqual(r, { files: 3, chunks: 3, vectors: 3 });
  const sources = shared.db.prepare(`SELECT DISTINCT source FROM chunks ORDER BY source`).all().map((x: any) => x.source);
  assert.deepEqual(sources, ['vault', 'wiki']);
  // FTS followed via the insert trigger
  const fts = shared.db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'wiki'`).get() as { n: number };
  assert.equal(fts.n, 2);
  // vectors are queryable
  const near = shared.db
    .prepare(`SELECT rowid FROM chunks_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1`)
    .get(Float32Array.from([1, 0, 0, 0])) as { rowid: number | bigint };
  const slug = shared.db.prepare(`SELECT slug FROM chunks WHERE id = ?`).get(Number(near.rowid)) as { slug: string };
  assert.equal(slug.slug, 'orte/pool');
  // a second copy must refuse — the target is no longer empty
  assert.throws(() => copyVaultWikiRows(shared, join(agentsDir, 'lisa', 'memory.db')), /already holds/);
  // the sequence continues past the copied ids
  const seq = shared.db.prepare(`SELECT seq FROM sqlite_sequence WHERE name='chunks'`).get() as { seq: number };
  assert.ok(seq.seq >= 3);
  shared.db.close();
});

test('pickSeedDonor prefers the agent DB with most vault/wiki files and a matching model', async () => {
  const agentsDir = join(dir, 'agents2');
  const small = openMemoryDb(join(agentsDir, 'small', 'memory.db'));
  ensureVecTable(small, DIM, MODEL);
  fill(small, DOCS.slice(0, 3)); // 1 wiki file
  small.db.close();
  const big = openMemoryDb(join(agentsDir, 'big', 'memory.db'));
  ensureVecTable(big, DIM, MODEL);
  fill(big, DOCS); // 3 vault/wiki files
  big.db.close();
  const other = openMemoryDb(join(agentsDir, 'othermodel', 'memory.db'));
  ensureVecTable(other, 8, 'other-model');
  other.db.close();
  const memOnly = openMemoryDb(join(agentsDir, 'memonly', 'memory.db'));
  ensureVecTable(memOnly, DIM, MODEL);
  fill(memOnly, DOCS.slice(0, 2));
  memOnly.db.close();

  const best = await pickSeedDonor(agentsDir, MODEL, DIM);
  assert.equal(best?.agent, 'big');
  assert.equal(best?.files, 3);
  assert.equal(await pickSeedDonor(agentsDir, 'unknown-model', 16), null);
  assert.equal(await pickSeedDonor(join(dir, 'nope'), MODEL, DIM), null);
});

test('search over [agent∖memory, shared] ranks like the old single DB (order; scores exact when vector-only)', () => {
  const single = open('single.db');
  fill(single, DOCS);
  const agent = open('agent.db');
  fill(agent, DOCS); // an agent DB from before the split: memory AND vault/wiki rows
  const shared = open('shared2.db');
  copyVaultWikiRows(shared, join(dir, 'agent.db'));

  const cfg = {
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    maxResults: 5,
    minScore: 0,
    sourceBoosts: { wiki: 1.4, memory: 0.85, vault: 0.65 },
  };
  for (const [q, vec] of [
    ['pool terrasse', [1, 0, 0, 0]],
    ['knx', [0, 1, 0, 0]],
    ['garten', [0.5, 0, 0.5, 0]],
  ] as const) {
    const before = hybridSearch(single, q, Float32Array.from(vec), cfg);
    const after = hybridSearch(
      [{ memDb: agent, sources: ['memory'] }, { memDb: shared, sources: ['vault', 'wiki'] }],
      q,
      Float32Array.from(vec),
      cfg,
    );
    // Same candidate set. The ORDER between a memory hit and a wiki hit
    // may differ when BM25 decides: BM25 is corpus-relative, and the
    // agent DB (memory rows) and shared DB (vault/wiki) now have their
    // own term statistics — the documented deviation of the split
    // (private/shared-index-design.md §3), measured on real data before
    // the switch; rank-normalisation is the fallback if it matters.
    const key = (h: { slug: string; source: string }) => `${h.source}/${h.slug}`;
    assert.deepEqual([...after.map(key)].sort(), [...before.map(key)].sort(), `query '${q}'`);
    // Vector-only fusion is corpus-independent: scores must be identical.
    const vecCfg = { ...cfg, bm25Weight: 0 };
    const exact = (h: { slug: string; source: string; score: number }) => `${h.source}/${h.slug}@${h.score.toFixed(6)}`;
    assert.deepEqual(
      hybridSearch(
        [{ memDb: agent, sources: ['memory'] }, { memDb: shared, sources: ['vault', 'wiki'] }],
        q,
        Float32Array.from(vec),
        vecCfg,
      ).map(exact),
      hybridSearch(single, q, Float32Array.from(vec), vecCfg).map(exact),
      `vector-only query '${q}'`,
    );
  }
  // the agent DB's own wiki rows must NOT leak in: only memory from it
  const only = hybridSearch([{ memDb: agent, sources: ['memory'] }], 'pool', Float32Array.from([1, 0, 0, 0]), cfg);
  assert.ok(only.every((h) => h.source === 'memory'));
  assert.ok(only.length > 0);
  // and a global sourceFilter still applies across both DBs
  const wikiOnly = hybridSearch(
    [{ memDb: agent, sources: ['memory'] }, { memDb: shared, sources: ['vault', 'wiki'] }],
    'pool',
    Float32Array.from([1, 0, 0, 0]),
    { ...cfg, sourceFilter: ['wiki'] },
  );
  assert.ok(wikiOnly.length > 0 && wikiOnly.every((h) => h.source === 'wiki'));
  single.db.close(); agent.db.close(); shared.db.close();
});

test('slugMatchBoost lifts the page whose slug names the query term above pages that merely mention it', () => {
  const db = open('slugboost.db');
  fill(db, [
    { path: '/vault/somora/w.md', source: 'wiki', slug: 'personen/walter-siegl', text: 'walter ist der vater von rene und wohnt in klosterneuburg', vec: [0.7, 0.7, 0, 0] },
    { path: '/vault/somora/f.md', source: 'wiki', slug: 'personen/familie-siegl', text: 'walter walter walter walter ist teil der familie mit rene', vec: [0.7, 0.7, 0, 0] },
  ]);
  const cfg = { vectorWeight: 0.7, bm25Weight: 0.3, maxResults: 5, minScore: 0, queryTerms: ['walter'] };
  const off = hybridSearch(db, 'wer ist walter', Float32Array.from([0.7, 0.7, 0, 0]), { ...cfg, slugMatchBoost: 1 });
  assert.equal(off[0]!.slug, 'personen/familie-siegl', 'without the boost BM25 prefers the page that repeats the name');
  const on = hybridSearch(db, 'wer ist walter', Float32Array.from([0.7, 0.7, 0, 0]), { ...cfg, slugMatchBoost: 1.5 });
  assert.equal(on[0]!.slug, 'personen/walter-siegl');
  db.db.close();
});
