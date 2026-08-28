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

/** What an MP4 states about itself in its header atoms. */
export interface VideoMeta extends Dimensions {
  /** Playing time in seconds, from the movie header. */
  durationSec: number;
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


// ── MP4 / ISO-BMFF ───────────────────────────────────────────────────
//
// A generated video's shape and length are worth recording, and asking
// ffmpeg would mean requiring it on every machine that runs somora. An
// MP4 states both in its header atoms, so this reads them directly:
//
//   moov
//     mvhd   → timescale + duration  (playing time)
//     trak
//       tkhd → width + height as 16.16 fixed point (the DISPLAY size,
//              which is what a player shows and therefore what a person
//              means by "how big is it")
//
// Only the header is walked, never the media data — `mdat` is the whole
// file minus a few kilobytes and is skipped by its own length field.

/** Walk one level of atoms, calling `visit` for each. Returns early if
 *  the visitor says it's done. */
function eachAtom(
  buf: Buffer,
  start: number,
  end: number,
  visit: (type: string, from: number, to: number) => boolean | void,
): void {
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    let head = 8;
    if (size === 1) {
      // 64-bit size, stored after the type. Only the low half is worth
      // reading — a header atom past 4 GB is not a real file.
      if (i + 16 > end) return;
      const hi = buf.readUInt32BE(i + 8);
      if (hi !== 0) return;
      size = buf.readUInt32BE(i + 12);
      head = 16;
    } else if (size === 0) {
      size = end - i; // "to end of file"
    }
    if (size < head || i + size > end) return;
    if (visit(type, i + head, i + size) === true) return;
    i += size;
  }
}

function parseMvhd(buf: Buffer, from: number, to: number): number | null {
  if (to - from < 20) return null;
  const version = buf[from]!;
  if (version === 1) {
    if (to - from < 32) return null;
    const timescale = buf.readUInt32BE(from + 20);
    // 64-bit duration; the high word is zero for anything under ~year-long.
    const durationLo = buf.readUInt32BE(from + 28);
    return timescale > 0 ? durationLo / timescale : null;
  }
  const timescale = buf.readUInt32BE(from + 12);
  const duration = buf.readUInt32BE(from + 16);
  return timescale > 0 ? duration / timescale : null;
}

function parseTkhd(buf: Buffer, from: number, to: number): Dimensions | null {
  const version = buf[from]!;
  // Fixed-size preamble differs by version; width/height are the last
  // two 32-bit fields either way.
  const size = to - from;
  const need = version === 1 ? 96 : 84;
  if (size < need) return null;
  const w = buf.readUInt32BE(to - 8) / 65536;
  const h = buf.readUInt32BE(to - 4) / 65536;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { width: Math.round(w), height: Math.round(h) };
}

/**
 * Dimensions and duration of an MP4/MOV, from its header atoms. Null
 * when the buffer isn't ISO-BMFF or the header is incomplete — callers
 * treat that as "don't know", never as zero.
 *
 * A track with no display size (an audio track, or a video track whose
 * tkhd says 0x0) is skipped rather than believed: a file whose reported
 * size is 0x0 would render as a broken preview.
 */
export function readVideoMeta(buf: Buffer): VideoMeta | null {
  if (buf.length < 16 || buf.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  let durationSec: number | null = null;
  let dims: Dimensions | null = null;

  eachAtom(buf, 0, buf.length, (type, from, to) => {
    if (type !== 'moov') return;
    eachAtom(buf, from, to, (t2, f2, e2) => {
      if (t2 === 'mvhd') durationSec = parseMvhd(buf, f2, e2);
      if (t2 === 'trak' && !dims) {
        eachAtom(buf, f2, e2, (t3, f3, e3) => {
          if (t3 === 'tkhd') {
            const d = parseTkhd(buf, f3, e3);
            if (d) dims = d;
          }
        });
      }
    });
    return true; // moov is all we need
  });

  if (!dims) return null;
  const d = dims as Dimensions;
  return { width: d.width, height: d.height, durationSec: durationSec ?? 0 };
}
