// Records from before video existed (2026-08-28).
// Run: npx tsx src/media/records-migration.test.mts
//
// Its own file, and its own SOMORA_HOME, because the migration runs
// exactly once per process — on the first record access, which in
// production is server start. A legacy file planted after that first
// access would never be swept, so the fixture has to be in place before
// the module is even imported. Mixing that ordering into the main
// records suite also shifted every count there.
//
// Two properties are asserted, and both matter for yesterday's images:
// the file moves to the new directory, and a record with no `kind` is
// treated as an image rather than as something unknown — otherwise it
// would vanish from every filtered view.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'somora-media-migrate-'));
process.env.SOMORA_HOME = home;

const legacyDir = join(home, 'images');
const mediaDirPath = join(home, 'media');
mkdirSync(legacyDir, { recursive: true });
writeFileSync(
  join(legacyDir, 'legacy00001.json'),
  JSON.stringify({
    id: 'legacy00001',
    createdAt: '2026-08-01T10:00:00.000Z',
    prompt: 'ein alter apfel',
    modelName: 'zimage',
    modelId: 'zimage',
    provider: 'cerebro',
    specs: {},
    path: '/tmp/alt.png',
    filename: 'alt.png',
    mime: 'image/png',
    bytes: 123,
    linkedTo: [],
    batchId: 'b1',
    batchIndex: 0,
  }),
  'utf8',
);
// Not a record — must be left alone rather than swept along.
writeFileSync(join(legacyDir, 'notes.txt'), 'kein record', 'utf8');

const { listRecords, writeRecord } = await import('./records.ts');
const { mediaKind } = await import('./types.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}

const listed = await listRecords({});
const found = listed.items.find((r) => r.id === 'legacy00001');
check('the old record is still found', found !== undefined);
check('a record without `kind` counts as an image', found ? mediaKind(found) === 'image' : false);
check('and it survives the image filter',
  (await listRecords({ kind: 'image' })).items.some((r) => r.id === 'legacy00001'));
check('but never shows up as a video',
  !(await listRecords({ kind: 'video' })).items.some((r) => r.id === 'legacy00001'));
check('the file moved', existsSync(join(mediaDirPath, 'legacy00001.json')));
check('and is gone from the old place', !existsSync(join(legacyDir, 'legacy00001.json')));
check('a non-record file is left where it was', existsSync(join(legacyDir, 'notes.txt')));

// A real video alongside it, so the filter is proven in both directions.
await writeRecord({
  id: 'vid000000001', kind: 'video', createdAt: '2026-08-28T10:00:00.000Z',
  prompt: 'ein drehender apfel', modelName: 'ltx', modelId: 'ltx', provider: 'cerebro',
  specs: {}, path: '/tmp/v.mp4', filename: 'v.mp4', mime: 'video/mp4', bytes: 999,
  durationSec: 5.04, width: 1280, height: 704, linkedTo: [], batchId: 'b2', batchIndex: 0,
});
check('a video lists as a video',
  (await listRecords({ kind: 'video' })).items.some((r) => r.id === 'vid000000001'));
check('and not as an image',
  !(await listRecords({ kind: 'image' })).items.some((r) => r.id === 'vid000000001'));
check('unfiltered returns both', (await listRecords({})).items.length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} migration test(s) failed`);
