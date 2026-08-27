// Content-addressed attachment storage. Every uploaded file lives at
// `~/.somora/attachments/<sha256>.<ext>`. Two uploads of the same
// content collide on hash → one file on disk, refs in JSONL point
// at the same blob. Bytes never enter JSONL.
//
// The storeAttachment function streams the upload into a tmp file
// first (so a 32 MB PDF doesn't sit in RAM as one Buffer), then
// hashes + renames atomically. MIME detection happens via the
// existing magic-bytes sniffer (multimodal/mime.ts) — extensions are
// untrusted (a `screenshot.txt` could be a renamed PNG).

import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  renameSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SOMORA_HOME_DIR } from '../server/logger.ts';
import { detectMimeFromPath, type DetectedMime } from '../multimodal/mime.ts';
import type { AttachmentsConfig } from '../config/types.ts';

export interface StoredAttachment {
  hash: string;
  mime: DetectedMime;
  size: number;
  /** Absolute path under ~/.somora/attachments/. */
  path: string;
  /** Original filename as the client sent it (display only — never
   *  trusted for routing or extension-based decisions). */
  name: string;
}

const ATTACHMENTS_DIR = join(SOMORA_HOME_DIR, 'attachments');
const TMP_DIR = join(ATTACHMENTS_DIR, '.tmp');

function ensureDirs(): void {
  if (!existsSync(ATTACHMENTS_DIR)) mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function extForMime(mime: DetectedMime): string {
  if (mime.mimeType === 'image/png') return 'png';
  if (mime.mimeType === 'image/jpeg') return 'jpg';
  if (mime.mimeType === 'image/gif') return 'gif';
  if (mime.mimeType === 'image/webp') return 'webp';
  if (mime.mimeType === 'application/pdf') return 'pdf';
  if (mime.kind === 'text') return 'txt';
  return 'bin';
}

function capForKind(mime: DetectedMime, config: AttachmentsConfig): number {
  if (mime.kind === 'image') return config.maxImageBytes;
  if (mime.kind === 'pdf') return config.maxPdfBytes;
  if (mime.kind === 'text') return config.maxTextBytes;
  // unknown → reject at caller side; use the smallest cap as a
  // defensive value if we ever reach this branch.
  return Math.min(config.maxImageBytes, config.maxPdfBytes, config.maxTextBytes);
}

/**
 * Write `body` to a temp file, sniff its MIME, validate against caps,
 * hash, and atomically move into the content-addressed pool. Returns
 * the resolved metadata. Idempotent on hash collision: if a file
 * with the same sha256 already exists, the tmp is deleted and the
 * existing file is returned as-is.
 */
export async function storeAttachment(args: {
  body: ReadableStream<Uint8Array> | Readable;
  name: string;
  config: AttachmentsConfig;
}): Promise<StoredAttachment> {
  ensureDirs();
  const tmpPath = join(
    TMP_DIR,
    `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  // Stream the upload into the tmp file. Hash through the same pipe
  // so we don't have to re-read the file afterwards.
  const hasher = createHash('sha256');
  const sink = createWriteStream(tmpPath);
  // Web ReadableStream → node Readable for pipeline compatibility.
  const source =
    args.body instanceof Readable
      ? args.body
      : Readable.fromWeb(
          args.body as unknown as import('node:stream/web').ReadableStream,
        );
  source.on('data', (chunk: Buffer) => hasher.update(chunk));
  try {
    await pipeline(source, sink);
  } catch (err) {
    try {
      rmSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
  const stats = statSync(tmpPath);
  const size = stats.size;

  let mime: DetectedMime;
  try {
    mime = await detectMimeFromPath(tmpPath);
  } catch (err) {
    rmSync(tmpPath);
    throw new Error(`mime sniff failed: ${(err as Error).message}`);
  }
  // An explicit allow-list, not "anything we could identify". The mime
  // sniffer also recognises video and audio so the web FileView can
  // serve them honestly — but no engine can put a video in a prompt,
  // and letting one through here would mean an attachment that vanishes
  // silently while packing the turn.
  const ATTACHABLE: ReadonlyArray<DetectedMime['kind']> = ['image', 'pdf', 'text'];
  if (!ATTACHABLE.includes(mime.kind)) {
    rmSync(tmpPath);
    throw new Error(
      `unsupported file type — supported: image (PNG/JPEG/GIF/WebP), PDF, text. Got: ${mime.mimeType}`,
    );
  }

  const cap = capForKind(mime, args.config);
  if (size > cap) {
    rmSync(tmpPath);
    throw new Error(
      `${mime.kind} '${args.name}' is ${size} bytes, exceeds the ${cap}-byte cap (config.attachments.max${capLabel(mime)})`,
    );
  }

  const hash = hasher.digest('hex');
  const ext = extForMime(mime);
  const finalPath = join(ATTACHMENTS_DIR, `${hash}.${ext}`);

  // Dedup: if the hash already exists on disk, drop the tmp upload
  // and return the existing blob's metadata — saves disk + cache.
  if (existsSync(finalPath)) {
    try {
      rmSync(tmpPath);
    } catch {
      /* ignore */
    }
    return { hash, mime, size, path: finalPath, name: args.name };
  }

  // Atomic move within the same filesystem (tmp + final share parent).
  renameSync(tmpPath, finalPath);
  return { hash, mime, size, path: finalPath, name: args.name };
}

function capLabel(mime: DetectedMime): string {
  if (mime.kind === 'image') return 'ImageBytes';
  if (mime.kind === 'pdf') return 'PdfBytes';
  return 'TextBytes';
}

/**
 * Resolve a known-hash ref back to a usable absolute path + metadata.
 * Used at /chat/send time to translate `attachments[]` refs into
 * something the engines can actually open. Throws if the file is
 * gone (caller decides whether to refuse the turn or degrade).
 */
export async function resolveAttachmentByHash(args: {
  hash: string;
  expectedMime: string;
}): Promise<{ path: string; mime: DetectedMime; size: number }> {
  ensureDirs();
  // We don't know the extension just from the hash, but we do know
  // the mime → ext mapping via the existing detector (re-sniff).
  const candidates = await listCandidatePaths(args.hash);
  for (const p of candidates) {
    if (existsSync(p)) {
      const s = await stat(p);
      const mime = await detectMimeFromPath(p);
      if (mime.mimeType !== args.expectedMime) {
        throw new Error(
          `attachment ${args.hash}: stored mime ${mime.mimeType} does not match claimed ${args.expectedMime}`,
        );
      }
      return { path: p, mime, size: s.size };
    }
  }
  throw new Error(`attachment ${args.hash} not found in ~/.somora/attachments/`);
}

async function listCandidatePaths(hash: string): Promise<string[]> {
  // Try the common extensions; cheap because we only stat-existsSync.
  const exts = ['png', 'jpg', 'gif', 'webp', 'pdf', 'txt', 'bin'];
  return exts.map((e) => join(ATTACHMENTS_DIR, `${hash}.${e}`));
}
