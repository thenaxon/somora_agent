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
import { readDimensions, parseSizeSpec, readVideoMeta } from './dimensions.ts';

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

// ── MP4 header atoms ───────────────────────────────────────────────
// Length and shape live in nested atoms, and `mdat` — the actual video,
// often the whole file — has to be stepped over by its length field
// rather than scanned. The fixtures below therefore put a fat mdat
// BEFORE moov in one case, which is a real layout (streaming-optimised
// files put moov first, plain encodes put it last).

function atom(type: string, payload: Buffer): Buffer {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}
function mvhd(timescale: number, duration: number, version = 0): Buffer {
  if (version === 1) {
    const p = Buffer.alloc(108);
    p.writeUInt8(1, 0);
    p.writeUInt32BE(timescale, 20);
    p.writeUInt32BE(0, 24);          // duration high word
    p.writeUInt32BE(duration, 28);
    return atom('mvhd', p);
  }
  const p = Buffer.alloc(100);
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return atom('mvhd', p);
}
function tkhd(w: number, h: number, version = 0): Buffer {
  const size = version === 1 ? 96 : 84;
  const p = Buffer.alloc(size);
  p.writeUInt8(version, 0);
  p.writeUInt32BE(Math.round(w * 65536), size - 8);
  p.writeUInt32BE(Math.round(h * 65536), size - 4);
  return atom('tkhd', p);
}
const ftyp = atom('ftyp', Buffer.from('isomiso2avc1'));

function mp4(opts: { w: number; h: number; timescale: number; duration: number;
                     version?: number; mdatFirst?: boolean; extraTrack?: boolean }): Buffer {
  const traks: Buffer[] = [];
  // An audio track has no display size and must not be believed.
  if (opts.extraTrack) traks.push(atom('trak', tkhd(0, 0, opts.version)));
  traks.push(atom('trak', tkhd(opts.w, opts.h, opts.version)));
  const moov = atom('moov', Buffer.concat([mvhd(opts.timescale, opts.duration, opts.version), ...traks]));
  const mdat = atom('mdat', Buffer.alloc(5000, 0x11));
  return Buffer.concat(opts.mdatFirst ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

{
  const m = readVideoMeta(mp4({ w: 1280, h: 704, timescale: 600, duration: 3025 }));
  check('mp4: dimensions', m?.width === 1280 && m?.height === 704, JSON.stringify(m));
  check('mp4: duration', Math.abs((m?.durationSec ?? 0) - 5.0417) < 0.01, String(m?.durationSec));
}
{
  const m = readVideoMeta(mp4({ w: 1920, h: 1080, timescale: 1000, duration: 14400, mdatFirst: true }));
  check('mp4: moov after a fat mdat is still found', m?.width === 1920, JSON.stringify(m));
  check('mp4: 14.4s parsed', Math.abs((m?.durationSec ?? 0) - 14.4) < 0.001, String(m?.durationSec));
}
{
  const m = readVideoMeta(mp4({ w: 768, h: 1344, timescale: 90000, duration: 450000, version: 1 }));
  check('mp4: version-1 atoms', m?.width === 768 && m?.height === 1344, JSON.stringify(m));
  check('mp4: version-1 duration', Math.abs((m?.durationSec ?? 0) - 5) < 0.001, String(m?.durationSec));
}
{
  // The 0x0 track comes FIRST; believing it would report a broken size.
  const m = readVideoMeta(mp4({ w: 640, h: 360, timescale: 600, duration: 600, extraTrack: true }));
  check('mp4: a sizeless track is skipped', m?.width === 640 && m?.height === 360, JSON.stringify(m));
}
check('mp4: a PNG is not an mp4', readVideoMeta(png(10, 10)) === null);
check('mp4: truncated header → null', readVideoMeta(ftyp) === null);
check('mp4: empty → null', readVideoMeta(Buffer.alloc(0)) === null);
// readDimensions is for stills; it must not start guessing at videos.
check('readDimensions leaves mp4 alone',
  readDimensions(mp4({ w: 100, h: 100, timescale: 1, duration: 1 })) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
