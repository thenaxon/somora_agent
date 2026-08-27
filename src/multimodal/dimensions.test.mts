// Header-only dimension reading (2026-08-27).
// Run: npx tsx src/multimodal/dimensions.test.mts
//
// This exists so somora can notice when an endpoint hands back an image
// of a different size than was asked for — a cap, a rounding, a model
// that only does squares. Those all answer HTTP 200, so the only way to
// see them from outside is to measure the bytes.
//
// Getting a dimension WRONG would be worse than not reading it: a false
// mismatch would tell the caller its perfectly good image is wrong. So
// every format is asserted against a hand-built header, and anything
// unparseable must come back null rather than a guess.

import { Buffer } from 'node:buffer';
import { readDimensions, parseSizeSpec } from './dimensions.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}
function dim(name: string, buf: Buffer, w: number, h: number): void {
  const d = readDimensions(buf);
  check(name, d?.width === w && d?.height === h, `got ${JSON.stringify(d)}, want ${w}x${h}`);
}

// ── PNG ────────────────────────────────────────────────────────────
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b, 0);
  Buffer.from('IHDR').copy(b, 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
dim('png square', png(1024, 1024), 1024, 1024);
dim('png portrait', png(1024, 1792), 1024, 1792);
dim('png landscape', png(1792, 1024), 1792, 1024);
dim('png odd size', png(1216, 832), 1216, 832);

// ── the real 1x1 PNG used elsewhere in the suite ───────────────────
dim(
  'png fixture 1x1',
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
  1, 1,
);

// ── GIF ────────────────────────────────────────────────────────────
{
  const b = Buffer.alloc(20);
  Buffer.from('GIF89a').copy(b, 0);
  b.writeUInt16LE(640, 6);
  b.writeUInt16LE(480, 8);
  dim('gif', b, 640, 480);
}

// ── JPEG: the marker chain has to be walked ────────────────────────
function jpeg(w: number, h: number, withExif = false): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (withExif) {
    // A fat APP1 the scanner must step OVER to reach the frame header.
    const payload = Buffer.alloc(120, 0x20);
    const seg = Buffer.alloc(4 + payload.length);
    seg.writeUInt8(0xff, 0); seg.writeUInt8(0xe1, 1);
    seg.writeUInt16BE(payload.length + 2, 2);
    payload.copy(seg, 4);
    parts.push(seg);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0); sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(9, 2);       // length
  sof.writeUInt8(8, 4);          // precision
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.alloc(16));
  return Buffer.concat(parts);
}
dim('jpeg plain', jpeg(1792, 1024), 1792, 1024);
dim('jpeg behind an APP1 segment', jpeg(800, 600, true), 800, 600);
dim('jpeg progressive marker (SOF2)', (() => {
  const b = jpeg(320, 240);
  b.writeUInt8(0xc2, 3); // SOF0 → SOF2
  return b;
})(), 320, 240);

// ── WebP, all three container flavours ─────────────────────────────
function riff(fourcc: string, rest: Buffer): Buffer {
  const b = Buffer.alloc(12 + rest.length);
  Buffer.from('RIFF').copy(b, 0);
  Buffer.from('WEBP').copy(b, 8);
  Buffer.from(fourcc).copy(b, 12);
  rest.copy(b, 12);
  return b;
}
{
  const rest = Buffer.alloc(24);
  Buffer.from('VP8 ').copy(rest, 0);
  rest.writeUInt16LE(1024, 14);  // offset 26 overall
  rest.writeUInt16LE(768, 16);   // offset 28 overall
  dim('webp lossy (VP8 )', riff('VP8 ', rest), 1024, 768);
}
{
  const rest = Buffer.alloc(20);
  Buffer.from('VP8L').copy(rest, 0);
  // 14 bits width-1, then 14 bits height-1, at overall offset 21.
  rest.writeUInt32LE(((300 - 1) << 14) | (200 - 1), 9);
  dim('webp lossless (VP8L)', riff('VP8L', rest), 200, 300);
}
{
  const rest = Buffer.alloc(24);
  Buffer.from('VP8X').copy(rest, 0);
  const w = 1500 - 1, h = 900 - 1;
  rest[12] = w & 0xff; rest[13] = (w >> 8) & 0xff; rest[14] = (w >> 16) & 0xff;
  rest[15] = h & 0xff; rest[16] = (h >> 8) & 0xff; rest[17] = (h >> 16) & 0xff;
  dim('webp extended (VP8X)', riff('VP8X', rest), 1500, 900);
}

// ── unknown must be null, never a guess ────────────────────────────
check('unknown format → null', readDimensions(Buffer.from('not an image at all')) === null);
check('truncated png → null', readDimensions(png(10, 10).subarray(0, 12)) === null);
check('empty → null', readDimensions(Buffer.alloc(0)) === null);
check('pdf → null', readDimensions(Buffer.from('%PDF-1.4\nrest')) === null);

// ── the size spec side of the comparison ───────────────────────────
check('parse 1024x1024', JSON.stringify(parseSizeSpec('1024x1024')) === '{"width":1024,"height":1024}');
check('parse with spaces', parseSizeSpec(' 1792 x 1024 ')?.width === 1792);
check('parse unicode ×', parseSizeSpec('1024×1792')?.height === 1792);
check('tier name is not a size', parseSizeSpec('2K') === null);
check('undefined is not a size', parseSizeSpec(undefined) === null);
check('garbage is not a size', parseSizeSpec('big please') === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
