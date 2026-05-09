// File loading for multimodal pipelines. Enforces per-modality size
// caps before reading the full file into memory — a 500 MB PDF should
// never blow up the server. Stat the file first, reject early if too
// big, then read.
//
// Caps are picked to match what the upstream APIs accept:
//   - Anthropic image: 5 MB per image (their hard limit)
//   - Anthropic PDF: 32 MB / 100 pages (their hard limit)
//   - OpenAI image: 20 MB
//   - OpenAI PDF: via file API, much higher but rare in practice
// We use the smaller of each so a config that targets either provider
// works. Operators can tune per their primary provider.

import { readFile, stat } from 'node:fs/promises';
import { detectMimeFromPath, type DetectedMime } from './mime.ts';

export interface LoadedAttachment {
  /** Absolute path that was read (caller-provided). */
  path: string;
  /** Buffer of the entire file contents. */
  bytes: Buffer;
  /** MIME detection result (kind + full mime string). */
  mime: DetectedMime;
  /** Size of the loaded buffer in bytes. */
  size: number;
}

export interface LoadOptions {
  /** Max bytes for image files. Default 5 MB (Anthropic ceiling). */
  maxImageBytes?: number;
  /** Max bytes for PDF files. Default 32 MB (Anthropic ceiling). */
  maxPdfBytes?: number;
  /** Max bytes for text files (so file_read does not OOM on a 1 GB log).
   *  Default 1 MB; use file_read's existing line/offset paging for bigger. */
  maxTextBytes?: number;
}

const DEFAULT_MAX_IMAGE = 5 * 1024 * 1024;
const DEFAULT_MAX_PDF = 32 * 1024 * 1024;
const DEFAULT_MAX_TEXT = 1 * 1024 * 1024;

export async function loadAttachment(
  path: string,
  options: LoadOptions = {},
): Promise<LoadedAttachment> {
  const maxImage = options.maxImageBytes ?? DEFAULT_MAX_IMAGE;
  const maxPdf = options.maxPdfBytes ?? DEFAULT_MAX_PDF;
  const maxText = options.maxTextBytes ?? DEFAULT_MAX_TEXT;

  const s = await stat(path);
  if (!s.isFile()) {
    throw new Error(`multimodal: '${path}' is not a regular file`);
  }
  // Cheap pre-check before we even sniff bytes — if the file is bigger
  // than the largest cap we'd ever apply, reject without reading.
  const absoluteMax = Math.max(maxImage, maxPdf, maxText);
  if (s.size > absoluteMax) {
    throw new Error(
      `multimodal: '${path}' is ${s.size} bytes, exceeds the largest configured cap (${absoluteMax})`,
    );
  }

  const mime = await detectMimeFromPath(path);

  // Per-kind size enforcement. We DO this before the full read so a
  // mid-sized text file (5 MB) doesn't pass image validation just
  // because the absolute-max ceiling is bigger.
  if (mime.kind === 'image' && s.size > maxImage) {
    throw new Error(
      `multimodal: image '${path}' is ${s.size} bytes, exceeds image cap ${maxImage}`,
    );
  }
  if (mime.kind === 'pdf' && s.size > maxPdf) {
    throw new Error(`multimodal: pdf '${path}' is ${s.size} bytes, exceeds pdf cap ${maxPdf}`);
  }
  if (mime.kind === 'text' && s.size > maxText) {
    throw new Error(
      `multimodal: text '${path}' is ${s.size} bytes, exceeds text cap ${maxText} — use file_read with offset/limit pagination instead`,
    );
  }

  const bytes = await readFile(path);
  return { path, bytes, mime, size: bytes.length };
}
