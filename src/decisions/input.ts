// What a decision request may contain, checked the same way for every
// caller: the decision_evaluate tool, POST /decisions/evaluate and
// Sentinel. The questions schema and the image limits live here; reading
// files (the tool) or decoding base64 (the route) stays with the caller.

import { z } from 'zod';
import { detectMimeFromBuffer } from '../multimodal/mime.ts';
import { readDimensions } from '../multimodal/dimensions.ts';
import { fitImageForModel } from '../multimodal/model-image.ts';
import type { DecisionRequest } from './client.ts';

export const MAX_IMAGES = 4;
/** Clef's published limits for embedded images (Workers AI model page). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Text, a JSON object or array, or null — what a state or a criterion may be. */
export const DecisionEntry = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()]);

export const DecisionQuestionSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('boolean'), instructions: DecisionEntry.optional(), criteria: z.object({ true: DecisionEntry.optional(), false: DecisionEntry.optional() }).strict().nullable().optional() })
    .strict()
    // The question id is not read by the model: without instructions or
    // true/false criteria it would answer a question that has no text.
    .refine((q) => (q.instructions !== undefined && q.instructions !== null && q.instructions !== '') || (q.criteria != null && (q.criteria.true != null || q.criteria.false != null)), 'a boolean question needs instructions or criteria.true/false — the question id is not read'),
  z.object({ type: z.literal('choice'), instructions: DecisionEntry.optional(), criteria: z.record(z.string(), DecisionEntry).refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 255, 'choice needs 2–255 alternatives') }).strict(),
  z.object({ type: z.literal('score'), instructions: DecisionEntry.optional(), criteria: z.array(DecisionEntry).min(2).max(10) }).strict(),
]);

export const DecisionQuestionsSchema = z
  .record(z.string(), DecisionQuestionSchema)
  .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 256, '1–256 questions');

/**
 * Check and scale images the way a chat attachment is scaled for a model
 * (`maxEdge`, attachments.maxImageEdge). `label` names each image in an
 * error ("images: <label> …"). Returns the images or the first problem.
 */
export async function prepareDecisionImages(
  items: Array<{ label: string; bytes: Buffer }>,
  maxEdge: number,
): Promise<NonNullable<DecisionRequest['images']> | string> {
  const out: NonNullable<DecisionRequest['images']> = [];
  let total = 0;
  for (const { label, bytes } of items) {
    const mime = detectMimeFromBuffer(bytes).mimeType;
    if (!IMAGE_MIMES.has(mime)) return `images: ${label} is ${mime || 'not an image'} — PNG, JPEG or WebP only`;
    const fitted = await fitImageForModel(bytes, mime, maxEdge);
    const dims = readDimensions(fitted.bytes);
    if (!dims) return `images: could not read the size of ${label}`;
    if (dims.width * dims.height > MAX_IMAGE_PIXELS) return `images: ${label} has ${dims.width}×${dims.height} pixels, more than 16 megapixels`;
    if (fitted.bytes.length > MAX_IMAGE_BYTES) return `images: ${label} is ${Math.round(fitted.bytes.length / 1024)} KB after scaling, more than 4 MB`;
    total += fitted.bytes.length;
    if (total > MAX_IMAGES_BYTES) return 'images: together more than 8 MB after scaling — send fewer';
    out.push({ base64: fitted.bytes.toString('base64'), width: dims.width, height: dims.height, mime: fitted.mimeType });
  }
  return out;
}
