import type { DetectedKind } from './mime.ts';
// Content-block construction. Produces engine-agnostic descriptors
// that the various adapters and tools translate to their own SDK
// shapes (Anthropic content blocks, OpenAI tool_result image_url,
// MCP image content, etc.).
//
// We keep this layer plain — it does NOT know about specific SDKs.
// Adapters import from here to get the right base64 + MIME, then
// build their own envelope.

import type { LoadedAttachment } from './load.ts';

export interface ImageBlock {
  type: 'image';
  /** Source variant. `base64` carries the full bytes inline; `url`
   *  references a remote URL (used for web URLs in attachments). */
  source: { kind: 'base64'; mediaType: string; data: string };
}

export interface DocumentBlock {
  type: 'document';
  source: { kind: 'base64'; mediaType: string; data: string };
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = ImageBlock | DocumentBlock | TextBlock;

/** Convert a loaded attachment into its base content block. Caller
 *  decides what to do with text-vs-binary separately if needed (e.g.,
 *  file_read returns text directly without going through this). */
export function attachmentToBlock(att: LoadedAttachment): ContentBlock {
  if (att.mime.kind === 'image') {
    return {
      type: 'image',
      source: {
        kind: 'base64',
        mediaType: att.mime.mimeType,
        data: att.bytes.toString('base64'),
      },
    };
  }
  if (att.mime.kind === 'pdf') {
    return {
      type: 'document',
      source: {
        kind: 'base64',
        mediaType: att.mime.mimeType,
        data: att.bytes.toString('base64'),
      },
    };
  }
  // text
  return { type: 'text', text: att.bytes.toString('utf8') };
}

/** Produce an OpenAI-API-compatible message-content array for a
 *  vision-style chat-completion call (analyze_file). Used by the
 *  worker dispatcher to talk to openai-compatible/openrouter
 *  providers. */
export function toOpenAiContent(att: LoadedAttachment, prompt?: string) {
  const userText = prompt ?? defaultPromptFor(att.mime.kind);
  if (att.mime.kind === 'image') {
    return [
      { type: 'text' as const, text: userText },
      {
        type: 'image_url' as const,
        image_url: {
          url: `data:${att.mime.mimeType};base64,${att.bytes.toString('base64')}`,
        },
      },
    ];
  }
  if (att.mime.kind === 'pdf') {
    // OpenAI-compatible servers vary in how they accept PDFs. The
    // most-supported pattern (openrouter through to Anthropic) is
    // `file` with base64 data URL. omlx/ollama mostly do not support
    // this — caller validates capability before reaching here.
    return [
      { type: 'text' as const, text: userText },
      {
        type: 'file' as const,
        file: {
          file_data: `data:${att.mime.mimeType};base64,${att.bytes.toString('base64')}`,
        },
      },
    ];
  }
  // text or unknown — just include the prompt; caller should usually
  // not reach here for unknown types.
  return [{ type: 'text' as const, text: userText }];
}

function defaultPromptFor(kind: DetectedKind): string {
  if (kind === 'image') return 'Describe this image in detail.';
  if (kind === 'pdf') return 'Summarize this document in detail.';
  return 'Describe the attached content.';
}
