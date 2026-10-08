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

function originalDimensions(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    const d = readDimensions(buf.subarray(0, n));
    return d ? `${d.width}×${d.height}` : null;
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
