// Tests for image file placement (store.ts).
//
// Run: npx tsx src/imagegen/store.test.mts
//
// The hardlink cases assert on inode identity rather than on content:
// a copy would pass a byte comparison, and the whole point of link(2)
// here is that a second location costs a name, not a second copy.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/types.ts';
import {
  buildFilename,
  extForMime,
  freePath,
  mediaDir,
  linkMedia,
  slugFromPrompt,
  storeMedia,
} from './store.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// A byte-accurate PNG header is all the MIME sniffer looks at.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake image payload'),
]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('fake jpeg payload'),
]);

function configWith(outputDir: string, monthlyFolders = false): Config {
  return {
    imageGen: { enabled: true, outputDir, monthlyFolders, maxImagesPerTurn: 5, timeoutMs: 1000, models: [] },
  } as unknown as Config;
}

// ── slugFromPrompt ──────────────────────────────────────────────────

check('slug: plain words', slugFromPrompt('ein Koala im Weltraum') === 'ein-koala-im-weltraum');
check('slug: umlauts folded', slugFromPrompt('Größe Bär') === 'groesse-baer');
check('slug: sharp s', slugFromPrompt('Straße') === 'strasse');
check(
  'slug: punctuation collapses',
  slugFromPrompt('a!!!  b???c') === 'a-b-c',
  `got '${slugFromPrompt('a!!!  b???c')}'`,
);
check('slug: pure punctuation falls back', slugFromPrompt('!!! ???') === 'bild');
check('slug: empty falls back', slugFromPrompt('') === 'bild');
check('slug: non-latin falls back', slugFromPrompt('日本語のみ') === 'bild');
check('slug: length capped', slugFromPrompt('a'.repeat(200)).length <= 40);
check(
  'slug: no trailing hyphen after cut',
  !slugFromPrompt('abcdefghij klmnopqrst uvwxyzabcd efghijklmn opq').endsWith('-'),
);
check(
  'slug: accents stripped',
  slugFromPrompt('café naïve') === 'cafe-naive',
  `got '${slugFromPrompt('café naïve')}'`,
);

// ── buildFilename ───────────────────────────────────────────────────

const fixedDate = new Date(2026, 7, 26, 14, 30, 12); // local time, Aug is month 7
check(
  'filename: stamp + slug + ext',
  buildFilename('ein Koala im Weltraum', 'png', fixedDate) ===
    '2026-08-26_143012_ein-koala-im-weltraum.png',
  buildFilename('ein Koala im Weltraum', 'png', fixedDate),
);
check(
  'filename: single-digit parts padded',
  buildFilename('x', 'png', new Date(2026, 0, 3, 4, 5, 6)) === '2026-01-03_040506_x.png',
);
check(
  'filename: sorts chronologically as text',
  buildFilename('b', 'png', new Date(2026, 0, 1, 0, 0, 0)) <
    buildFilename('a', 'png', new Date(2026, 0, 1, 0, 0, 1)),
);

// ── extForMime ──────────────────────────────────────────────────────

check('ext: png', extForMime('image/png') === 'png');
check('ext: jpeg → jpg', extForMime('image/jpeg') === 'jpg');
check('ext: webp', extForMime('image/webp') === 'webp');
check('ext: svg', extForMime('image/svg+xml') === 'svg');
check('ext: unknown falls back to declared format', extForMime('application/x-weird', 'webp') === 'webp');
check('ext: unknown with no hint → png', extForMime('application/x-weird') === 'png');

// ── mediaDir ───────────────────────────────────────────────────────

check('dir: plain', mediaDir(configWith('/tmp/img'), 'image') === '/tmp/img');
check(
  'dir: monthly bucket',
  mediaDir(configWith('/tmp/img', true), 'image', fixedDate) === '/tmp/img/2026-08',
);

// ── filesystem cases ────────────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), 'somora-imagegen-'));
const outDir = join(root, 'images');
const config = configWith(outDir);

