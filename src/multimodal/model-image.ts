// Every image that goes to a model passes through here first: a tool
// result (file_read, image_generate's review, an external MCP tool), a
// chat attachment (also the screenshot button), and an attachment
// replayed from the history. Images whose longer side exceeds
// `attachments.maxImageEdge` are scaled down to it.
//
// Why: the large providers scale big images down themselves, so the
// extra pixels buy nothing there, but they still travel with every
// request that carries the history. A session with a dozen 6 MB
// screenshots ended up with Bad Request answers from one provider, and
// local models pay for every pixel in context.
//
// The file on disk is never changed. Text stays readable: a 4K or
// Retina screenshot is scaled by about half, which brings its text to
// the size it has on an ordinary screen.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { readDimensions } from './dimensions.ts';

export const DEFAULT_MAX_IMAGE_EDGE = 2048;
/** With scaling on, the largest source image somora reads or accepts as
 *  an upload. `attachments.maxImageBytes` then applies to what is sent. */
export const IMAGE_SOURCE_BYTES = 50 * 1024 * 1024;

/** The read/upload limit for a source image under this config. */
export function imageSourceCap(att: { maxImageBytes: number; maxImageEdge?: number }): number {
  return (att.maxImageEdge ?? DEFAULT_MAX_IMAGE_EDGE) > 0 ? Math.max(att.maxImageBytes, IMAGE_SOURCE_BYTES) : att.maxImageBytes;
}

export interface FittedImage {
  bytes: Buffer;
  mimeType: string;
  /** True when the image was scaled down. */
  resized: boolean;
  /** Dimensions before and after, when they are known. */
  from?: { width: number; height: number };
  to?: { width: number; height: number };
}

type SharpFactory = (input: Buffer, options?: Record<string, unknown>) => {
  rotate(): ReturnType<SharpFactory>;
  resize(options: Record<string, unknown>): ReturnType<SharpFactory>;
  png(options?: Record<string, unknown>): ReturnType<SharpFactory>;
  jpeg(options?: Record<string, unknown>): ReturnType<SharpFactory>;
  webp(options?: Record<string, unknown>): ReturnType<SharpFactory>;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
};

let sharpPromise: Promise<SharpFactory | null> | undefined;
async function loadSharp(): Promise<SharpFactory | null> {
  sharpPromise ??= import('sharp')
    .then((m) => (m.default ?? m) as unknown as SharpFactory)
    .catch(() => null);
  return sharpPromise;
}

/** Scale an image down so its longer side is at most `maxEdge` pixels.
 *  `maxEdge` 0 (or less) switches it off. An image that already fits,
 *  a format we cannot read, or a missing image library returns the
 *  input unchanged — scaling is an optimisation, never a reason to fail. */
export async function fitImageForModel(bytes: Buffer, mimeType: string, maxEdge: number): Promise<FittedImage> {
  const unchanged: FittedImage = { bytes, mimeType, resized: false };
  if (!(maxEdge > 0)) return unchanged;
  const dims = readDimensions(bytes);
  if (dims && Math.max(dims.width, dims.height) <= maxEdge) return { ...unchanged, from: dims, to: dims };
  const sharp = await loadSharp();
  if (!sharp) return unchanged;
  try {
    // A GIF becomes its first frame as PNG: models read single frames.
    const outMime = mimeType === 'image/jpeg' || mimeType === 'image/webp' ? mimeType : 'image/png';
    let pipeline = sharp(bytes, { animated: false, limitInputPixels: 268_402_689 })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
    pipeline =
      outMime === 'image/jpeg'
        ? pipeline.jpeg({ quality: 88, mozjpeg: true })
        : outMime === 'image/webp'
          ? pipeline.webp({ quality: 88 })
          : pipeline.png({ compressionLevel: 8 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      mimeType: outMime,
      resized: true,
      ...(dims ? { from: dims } : {}),
      to: { width: info.width, height: info.height },
    };
  } catch {
    return unchanged;
  }
}

/** For an image file that is sent by path (chat attachments; Codex takes
 *  file paths): the path of a scaled copy next to it, made once and
 *  reused on every later turn that replays the attachment. Returns the
 *  original path when nothing needs scaling. */
export async function fitImageFileForModel(
  path: string,
  mimeType: string,
  maxEdge: number,
): Promise<{ path: string; mimeType: string; size: number; resized: boolean }> {
  const original = async () => ({ path, mimeType, size: (await stat(path)).size, resized: false });
  if (!(maxEdge > 0)) return original();
  const bytes = await readFile(path);
  const dims = readDimensions(bytes);
  if (dims && Math.max(dims.width, dims.height) <= maxEdge) return original();
  const key = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  const outMime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  const cached = `${path}.model-${maxEdge}-${key}.${ext}`;
  if (existsSync(cached)) return { path: cached, mimeType: outMime, size: (await stat(cached)).size, resized: true };
  const fitted = await fitImageForModel(bytes, mimeType, maxEdge);
  if (!fitted.resized) return original();
  await writeFile(cached, fitted.bytes);
  return { path: cached, mimeType: fitted.mimeType, size: fitted.bytes.length, resized: true };
}
