// Ranking rules on top of the fusion (2026-10-01, report
// 2026-09-30_memory-search-projektseite-rankt-unter-logs): the monthly
// change log is a pointer, not the answer; a page that matches in several
// sections beats one dense chunk elsewhere; a page whose whole name is
// in the query is the page the question means.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contentTerms, hybridSearch } from './retrieval.ts';
import { ensureVecTable, openMemoryDb, replaceFileChunks, upsertFile, type MemoryDb } from './storage.ts';

const dir = mkdtempSync(join(tmpdir(), 'somora-ranking-test-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const MODEL = 'test-model';

type Row = { path: string; source: string; slug: string; text: string; vec: number[]; line?: number };
function open(name: string): MemoryDb {
  const db = openMemoryDb(join(dir, name));
  ensureVecTable(db, 4, MODEL);
  return db;
}
/** Several rows with the same path become several chunks of one file. */
function fill(db: MemoryDb, rows: Row[]): void {
  const byPath = new Map<string, Row[]>();
  for (const r of rows) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  for (const [path, list] of byPath) {
    db.db.transaction(() => {
      const first = list[0]!;
      upsertFile(db, { path, source: first.source, hash: 'h' + first.slug, mtime: 1, size: 1 });
      replaceFileChunks(
        db,
        path,
        list.map((r, i) => ({ file_path: path, source: r.source, slug: r.slug, start_line: r.line ?? 1 + i * 10, end_line: (r.line ?? 1 + i * 10) + 1, hash: `h${r.slug}${i}`, model: MODEL, text: r.text })),
        list.map((r) => Float32Array.from(r.vec)),
      );
    })();
  }
}
/** Two unrelated pages: the min-max normalisation needs more than the
 *  two contenders, or the weaker contender is pinned to zero. */
const FILLERS: Row[] = [
  { path: '/w/f1.md', source: 'wiki', slug: 'wissen/filler-eins', text: 'ganz anderes thema über gärten und pflanzen', vec: [0, 1, 0, 0] },
  { path: '/w/f2.md', source: 'wiki', slug: 'wissen/filler-zwei', text: 'noch ein thema, setup von irgendwas anderem', vec: [0.3, 0.3, 0.3, 0] },
];
const base = { vectorWeight: 0.7, bm25Weight: 0.3, maxResults: 10, minScore: 0, slugMatchBoost: 1.5 };
const q = (text: string) => ({ queryTerms: contentTerms(text) });

test('logDemotion: the change log drops below the page it points at — unless the question is about the chronicle', () => {
  const db = open('log.db');
  fill(db, [
    { path: '/w/logs/2026-09.md', source: 'wiki', slug: 'logs/2026-09', text: 'projekte/enovom-website übernommen aus hans/enovom-website-docker-public-setup; docker-public enovom website setup', vec: [1, 0, 0, 0] },
    { path: '/w/projekte/enovom-website.md', source: 'wiki', slug: 'projekte/enovom-website', text: 'die webseite enovom.com läuft auf dem host docker-public in der dmz, setup durch hans', vec: [0.9, 0.1, 0, 0] },
    ...FILLERS,
  ]);
  const query = 'enovom website docker-public setup';
  const off = hybridSearch(db, query, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(query), logDemotion: 1 });
  assert.equal(off[0]!.slug, 'logs/2026-09', 'without the demotion the dense log line wins');
  const on = hybridSearch(db, query, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(query), logDemotion: 0.5 });
  assert.equal(on[0]!.slug, 'projekte/enovom-website');
  assert.ok(on[1]!.score < on[0]!.score);
  // "what changed in september" is about the log itself: no demotion
  for (const chron of ['was hat sich im september im wiki geändert', 'wann wurde enovom-website promoted', 'änderungen 2026-09']) {
    const hits = hybridSearch(db, chron, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(chron), logDemotion: 0.5 });
    const log = hits.find((h) => h.slug === 'logs/2026-09')!;
    const noDemotion = hybridSearch(db, chron, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(chron), logDemotion: 1 }).find((h) => h.slug === 'logs/2026-09')!;
    assert.equal(log.score.toFixed(6), noDemotion.score.toFixed(6), `no demotion for: ${chron}`);
  }
  db.db.close();
});