// freePath: collisions get numbered rather than overwriting.
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'taken.png'), 'x');
const free1 = await freePath(outDir, 'taken.png');
check('freePath: first collision → _2', free1 === join(outDir, 'taken_2.png'), free1);
await writeFile(free1, 'x');
const free2 = await freePath(outDir, 'taken.png');
check('freePath: second collision → _3', free2 === join(outDir, 'taken_3.png'), free2);
check(
  'freePath: untaken name unchanged',
  (await freePath(outDir, 'fresh.png')) === join(outDir, 'fresh.png'),
);

// storeMedia: bytes decide the MIME, not the caller's claim.
const storedPng = await storeMedia({ kind: 'image', bytes: PNG, prompt: 'ein Koala', config, now: fixedDate });
check('store: mime sniffed from bytes', storedPng.mime === 'image/png', storedPng.mime);
check('store: filename from prompt', storedPng.filename === '2026-08-26_143012_ein-koala.png', storedPng.filename);
check('store: byte count reported', storedPng.bytes === PNG.length);
check('store: file actually written', (await readFile(storedPng.path)).equals(PNG));

const storedLie = await storeMedia({
  kind: 'image',
  bytes: JPEG,
  prompt: 'test',
  config,
  declaredMime: 'image/png', // upstream mislabels it
  now: fixedDate,
});
check('store: declared mime does not override sniffed', storedLie.mime === 'image/jpeg', storedLie.mime);
check('store: extension follows sniffed mime', storedLie.filename.endsWith('.jpg'), storedLie.filename);

// Two images from one prompt in the same second must not collide.
const twinA = await storeMedia({ kind: 'image', bytes: PNG, prompt: 'zwilling', config, now: fixedDate });
const twinB = await storeMedia({ kind: 'image', bytes: PNG, prompt: 'zwilling', config, now: fixedDate });
check('store: same-second twins get distinct paths', twinA.path !== twinB.path);
check('store: twin is suffixed', twinB.filename.includes('_2.'), twinB.filename);

// SVG is text, so magic bytes can't see it — the declared type carries.
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const storedSvg = await storeMedia({
  kind: 'image',
  bytes: svg,
  prompt: 'vektor',
  config,
  declaredMime: 'image/svg+xml',
  outputFormat: 'svg',
  now: fixedDate,
});
check('store: svg keeps declared type', storedSvg.mime === 'image/svg+xml', storedSvg.mime);
check('store: svg extension', storedSvg.filename.endsWith('.svg'), storedSvg.filename);

// ── linkMedia ───────────────────────────────────────────────────────

const projectDir = join(root, 'projekt');
const linked = await linkMedia(storedPng.path, projectDir + '/');
check('link: lands in the requested dir', linked.startsWith(projectDir), linked);
check('link: keeps the canonical filename', linked.endsWith(storedPng.filename), linked);

const canonStat = await stat(storedPng.path);
const linkStat = await stat(linked);
check('link: same inode — no second copy', canonStat.ino === linkStat.ino);
check('link: link count is 2', canonStat.nlink >= 2, String(canonStat.nlink));

// A destination naming a file, not a directory.
const explicit = join(root, 'ziel', 'mein-bild.png');
const linked2 = await linkMedia(storedPng.path, explicit);
check('link: explicit target path honored', linked2 === explicit, linked2);
check('link: parent dir created', (await stat(explicit)).ino === canonStat.ino);

// Linking twice into the same place must not clobber.
const linked3 = await linkMedia(storedPng.path, explicit);
check('link: collision suffixed', linked3 !== explicit && linked3.includes('mein-bild_2'), linked3);

// An existing directory (no trailing slash) is still treated as one.
const linked4 = await linkMedia(twinA.path, projectDir);
check('link: existing dir without trailing slash', linked4.startsWith(projectDir + '/'), linked4);

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} store test(s) failed`);
