// Reference-image intake (2026-08-27).
// Run: npx tsx src/imagegen/references.test.mts
//
// Guards the boundary where caller-supplied data becomes something we
// put on the wire. Two rules do the work here:
//
//   1. The MIME comes from the BYTES, never the filename. A file named
//      .png that is really a JPEG would otherwise be announced wrongly
//      and fail as a confusing upstream 400 instead of a local error.
//   2. Anything that is not an image an endpoint accepts is rejected
//      HERE, with the filename in the message — not forwarded and left
//      for the provider to complain about in its own words.

import { Buffer } from 'node:buffer';
import { referenceFromBase64, referenceFromBytes } from './references.ts';
import { ImageGenError } from './generate.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}
function throws(name: string, fn: () => unknown, needle: string): void {
  try {
    fn();
    fail++;
    console.error(`FAIL: ${name} (did not throw)`);
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof ImageGenError && msg.includes(needle)) pass++;
    else { fail++; console.error(`FAIL: ${name} — got: ${msg}`); }
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
// JPEG magic bytes are enough for the sniffer.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(32)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(16),
]);

function run(): void {
  // ── the happy paths ──────────────────────────────────────────────
  {
    const r = referenceFromBytes(PNG, '/home/x/somoraworkspace/shot.png');
    check('png: mime detected', r.mime === 'image/png', r.mime);
    check('png: bytes passed through untouched', r.bytes.equals(PNG));
    check('png: filename is just the basename', r.filename === 'shot.png', r.filename);
  }
  {
    const r = referenceFromBytes(JPEG, 'photo.jpeg');
    check('jpeg: mime detected', r.mime === 'image/jpeg', r.mime);
    check('jpeg: extension normalised', r.filename === 'photo.jpg', r.filename);
  }
  check('gif accepted', referenceFromBytes(GIF, 'a.gif').mime === 'image/gif');
  check('webp accepted', referenceFromBytes(WEBP, 'a.webp').mime === 'image/webp');

  // ── the rule that matters: bytes beat the name ───────────────────
  {
    const r = referenceFromBytes(JPEG, 'liar.png');
    check('mislabelled file: mime follows the bytes', r.mime === 'image/jpeg', r.mime);
    check('mislabelled file: extension corrected too', r.filename === 'liar.jpg', r.filename);
  }

  // ── refusals ─────────────────────────────────────────────────────
  throws('empty file rejected', () => referenceFromBytes(Buffer.alloc(0), 'empty.png'), 'is empty');
  throws(
    'text file rejected by name',
    () => referenceFromBytes(Buffer.from('just some notes'), 'notes.txt'),
    'notes.txt',
  );
  throws(
    'pdf rejected with the accepted list',
    () => referenceFromBytes(Buffer.from('%PDF-1.4\n...'), 'spec.pdf'),
    'PNG, JPEG, WebP or GIF',
  );

  // ── base64 entrance (the browser's) ──────────────────────────────
  {
    const bare = referenceFromBase64(PNG.toString('base64'), 0);
    check('base64: bare string works', bare.mime === 'image/png');
    const dataUri = referenceFromBase64(`data:image/png;base64,${PNG.toString('base64')}`, 0);
    check('base64: data-URI prefix stripped', dataUri.mime === 'image/png');
    check('base64: both forms yield the same bytes', bare.bytes.equals(dataUri.bytes));
    check('base64: index used for the part name', bare.filename === 'reference-1.png', bare.filename);
  }
  throws('base64 garbage rejected', () => referenceFromBase64('not base64 at all!!', 2), 'reference-3');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
