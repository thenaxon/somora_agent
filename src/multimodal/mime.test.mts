// Magic-byte detection (2026-08-27, extended for media).
// Run: npx tsx src/multimodal/mime.test.mts
//
// Detection order is load-bearing here, and two pairs are easy to get
// wrong because they share a prefix:
//   - WebP and WAVE are both RIFF containers; only bytes 8..12 differ.
//   - A bare MP3 frame sync is 0xFF 0xEx/0xFx, and JPEG starts 0xFF D8 —
//     which passes a careless mask test.
// Both are asserted below, in both directions.
//
// The media kinds exist so the web FileView can serve a file with an
// honest Content-Type. They are deliberately NOT attachable in chat;
// that allow-list lives in src/attachments/store.ts and is asserted
// there, not guessed at from `kind !== 'unknown'`.

import { Buffer } from 'node:buffer';
import { detectMimeFromBuffer } from './mime.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}
const pad = (head: number[], n = 40): Buffer =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(n)]);
const riff = (tag: string): Buffer =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from(tag), Buffer.alloc(24)]);
const isoBmff = (brand: string): Buffer =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(24)]);

function one(name: string, buf: Buffer, kind: string, mimeType: string): void {
  const d = detectMimeFromBuffer(buf);
  check(`${name} → ${kind}`, d.kind === kind, `got ${d.kind}`);
  check(`${name} → ${mimeType}`, d.mimeType === mimeType, `got ${d.mimeType}`);
}

// ── the kinds that already existed ────────────────────────────────
one('png', pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image', 'image/png');
one('jpeg', pad([0xff, 0xd8, 0xff, 0xe0]), 'image', 'image/jpeg');
one('gif', pad([0x47, 0x49, 0x46, 0x38]), 'image', 'image/gif');
one('webp', riff('WEBP'), 'image', 'image/webp');
one('pdf', pad([0x25, 0x50, 0x44, 0x46]), 'pdf', 'application/pdf');
one('plain text', Buffer.from('just some notes\n'), 'text', 'text/plain');

// ── media ─────────────────────────────────────────────────────────
one('mp4', isoBmff('isom'), 'video', 'video/mp4');
one('quicktime', isoBmff('qt  '), 'video', 'video/quicktime');
one('m4a', isoBmff('M4A '), 'audio', 'audio/mp4');
one('webm/matroska', pad([0x1a, 0x45, 0xdf, 0xa3]), 'video', 'video/webm');
one('wav', riff('WAVE'), 'audio', 'audio/wav');
one('ogg', pad([0x4f, 0x67, 0x67, 0x53]), 'audio', 'audio/ogg');
one('flac', pad([0x66, 0x4c, 0x61, 0x43]), 'audio', 'audio/flac');
one('mp3 with id3', pad([0x49, 0x44, 0x33, 0x03]), 'audio', 'audio/mpeg');
one('mp3 bare frame sync', pad([0xff, 0xfb, 0x90, 0x00]), 'audio', 'audio/mpeg');

// ── the two collisions, asserted from both sides ──────────────────
check('RIFF/WEBP is not mistaken for audio', detectMimeFromBuffer(riff('WEBP')).kind === 'image');
check('RIFF/WAVE is not mistaken for an image', detectMimeFromBuffer(riff('WAVE')).kind === 'audio');
check(
  'jpeg is not swallowed by the mp3 frame-sync mask',
  detectMimeFromBuffer(pad([0xff, 0xd8, 0xff, 0xe0])).mimeType === 'image/jpeg',
);
check(
  'a bare mp3 sync is still audio',
  detectMimeFromBuffer(pad([0xff, 0xf3, 0x48, 0x00])).kind === 'audio',
);

// ── nothing recognised stays unknown ──────────────────────────────
{
  const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xde, 0xad, 0xbe, 0xef]);
  const d = detectMimeFromBuffer(junk);
  check('unrecognised binary stays unknown', d.kind === 'unknown', d.kind);
  check('unknown reports octet-stream', d.mimeType === 'application/octet-stream');
}
check('empty buffer is unknown', detectMimeFromBuffer(Buffer.alloc(0)).kind === 'unknown');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
