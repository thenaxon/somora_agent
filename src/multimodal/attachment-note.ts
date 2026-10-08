// The line that tells a model where the ORIGINAL of an image attachment is.
//
// A model is shown a scaled-down copy of every image (attachments.maxImageEdge,
// src/attachments/store.ts resolveAttachmentForModel) — right for looking at
// it, wrong for working on it. Without this line an agent could see a picture
// but not hand it on: a local model had no path at all, Claude only a copy of
// its own, and Codex the path of the SCALED copy, which an image model would
// then have used as a low-resolution reference (2026-10-08). Rule: look at the
// scaled copy, edit the original (docs/image-handling.md).

import { closeSync, openSync, readSync } from 'node:fs';
import type { ResolvedAttachment } from '../engine/types.ts';
import { readDimensions } from './dimensions.ts';

/** Enough of the file for the size fields of PNG/GIF/WebP and, in practice,
 *  a JPEG's frame header after its EXIF block. */
const HEADER_BYTES = 512 * 1024;

/** EXIF orientation of a JPEG (1–8), or 1. Phones store the sensor's
 *  landscape pixels and a tag saying how to turn them; 5–8 mean the picture
 *  is shown with width and height swapped. */
export function jpegOrientation(buf: Buffer): number {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('ascii', i + 4, i + 10) === 'Exif\0\0') {
      const t = i + 10;
      const le = buf.toString('ascii', t, t + 2) === 'II';
      const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
      const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      const ifd = t + u32(t + 4);
      const count = u16(ifd);
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > buf.length) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 1;
}

function originalDimensions(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    const head = buf.subarray(0, n);
    const d = readDimensions(head);
    if (!d) return null;
    // As shown: the copy a model sees is turned upright the same way.
    return jpegOrientation(head) >= 5 ? `${d.height}×${d.width}` : `${d.width}×${d.height}`;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** One line per image attachment, naming its original file; '' when none. */
export function imageOriginalNotes(attachments: readonly ResolvedAttachment[]): string {
  const lines = attachments
    .filter((a) => a.mime.kind === 'image')
    .map((a) => {
      const original = a.originalPath ?? a.path;
      const dims = originalDimensions(original);
      return (
        `[Image attachment "${a.name}"${dims ? ` (${dims})` : ''} — original, full resolution: ${original} ` +
        `— what you are shown may be a scaled-down copy. Pass this path to tools that need the image ` +
        `file (for example image_generate reference_images); never pass a ".model-" copy.]`
      );
    });
  return lines.join('\n');
}
