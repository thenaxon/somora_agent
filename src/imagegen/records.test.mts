// Tests for the image metadata store (records.ts).
//
// Run: npx tsx src/imagegen/records.test.mts
//
// SOMORA_HOME is redirected to a temp dir BEFORE importing the module —
// the records directory is resolved at import time, so a static import
// would write into the developer's real ~/.somora/images.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'somora-records-'));
process.env.SOMORA_HOME = home;

const { deleteRecord, listRecords, newImageId, readRecord, totalBytes, writeRecord } = await import(
  './records.ts'
);
const recordsDir = join(home, 'images');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

type Rec = Parameters<typeof writeRecord>[0];

function rec(overrides: Partial<Rec> = {}): Rec {
  return {
    id: newImageId(),
    createdAt: '2026-08-26T14:30:12.000Z',
    prompt: 'ein Koala im Weltraum',
    modelName: 'grok-imagine',
    modelId: 'x-ai/grok-imagine-image-2.0',
    provider: 'openrouter',
    specs: { resolution: '2K', aspect_ratio: '16:9' },
    path: '/tmp/x.png',
    filename: 'x.png',
    mime: 'image/png',
    bytes: 1000,
    linkedTo: [],
    batchId: 'batch1',
    batchIndex: 0,
    ...overrides,
  } as Rec;
}

// ── ids ─────────────────────────────────────────────────────────────

check('id: url-safe', /^[a-z0-9]+$/.test(newImageId()));
check('id: stable length', newImageId().length === 12);
check('id: unique across calls', new Set(Array.from({ length: 500 }, newImageId)).size === 500);

// ── round trip ──────────────────────────────────────────────────────

const a = rec({ prompt: 'Koala im Weltraum', bytes: 1500 });
await writeRecord(a);
const readBack = await readRecord(a.id);
check('roundtrip: record found', readBack !== null);
check('roundtrip: prompt preserved', readBack?.prompt === 'Koala im Weltraum');
check('roundtrip: specs preserved', readBack?.specs.aspect_ratio === '16:9');
check('roundtrip: unknown id returns null', (await readRecord(newImageId())) === null);

// Write leaves no .tmp file behind.
const leftovers = (await readdir(recordsDir)).filter((f) => f.endsWith('.tmp'));
check('write: no temp files left behind', leftovers.length === 0, leftovers.join());

// ── id validation guards the path ───────────────────────────────────

check('guard: traversal id rejected', (await readRecord('../../etc/passwd')) === null);
check('guard: slash rejected', (await readRecord('a/b')) === null);
check('guard: dot rejected', (await readRecord('..')) === null);
check('guard: empty rejected', (await readRecord('')) === null);
check('guard: overlong rejected', (await readRecord('x'.repeat(65))) === null);
check('guard: delete refuses traversal', (await deleteRecord('../../x')) === false);

// ── filters ─────────────────────────────────────────────────────────

await writeRecord(
  rec({
    prompt: 'ein roter Panda',
    modelName: 'other-model',
    agent: 'hans',
    createdAt: '2026-08-20T10:00:00.000Z',
    bytes: 500,
  }),
);
await writeRecord(
  rec({
    prompt: 'Koala mit Hut',
    agent: 'naxon',
    session: 'main',
    createdAt: '2026-08-25T10:00:00.000Z',
    bytes: 2000,
  }),
);

const all = await listRecords();
check('list: returns everything by default', all.total === 3, String(all.total));
check(
  'list: newest first',
  all.images[0]?.createdAt === '2026-08-26T14:30:12.000Z',
  all.images[0]?.createdAt,
);

const koalas = await listRecords({ query: 'koala' });
check('filter: case-insensitive prompt substring', koalas.total === 2, String(koalas.total));

check('filter: by model handle', (await listRecords({ model: 'other-model' })).total === 1);
check('filter: by agent', (await listRecords({ agent: 'hans' })).total === 1);
check('filter: by session', (await listRecords({ session: 'main' })).total === 1);
check('filter: since is inclusive of later entries', (await listRecords({ since: '2026-08-25' })).total === 2);
check(
  'filter: until covers the whole day',
  (await listRecords({ until: '2026-08-26' })).total === 3,
  String((await listRecords({ until: '2026-08-26' })).total),
);
check('filter: combined filters intersect', (await listRecords({ query: 'koala', agent: 'naxon' })).total === 1);
check('filter: no match returns empty', (await listRecords({ query: 'nichtsdergleichen' })).total === 0);

// Paging reports the unpaged total, so a UI can show "3 of 12".
const paged = await listRecords({ limit: 2 });
check('paging: limit applied', paged.images.length === 2);
check('paging: total is unpaged', paged.total === 3);
const page2 = await listRecords({ limit: 2, offset: 2 });
check('paging: offset advances', page2.images.length === 1);
check(
  'paging: pages do not overlap',
  page2.images[0]?.id !== paged.images[0]?.id && page2.images[0]?.id !== paged.images[1]?.id,
);

check('size: bytes summed across records', (await totalBytes()) === 4000, String(await totalBytes()));

// ── damaged files ───────────────────────────────────────────────────

await writeFile(join(recordsDir, 'kaputt.json'), '{ not json');
const afterDamage = await listRecords();
check('robust: unparseable record skipped, rest still listed', afterDamage.total === 3, String(afterDamage.total));

await writeFile(join(recordsDir, 'notes.txt'), 'ignore me');
check('robust: non-json files ignored', (await listRecords()).total === 3);

// ── delete ──────────────────────────────────────────────────────────

check('delete: existing record removed', (await deleteRecord(a.id)) === true);
check('delete: gone afterwards', (await readRecord(a.id)) === null);
check('delete: already-gone returns false', (await deleteRecord(a.id)) === false);
check('delete: list shrinks', (await listRecords()).total === 2);

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} records test(s) failed`);
