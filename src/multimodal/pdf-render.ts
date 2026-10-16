// PDF → page images. Used by file_read polymorph for PDF
// inputs because the MCP tool-result content union (text/image/audio/
// resource) has no `document` type — claude-agent-sdk and codex-cli
// can only forward `image` content blocks from MCP to the model. So
// we rasterize each page server-side and ship them as image-array.
//
// Token cost reality check: Anthropic charges ~1300 tokens per
// 1024×1024 image. A 10-page PDF rendered at 1.5× scale ≈ 13k tokens
// just for the visuals. Operators with cost concerns should prefer
// `analyze_file` (worker dispatcher, returns text description) for
// large PDFs.
//
// Implementation uses `pdf-to-img` (pure JS via pdfjs-dist) so we
// avoid system-package deps like poppler. Trade-off: pdfjs's render
// quality is good but text-only pages won't have a separate text
// layer — Claude's native PDF support gives the model both image AND
// embedded text; this fallback only delivers the image side.

import { pdf } from 'pdf-to-img';
import { logger } from '../server/logger.ts';

/** Pages go out as JPEG: a rendered page is text on a plain ground,
 *  which JPEG at this quality keeps sharp at a third to a fifth of the
 *  PNG's bytes (measured 2026-10-16: 120–400 KB PNG → 40–90 KB JPEG per
 *  page). Every page rides along in every later request of a Codex
 *  thread, so the bytes count — a 20-page scan as PNG made the Codex
 *  backend drop its websocket on each turn (feedback 2026-09-14). */
const PAGE_JPEG_QUALITY = 85;
export const PDF_PAGE_MEDIA_TYPE = 'image/jpeg';

async function toJpeg(png: Buffer): Promise<Buffer> {
  try {
    const { default: sharp } = await import('sharp');
    return await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: PAGE_JPEG_QUALITY, mozjpeg: true }).toBuffer();
  } catch {
    return png;
  }
}

export interface RenderOptions {
  /** Hard cap on pages rendered. Default 20. PDFs longer than this
   *  get the first N pages plus a marker note in the caller. */
  maxPages?: number;
  /** Render scale. 1.0 = native PDF page size; 1.5 = 150% (default,
   *  good balance of legibility vs token cost); 2.0 = retina-grade. */
  scale?: number;
}

export interface RenderResult {
  /** Base64-encoded page images, one per page, in document order. */
  pages: string[];
  /** Their type: `image/jpeg`, or `image/png` if converting failed. */
  mediaType: string;
  /** Total pages in the source PDF. */
  totalPages: number;
  /** Whether the render hit the maxPages cap. */
  truncated: boolean;
  /** Time elapsed in ms. */
  ms: number;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_SCALE = 1.5;

export async function renderPdfPages(
  pdfPath: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const scale = options.scale ?? DEFAULT_SCALE;
  const start = Date.now();

  let document;
  try {
    document = await pdf(pdfPath, { scale });
  } catch (err) {
    throw new Error(
      `pdf-render: failed to open '${pdfPath}': ${(err as Error).message}`,
    );
  }
  const totalPages = document.length;
  const pages: string[] = [];
  let mediaType = PDF_PAGE_MEDIA_TYPE;
  let pageIdx = 0;
  for await (const buf of document) {
    if (pageIdx >= maxPages) break;
    const jpeg = await toJpeg(buf);
    if (jpeg === buf) mediaType = 'image/png';
    pages.push((mediaType === 'image/png' ? buf : jpeg).toString('base64'));
    pageIdx++;
  }
  const truncated = totalPages > maxPages;
  const ms = Date.now() - start;
  logger.info({
    msg: 'pdf-render.complete',
    path: pdfPath,
    rendered: pages.length,
    total: totalPages,
    truncated,
    ms,
  });
  return { pages, mediaType, totalPages, truncated, ms };
}
