// Magic-bytes MIME detection for multimodal file handling. We do NOT
// trust file extensions — a `screenshot.txt` could be a renamed PNG.
// Size of header read is bounded so we don't pull a multi-GB file into
// memory just to look at the first 16 bytes.
//
// Supported types: PNG, JPEG, GIF, WebP, PDF, plain text. Anything
// else returns `application/octet-stream` and the caller decides how
// to refuse.

import { open } from 'node:fs/promises';

export type DetectedKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'unknown';

export interface DetectedMime {
  /** Coarse-grained category for tool routing decisions. */
  kind: DetectedKind;
  /** Full MIME type string (e.g., `image/png`, `application/pdf`). */
  mimeType: string;
}

const MAX_HEADER_BYTES = 16;

function matchHeader(buf: Buffer, sig: number[]): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

/** Detect MIME from the first 16 bytes of a file. */
export async function detectMimeFromPath(path: string): Promise<DetectedMime> {
  const fd = await open(path, 'r');
  try {
    const buf = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await fd.read(buf, 0, MAX_HEADER_BYTES, 0);
    return detectMimeFromBuffer(buf.subarray(0, bytesRead));
  } finally {
    await fd.close();
  }
}

/** Detect MIME from an in-memory buffer's first bytes. Pure / sync. */
export function detectMimeFromBuffer(buf: Buffer): DetectedMime {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (matchHeader(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mimeType: 'image/png' };
  }
  // JPEG: FF D8 FF
  if (matchHeader(buf, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mimeType: 'image/jpeg' };
  }
  // GIF: 47 49 46 38 ("GIF8") — both 87a and 89a variants start this way
  if (matchHeader(buf, [0x47, 0x49, 0x46, 0x38])) {
    return { kind: 'image', mimeType: 'image/gif' };
  }
  // WebP: "RIFF" (4) + 4 size bytes + "WEBP"
  if (
    buf.length >= 12 &&
    matchHeader(buf, [0x52, 0x49, 0x46, 0x46]) &&
    matchHeader(buf.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { kind: 'image', mimeType: 'image/webp' };
  }
  // PDF: "%PDF"
  if (matchHeader(buf, [0x25, 0x50, 0x44, 0x46])) {
    return { kind: 'pdf', mimeType: 'application/pdf' };
  }
  // ── Media. Recognised so the web FileView can serve them with an
  // honest Content-Type; NOT accepted as chat attachments — see the
  // explicit allow-list in src/attachments/store.ts. Detection is by
  // signature like everything else here: an extension is a claim, not
  // evidence.
  //
  // ISO-BMFF (MP4/M4V/MOV): "ftyp" at offset 4, brand at offset 8.
  if (buf.length >= 12 && matchHeader(buf.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand.startsWith('qt')) return { kind: 'video', mimeType: 'video/quicktime' };
    if (brand.startsWith('M4A')) return { kind: 'audio', mimeType: 'audio/mp4' };
    return { kind: 'video', mimeType: 'video/mp4' };
  }
  // Matroska / WebM: EBML header 1A 45 DF A3. Both containers share it,
  // and the docType that separates them sits further in — WebM is the
  // one browsers play, so claim it and let the browser sort out a
  // genuine .mkv.
  if (matchHeader(buf, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: 'video', mimeType: 'video/webm' };
  }
  // WAVE: "RIFF" + 4 size bytes + "WAVE" (same family as WebP above,
  // which is why that check has to come first).
  if (
    buf.length >= 12 &&
    matchHeader(buf, [0x52, 0x49, 0x46, 0x46]) &&
    matchHeader(buf.subarray(8), [0x57, 0x41, 0x56, 0x45])
  ) {
    return { kind: 'audio', mimeType: 'audio/wav' };
  }
  // Ogg: "OggS"
  if (matchHeader(buf, [0x4f, 0x67, 0x67, 0x53])) {
    return { kind: 'audio', mimeType: 'audio/ogg' };
  }
  // FLAC: "fLaC"
  if (matchHeader(buf, [0x66, 0x4c, 0x61, 0x43])) {
    return { kind: 'audio', mimeType: 'audio/flac' };
  }
  // MP3: an ID3 tag, or a bare MPEG audio frame sync (FF Ex/Fx).
  if (matchHeader(buf, [0x49, 0x44, 0x33])) {
    return { kind: 'audio', mimeType: 'audio/mpeg' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && ((buf[1] as number) & 0xe0) === 0xe0) {
    return { kind: 'audio', mimeType: 'audio/mpeg' };
  }
  // Anything that's printable ASCII / common UTF-8 -> treat as text.
  // Heuristic: scan first 512 bytes, if >95% are printable / whitespace,
  // call it text. Avoid surprises on binaries we don't have signatures
  // for (those become 'unknown' and the caller errors out with hint).
  if (buf.length > 0 && looksLikeText(buf)) {
    return { kind: 'text', mimeType: 'text/plain' };
  }
  return { kind: 'unknown', mimeType: 'application/octet-stream' };
}

function looksLikeText(buf: Buffer): boolean {
  let printable = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    // Tab, LF, CR, or printable ASCII range, or any high-bit byte
    // (common UTF-8 multi-byte continuation). Excludes pure NUL and
    // control codes that wouldn't appear in real text.
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b < 0x7f) || b >= 0x80) {
      printable++;
    }
  }
  return printable / buf.length >= 0.95;
}
