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
import type { ModelCapability } from '../config/types.ts';
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

/** Size for the not-shown markers. Rounded — this is orientation for a
 *  language model, not an accounting figure. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Stand-in for an attachment the active model cannot be shown. Names
 * the file, its type and its size so the model can talk about what it
 * is missing ("the screenshot you sent earlier") instead of behaving as
 * though the turn never had an attachment at all.
 *
 * English on purpose — every model-facing and user-facing string in
 * somora is.
 */
function notShownMarker(a: ResolvedAttachment, kind: 'image' | 'pdf'): string {
  const needed = kind === 'image' ? "'image'" : "'pdf' or 'image'";
  const what = kind === 'image' ? 'Image' : 'PDF';
  return (
    `[${what} attachment "${a.name}" (${a.mime.mimeType}, ${humanSize(a.size)}) ` +
    `— not shown: the active model has no ${needed} capability. ` +
    `It can be described with analyze_file({path:"${a.path}"}).]`
  );
}

/**
 * openai-compatible. PDF behaviour depends on the provider config:
 *   - 'native': PDF → file content block (Anthropic via OpenRouter,
 *     OpenAI direct accept this). Single block per PDF.
 *   - 'rasterize' (default): PDF → page-PNGs via pdf-to-img → one
 *     image_url per page. Works against omlx, ollama, anything
 *     image-capable.
 * Text attachments inline via a header text part.
 *
 * `caps` are the ACTIVE model's capabilities. Attachments it cannot
 * process degrade to a text marker rather than being sent and
 * rejected — see the note in the image branch.
 */
export async function buildOpenAiUserContent(
  text: string,
  attachments: ResolvedAttachment[],
  pdfMode: 'native' | 'rasterize',
  caps: readonly ModelCapability[],
): Promise<string | OpenAiContentPart[]> {
  if (attachments.length === 0) return text;
  const parts: OpenAiContentPart[] = [];
  const canSeeImages = caps.includes('image');
  const canReadPdf = caps.includes('pdf');
  for (const a of attachments) {
    if (a.mime.kind === 'image') {
      // Capability-aware: a model without vision must not be handed an
      // image_url block. run-turn refuses a NEW image attachment for
      // such a model, but history is replayed on every turn — once a
      // session has gone multimodal, every later turn re-sends those
      // blocks and a text-only model 400s on all of them. Degrade to a
      // marker so the session stays usable instead: the model is told
      // what was there and that it cannot see it.
      if (!canSeeImages) {
        parts.push({ type: 'text', text: notShownMarker(a, 'image') });
        continue;
      }
      const bytes = readFileSync(a.path);
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${a.mime.mimeType};base64,${bytes.toString('base64')}`,
        },
      });
    } else if (a.mime.kind === 'pdf') {
      // A PDF rides either as a native document block (needs 'pdf') or
      // as rasterised page-PNGs (needs 'image'). Neither ⇒ marker.
      if (!canReadPdf && !canSeeImages) {
        parts.push({ type: 'text', text: notShownMarker(a, 'pdf') });
        continue;
      }
      // `native` on a model that has 'image' but not 'pdf' would send a
      // file block the backend rejects for the same reason as above.
      // Rasterise instead of failing — the pages are readable either way.
      if (pdfMode === 'native' && canReadPdf) {
        const bytes = readFileSync(a.path);
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
      const bytes = readFileSync(a.path);
      parts.push({
        type: 'text',
        text: `[Attached ${a.name}]\n\n${bytes.toString('utf8')}\n[/Attached]`,
      });
    }
  }
  parts.push({ type: 'text', text });
  // Everything degraded to text ⇒ hand back a plain string. A text-only
  // backend then sees exactly the message shape it saw before the
  // session ever went multimodal, rather than a content array it may
  // handle differently (some local servers are picky about those).
  if (parts.every((p) => p.type === 'text')) {
    return parts.map((p) => (p as { text: string }).text).join('\n\n');
  }
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
