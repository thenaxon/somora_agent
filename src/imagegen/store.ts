// File placement for generated images.
//
// Every image lands in ONE canonical directory (`imageGen.outputDir`),
// no matter which agent produced it — that's what the gallery and the
// /images/:id/file route index. A caller-chosen destination is an
// additional NAME for the same bytes, created with link(2): two paths,
// one inode, no second copy. Across filesystems link(2) fails with
// EXDEV and we fall back to a real copy, which is the only case where
// disk usage doubles.
//
// Deleting either name leaves the other intact — that's a property of
// hardlinks, and the desirable one here: cleaning up a project folder
// must not blank the gallery, and vice versa.

import { constants } from 'node:fs';
import { copyFile, link, mkdir, access, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Config } from '../config/types.ts';
import { detectMimeFromBuffer } from '../multimodal/mime.ts';
import { expandHome } from '../tools/file/policy.ts';
import { logger } from '../server/logger.ts';

/** Fallback when the operator left `imageGen` out entirely. */
const DEFAULT_OUTPUT_DIR = '~/somoraworkspace/images';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/** Canonical images directory, ~ expanded, month bucket applied. */
export function imagesDir(config: Config, now = new Date()): string {
  const cfg = config.imageGen;
  const base = expandHome(cfg?.outputDir ?? DEFAULT_OUTPUT_DIR);
  if (!cfg?.monthlyFolders) return base;
  const bucket = `${now.getFullYear()}-${two(now.getMonth() + 1)}`;
  return join(base, bucket);
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Prompt → filename fragment. Latin-1 diacritics are folded rather than
 * dropped so a German prompt stays readable ("größe" → "groesse", not
 * "gre"). Everything else collapses to single hyphens.
 */
export function slugFromPrompt(prompt: string, maxLen = 40): string {
  const folded = prompt
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const slug = folded
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  // A prompt of pure punctuation or non-Latin script leaves nothing
  // usable — the timestamp still makes the name unique.
  return slug || 'bild';
}

/** `2026-08-26_143012_koala-im-weltraum.png` — sorts chronologically in
 *  any file browser and stays recognizable without opening it. */
export function buildFilename(prompt: string, ext: string, now = new Date()): string {
  const stamp =
    `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}` +
    `_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${stamp}_${slugFromPrompt(prompt)}.${ext}`;
}

export function extForMime(mime: string, fallbackFormat?: string): string {
  return EXT_BY_MIME[mime] ?? fallbackFormat ?? 'png';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * First free variant of `<dir>/<name>`: `foo.png`, then `foo_2.png`, …
 * Two images generated within the same second from the same prompt
 * (n > 1) would otherwise overwrite each other.
 */
export async function freePath(dir: string, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = join(dir, filename);
  let n = 2;
  while (await exists(candidate)) {
    candidate = join(dir, `${stem}_${n}${ext}`);
    n++;
    // Pathological only if something else is writing the same names in
    // a loop; bail out rather than spin.
    if (n > 999) throw new Error(`no free filename for '${filename}' in ${dir}`);
  }
  return candidate;
}

export interface StoredImage {
  path: string;
  filename: string;
  mime: string;
  bytes: number;
}

/**
 * Write image bytes into the canonical directory. MIME comes from the
 * bytes themselves, not from what the upstream claimed — a provider
 * that mislabels its output would otherwise leave us with a `.png` that
 * no viewer opens.
 */
export async function storeImage(args: {
  bytes: Buffer;
  prompt: string;
  config: Config;
  declaredMime?: string;
  outputFormat?: string;
  now?: Date;
}): Promise<StoredImage> {
  const now = args.now ?? new Date();
  const detected = detectMimeFromBuffer(args.bytes);
  // SVG is text, so magic-byte detection can't see it; trust the
  // declared type in that one case.
  const mime =
    detected.kind === 'image'
      ? detected.mimeType
      : (args.declaredMime ?? (args.outputFormat === 'svg' ? 'image/svg+xml' : 'image/png'));
  const dir = imagesDir(args.config, now);
  await mkdir(dir, { recursive: true });
  const filename = buildFilename(args.prompt, extForMime(mime, args.outputFormat), now);
  const path = await freePath(dir, filename);
  await writeFile(path, args.bytes);
  return { path, filename: path.slice(dir.length + 1), mime, bytes: args.bytes.length };
}

/**
 * Give the stored image a second name at `dest`. A destination ending
 * in `/`, or naming an existing directory, keeps the canonical
 * filename; anything else is treated as the full target path.
 *
 * Returns the path actually created.
 */
export async function linkImage(canonicalPath: string, dest: string): Promise<string> {
  const expanded = expandHome(dest);
  const looksLikeDir = expanded.endsWith('/') || (await isDir(expanded));
  const target = looksLikeDir
    ? join(resolve(expanded), canonicalPath.slice(canonicalPath.lastIndexOf('/') + 1))
    : resolve(expanded);

  await mkdir(dirname(target), { recursive: true });
  const finalTarget = await freePath(dirname(target), target.slice(target.lastIndexOf('/') + 1));

  try {
    await link(canonicalPath, finalTarget);
    return finalTarget;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EXDEV: different filesystem — the one case where a real copy is
    // unavoidable. EPERM: some filesystems (exFAT, many network mounts)
    // reject hardlinks outright.
    if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      logger.debug({ msg: 'imagegen.link_fallback_copy', code, target: finalTarget });
      await copyFile(canonicalPath, finalTarget);
      return finalTarget;
    }
    throw err;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
