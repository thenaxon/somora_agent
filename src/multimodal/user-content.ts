// Build engine-specific user-message content shapes from resolved
// user-attachments. Each engine has its own native shape:
//   - claude-cli (Anthropic SDK): MessageParam.content as
//     ContentBlockParam[] with image / document / text blocks
//   - openai-compatible: chat-completion content parts (text +
//     image_url + file)
//   - codex-cli: --image flag list + text-only stdin (PDFs are
//     rasterised; text attachments are inlined as a header block)
//
// Shared invariant: attachment blocks come BEFORE the text block
// (natural reading order, matches Anthropic's recommendation). The
// text block carries replay-prefix + memory + user-typed text exactly
// like today — Phase Y.B is purely additive on top of that.

import { readFileSync } from 'node:fs';
import { renderPdfToPngs } from './pdf-render.ts';
import type { ResolvedAttachment } from '../engine/types.ts';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { logger } from '../server/logger.ts';

/**
 * claude-cli (Anthropic SDK). PDFs ride as native DocumentBlock —
 * Anthropic supports inline PDF up to 32 MB / 100 pages, and the
 * SDK type system already exposes ImageBlockParam +
 * DocumentBlockParam. Text attachments become a TextBlock with a
 * `[Attached <name>:\n…\n]` header.
 */
export function buildAnthropicUserContent(
  text: string,
  attachments: ResolvedAttachment[],
): string | ContentBlockParam[] {
  if (attachments.length === 0) return text;
  const blocks: ContentBlockParam[] = [];
  for (const a of attachments) {
    const bytes = readFileSync(a.path);
    if (a.mime.kind === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: a.mime.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: bytes.toString('base64'),
        },
      });
    } else if (a.mime.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: bytes.toString('base64'),
        },
      });
    } else if (a.mime.kind === 'text') {
      blocks.push({
        type: 'text',
        text: `[Attached ${a.name}]\n\n${bytes.toString('utf8')}\n[/Attached]`,
      });
    }
  }
  blocks.push({ type: 'text', text });
  return blocks;
}

/** OpenAI chat-completion content-part shape for the `messages` array.
 *  Used by the openai-compatible adapter for both the latest user
 *  turn AND replayed history user messages. */
export type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { file_data: string; filename?: string } };

/**
 * openai-compatible. PDF behaviour depends on the provider config:
 *   - 'native': PDF → file content block (Anthropic via OpenRouter,
 *     OpenAI direct accept this). Single block per PDF.
 *   - 'rasterize' (default): PDF → page-PNGs via pdf-to-img → one
 *     image_url per page. Works against omlx, ollama, anything
 *     image-capable.
 * Text attachments inline via a header text part.
 */
export async function buildOpenAiUserContent(
  text: string,
  attachments: ResolvedAttachment[],
  pdfMode: 'native' | 'rasterize',
): Promise<string | OpenAiContentPart[]> {
  if (attachments.length === 0) return text;
  const parts: OpenAiContentPart[] = [];
  for (const a of attachments) {
    const bytes = readFileSync(a.path);
    if (a.mime.kind === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${a.mime.mimeType};base64,${bytes.toString('base64')}`,
        },
      });
    } else if (a.mime.kind === 'pdf') {
      if (pdfMode === 'native') {
        parts.push({
          type: 'file',
          file: {
            file_data: `data:application/pdf;base64,${bytes.toString('base64')}`,
            filename: a.name,
          },
        });
      } else {
        const result = await renderPdfToPngs(a.path);
        for (const pageBase64 of result.pages) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${pageBase64}`,
            },
          });
        }
      }
    } else if (a.mime.kind === 'text') {
      parts.push({
        type: 'text',
        text: `[Attached ${a.name}]\n\n${bytes.toString('utf8')}\n[/Attached]`,
      });
    }
  }
  parts.push({ type: 'text', text });
  return parts;
}

/**
 * codex-cli. Its `exec --image <PATH>` accepts only image files (PNG/
 * JPEG/GIF/WebP). PDFs get rasterised to per-page PNGs and the page
 * paths feed --image instead. Text attachments inline into the
 * stdin prompt as a `[Attached <name>: …]` block — codex doesn't
 * have a native non-image attachment surface.
 *
 * Returns:
 *   imagePaths  — one absolute path per --image flag the caller pushes
 *   promptPrefix — a text block to prepend to the stdin prompt;
 *                  empty when there are no text attachments
 */
export async function buildCodexAttachments(
  attachments: ResolvedAttachment[],
): Promise<{ imagePaths: string[]; promptPrefix: string }> {
  if (attachments.length === 0) return { imagePaths: [], promptPrefix: '' };
  const imagePaths: string[] = [];
  let promptPrefix = '';
  for (const a of attachments) {
    if (a.mime.kind === 'image') {
      imagePaths.push(a.path);
    } else if (a.mime.kind === 'pdf') {
      // codex's --image accepts only images, so we render the PDF
      // pages out to PNGs first. The temp PNGs live next to the PDF
      // under a content-addressed cache so repeat sends of the same
      // PDF (same hash) reuse the rendered pages.
      try {
        const pages = await renderPdfToPngsToDisk(a);
        for (const p of pages) imagePaths.push(p);
      } catch (err) {
        logger.warn({
          msg: 'attachments.codex.pdf_rasterize_failed',
          name: a.name,
          err: (err as Error).message,
        });
        // Don't kill the turn over a failed rasterise — surface as a
        // text marker so the model knows what was attempted.
        promptPrefix += `[Attached ${a.name} (PDF) — failed to rasterise]\n\n`;
      }
    } else if (a.mime.kind === 'text') {
      const bytes = readFileSync(a.path);
      promptPrefix += `[Attached ${a.name}]\n\n${bytes.toString('utf8')}\n[/Attached]\n\n`;
    }
  }
  return { imagePaths, promptPrefix };
}

/**
 * Render a PDF attachment's pages into PNG files on disk under a
 * content-addressed cache, returning the page paths in order. Used
 * for codex-cli where `--image` needs file paths (not bytes). The
 * cache shares the attachment hash, so repeat turns referencing the
 * same PDF re-use the existing pages without re-rendering.
 */
async function renderPdfToPngsToDisk(a: ResolvedAttachment): Promise<string[]> {
  const { join, dirname } = await import('node:path');
  const { existsSync, mkdirSync, writeFileSync, readdirSync } = await import('node:fs');
  const cacheDir = join(dirname(a.path), `${a.hash}.pdf-pages`);
  if (existsSync(cacheDir)) {
    const files = readdirSync(cacheDir)
      .filter((f) => f.endsWith('.png'))
      .sort();
    if (files.length > 0) return files.map((f) => join(cacheDir, f));
  }
  mkdirSync(cacheDir, { recursive: true });
  const result = await renderPdfToPngs(a.path);
  const out: string[] = [];
  result.pages.forEach((b64, i) => {
    const p = join(cacheDir, `page-${String(i + 1).padStart(4, '0')}.png`);
    writeFileSync(p, Buffer.from(b64, 'base64'));
    out.push(p);
  });
  return out;
}
