// Pixel dimensions straight from the bytes, without decoding the image.
//
// Needed because "what was asked for" and "what came back" are not the
// same question. An endpoint that silently substitutes a size — a cap,
// a rounding to a supported step, a model that only does squares —
// answers HTTP 200 and hands over a perfectly good image of the wrong
// shape. The only way to notice from the outside is to look.
//
// Deliberately header-only: the formats below all state their size in
// the first few dozen bytes, so this stays cheap enough to run on every
// generated image.

import { Buffer } from 'node:buffer';

export interface Dimensions {
  width: number;
  height: number;
}

/** Dimensions for PNG, JPEG, GIF and WebP. Null when the format isn't
 *  one of those or the header is truncated — callers treat that as
 *  "don't know", never as a mismatch. */
export function readDimensions(buf: Buffer): Dimensions | null {
  // PNG: IHDR is always the first chunk, width/height at 16..24.
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF: little-endian 16-bit at 6..10.
  if (buf.length >= 10 && buf.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
      buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return webpDimensions(buf);
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return jpegDimensions(buf);
  }
  return null;
}

/** WebP has three container flavours and they store the size
 *  differently — lossy (VP8), lossless (VP8L) and extended (VP8X). */
function webpDimensions(buf: Buffer): Dimensions | null {
  const fourcc = buf.subarray(12, 16).toString('latin1');
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    // Frame header: 3-byte tag, 3-byte start code, then 14-bit each.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    // 14-bit width then 14-bit height, packed across four bytes.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X' && buf.length >= 30) {
    // Canvas size as two 24-bit little-endian values, minus one.
    const w = buf[24]! | (buf[25]! << 8) | (buf[26]! << 16);
    const h = buf[27]! | (buf[28]! << 8) | (buf[29]! << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

/** JPEG keeps its size in a start-of-frame marker somewhere after the
 *  header, so the segment chain has to be walked to find it. */
function jpegDimensions(buf: Buffer): Dimensions | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1; // resync — padding between segments is legal
      continue;
    }
    const marker = buf[i + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, excluding the two that aren't frame headers.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (len < 2) return null; // malformed; stop rather than loop
    i += 2 + len;
  }
  return null;
}

/** Parse a `WxH` spec. Returns null for anything else — tier names
 *  like "1K" are a different vocabulary and not comparable here. */
export function parseSizeSpec(size: string | undefined): Dimensions | null {
  if (!size) return null;
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}
