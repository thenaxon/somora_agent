// PDF → PNG-pages rendering. Used by file_read polymorph for PDF
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

export interface RenderOptions {
  /** Hard cap on pages rendered. Default 20. PDFs longer than this
   *  get the first N pages plus a marker note in the caller. */
  maxPages?: number;
  /** Render scale. 1.0 = native PDF page size; 1.5 = 150% (default,
   *  good balance of legibility vs token cost); 2.0 = retina-grade. */
  scale?: number;
}

export interface RenderResult {
  /** Base64-encoded PNG buffers, one per page, in document order. */
  pages: string[];
  /** Total pages in the source PDF. */
  totalPages: number;
  /** Whether the render hit the maxPages cap. */
  truncated: boolean;
  /** Time elapsed in ms. */
  ms: number;
}

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_SCALE = 1.5;

export async function renderPdfToPngs(
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
  let pageIdx = 0;
  for await (const buf of document) {
    if (pageIdx >= maxPages) break;
    pages.push(buf.toString('base64'));
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
  return { pages, totalPages, truncated, ms };
}