test('pageSupport: a page matching in several sections beats a single dense chunk elsewhere', () => {
  const db = open('support.db');
  fill(db, [
    { path: '/w/a.md', source: 'wiki', slug: 'infrastruktur/hosts/docker-public', text: 'enovom setup docker-public dmz cloudflare', vec: [1, 0, 0, 0] },
    { path: '/w/p.md', source: 'wiki', slug: 'projekte/enovom-site', text: 'dns und cloudflare zone für enovom', vec: [0.85, 0.15, 0, 0], line: 10 },
    { path: '/w/p.md', source: 'wiki', slug: 'projekte/enovom-site', text: 'auslieferung auf docker-public, zip einspielen', vec: [0.85, 0.15, 0, 0], line: 30 },
    { path: '/w/p.md', source: 'wiki', slug: 'projekte/enovom-site', text: 'zeitleiste: setup 2026-09-28 live', vec: [0.85, 0.15, 0, 0], line: 50 },
    ...FILLERS,
  ]);
  const query = 'enovom setup docker-public cloudflare';
  const off = hybridSearch(db, query, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(query), slugMatchBoost: 1, pageSupport: 0 });
  assert.equal(off[0]!.slug, 'infrastruktur/hosts/docker-public');
  const on = hybridSearch(db, query, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(query), slugMatchBoost: 1, pageSupport: 0.5 });
  assert.equal(on[0]!.slug, 'projekte/enovom-site');
  // only the page's best chunk carries the support; the others keep their score
  const others = on.filter((h) => h.slug === 'projekte/enovom-site').slice(1);
  assert.ok(others.every((h) => h.score < on[0]!.score));
  // weak chunks (below half of the page's best) give no support
  const db2 = open('support2.db');
  fill(db2, [
    { path: '/w/a.md', source: 'wiki', slug: 'x/exact', text: 'enovom setup docker-public cloudflare', vec: [1, 0, 0, 0] },
    { path: '/w/p.md', source: 'wiki', slug: 'y/broad', text: 'enovom', vec: [0.6, 0.8, 0, 0], line: 10 },
    { path: '/w/p.md', source: 'wiki', slug: 'y/broad', text: 'cloudflare', vec: [0.2, 0.9, 0, 0], line: 30 },
    { path: '/w/p.md', source: 'wiki', slug: 'y/broad', text: 'docker', vec: [0.1, 0.9, 0, 0], line: 50 },
    ...FILLERS,
  ]);
  const hits = hybridSearch(db2, query, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(query), slugMatchBoost: 1, pageSupport: 0.5 });
  assert.equal(hits[0]!.slug, 'x/exact', 'many weak sections do not outgrow one exact page');
  db.db.close(); db2.db.close();
});

test('slugFullNameBoost: the page whose whole name is in the query beats a page sharing only some words', () => {
  const db = open('fullname.db');
  fill(db, [
    { path: '/w/h.md', source: 'wiki', slug: 'infrastruktur/hosts/docker-public-dmz-vm', text: 'enovom website läuft hier; docker-public setup', vec: [1, 0, 0, 0] },
    { path: '/w/p.md', source: 'wiki', slug: 'projekte/enovom-website', text: 'die enovom website auf docker-public, setup durch hans', vec: [0.97, 0.03, 0, 0] },
    { path: '/w/e.md', source: 'wiki', slug: 'unternehmen/enovom', text: 'enovom website docker-public setup firma', vec: [1, 0, 0, 0] },
    ...FILLERS,
  ]);
  const query = 'enovom website docker-public setup';
  const flat = hybridSearch(db, query, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(query), slugFullNameBoost: 1 });
  assert.notEqual(flat[0]!.slug, 'projekte/enovom-website', 'with the flat boost alone every name match counts the same');
  const full = hybridSearch(db, query, Float32Array.from([1, 0, 0, 0]), { ...base, ...q(query), slugFullNameBoost: 1.5 });
  assert.equal(full[0]!.slug, 'projekte/enovom-website');
  // a one-word name ("enovom") gets no extra — its score is unchanged
  const one = (hits: typeof full) => hits.find((h) => h.slug === 'unternehmen/enovom')!.score.toFixed(6);
  assert.equal(one(full), one(flat));
  db.db.close();
});
