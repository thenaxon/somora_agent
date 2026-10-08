// decision_evaluate — ask the configured decision model typed questions
// (docs/decisions.md). The wire, limits and error mapping live in
// src/decisions/client.ts; this file adds what only a tool has: the
// agent's file access for images, and the model-facing description.

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { activeDecisionModel, type DecisionModel } from '../../config/types.ts';
import { cachedServerInputLimit, evaluateDecision, GUIDANCE, type DecisionOutcome, type DecisionRequest } from '../../decisions/client.ts';
import { detectMimeFromBuffer } from '../../multimodal/mime.ts';
import { readDimensions } from '../../multimodal/dimensions.ts';
import { fitImageForModel } from '../../multimodal/model-image.ts';
import { checkReadAllowed, realpathSafeAncestor, resolveLocalPath } from '../file/policy.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';

const MAX_IMAGES = 4;
/** Clef's published limits for embedded images (Workers AI model page). */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const entry = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()]);

const Question = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boolean'), instructions: entry.optional(), criteria: z.object({ true: entry.optional(), false: entry.optional() }).strict().nullable().optional() }).strict(),
  z.object({ type: z.literal('choice'), instructions: entry.optional(), criteria: z.record(z.string(), entry).refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 255, 'choice needs 2–255 alternatives') }).strict(),
  z.object({ type: z.literal('score'), instructions: entry.optional(), criteria: z.array(entry).min(2).max(10) }).strict(),
]);

const EvaluateInput = z
  .object({
    state: entry,
    questions: z.record(z.string(), Question).refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= 256, '1–256 questions'),
    images: z.array(z.string().min(1)).min(1).max(MAX_IMAGES).optional(),
  })
  .strict();
type EvaluateInputT = z.infer<typeof EvaluateInput>;

const ENTRY_SCHEMA = {
  description: 'Text, a JSON object or array, or null.',
  anyOf: [{ type: 'string' }, { type: 'object' }, { type: 'array' }, { type: 'null' }],
} as const;

function jsonSchema(withImages: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'questions'],
    properties: {
      state: { ...ENTRY_SCHEMA, description: 'Everything the questions are about. Only what you put here is evaluated — no conversation, no files.' },
      questions: {
        type: 'object',
        minProperties: 1,
        description: 'Question id → question. Ids only label the answers; put the whole meaning into instructions and criteria. Questions are independent.',
        additionalProperties: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['type'],
              properties: {
                type: { const: 'boolean' },
                instructions: { ...ENTRY_SCHEMA, description: 'The yes/no question.' },
                criteria: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { true: ENTRY_SCHEMA, false: ENTRY_SCHEMA } }], description: 'Optional: what counts as true and as false.' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'criteria'],
              properties: {
                type: { const: 'choice' },
                instructions: ENTRY_SCHEMA,
                criteria: { type: 'object', minProperties: 2, maxProperties: 255, additionalProperties: ENTRY_SCHEMA, description: 'Competing labels → descriptions (null leaves a label undescribed). Add a "none"/"unclear" label when that outcome matters.' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'criteria'],
              properties: {
                type: { const: 'score' },
                instructions: ENTRY_SCHEMA,
                criteria: { type: 'array', minItems: 2, maxItems: 10, items: ENTRY_SCHEMA, description: 'Ordered levels, lowest first. The answer is a fractional position from 0 to the last index.' },
              },
            },
          ],
        },
      },
      ...(withImages
        ? {
            images: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_IMAGES,
              items: { type: 'string' },
              description: 'Up to 4 image FILE PATHS (PNG, JPEG, WebP), read before the state. The tool reads and scales them itself; for a chat attachment use the original path from its [Image attachment …] line.',
            },
          }
        : {}),
    },
  };
}

function description(model: DecisionModel | null): string {
  const limit = model ? (model.maxInputTokens ?? cachedServerInputLimit(model)) : null;
  const images = model?.capabilities.includes('image') ?? false;
  return (
    'Ask the configured decision model typed questions about state you supply. It returns probabilities, not prose: ' +
    'boolean → probabilityTrue (0–1, a probability, not a verdict); choice → the chosen label with the full distribution and confidence; ' +
    'score → a fractional position from 0 to max on your ordered levels (2.7 of max 3 is near the top level). ' +
    'Use it to classify, route, triage or check a condition — above all for many similar items, or when you want a number to compare against a threshold. ' +
    'It sees ONLY what you send: no conversation, no files' + (images ? ' except the images you name' : '') + '. ' +
    'Questions are independent and answered in one pass; one that depends on another\'s answer needs a second call. ' +
    'Confidence is the model\'s estimate, not proven accuracy, and a result never authorises an action by itself. ' +
    `Send only the part of a long text the questions need: the limit is ${limit ? `${limit} tokens` : 'the server\'s token limit'}` +
    (images ? ', images included (about 3 000 tokens each)' : '') +
    ', and long inputs take seconds and queue. ' +
    (images ? 'Images: give file paths in `images`; the tool scales them like any image shown to a model. ' : 'This decision model reads text only. ') +
    'When the result is "unavailable", follow its guidance — a failure is not a "no".'
  );
}

/** Read, check and scale the named images the way a chat attachment is
 *  scaled for a model (attachments.maxImageEdge). */
async function loadImages(paths: string[], ctx: ToolContext): Promise<NonNullable<DecisionRequest['images']> | string> {
  const out: NonNullable<DecisionRequest['images']> = [];
  let total = 0;
  for (const p of paths) {
    const { absolute } = await resolveLocalPath(p, ctx.agent, ctx.config, ctx.session);
    for (const candidate of [absolute, await realpathSafeAncestor(absolute)]) {
      const verdict = checkReadAllowed(candidate);
      if (!verdict.ok) return `images: ${p}: ${verdict.reason}`;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (err) {
      return `images: could not read ${p}: ${(err as Error).message}`;
    }
    const mime = detectMimeFromBuffer(bytes).mimeType;
    if (!IMAGE_MIMES.has(mime)) return `images: ${p} is ${mime || 'not an image'} — PNG, JPEG or WebP only`;
    const fitted = await fitImageForModel(bytes, mime, ctx.config.attachments?.maxImageEdge ?? 2048);
    const dims = readDimensions(fitted.bytes);
    if (!dims) return `images: could not read the size of ${p}`;
    if (dims.width * dims.height > MAX_IMAGE_PIXELS) return `images: ${p} has ${dims.width}×${dims.height} pixels, more than 16 megapixels`;
    if (fitted.bytes.length > MAX_IMAGE_BYTES) return `images: ${p} is ${Math.round(fitted.bytes.length / 1024)} KB after scaling, more than 4 MB`;
    total += fitted.bytes.length;
    if (total > MAX_IMAGES_BYTES) return 'images: together more than 8 MB after scaling — send fewer';
    out.push({ base64: fitted.bytes.toString('base64'), width: dims.width, height: dims.height });
  }
  return out;
}

export const decisionEvaluate: ToolDefinition<EvaluateInputT, DecisionOutcome> = {
  name: 'decision_evaluate',
  description: description(null),
  inputSchema: EvaluateInput,
  jsonSchema: jsonSchema(true),
  toolset: 'decision',
  // The client enforces decisions.models[].timeoutMs (≤ 10 min); the
  // engine race must not cut a long evaluation short before that.
  defaultTimeoutMs: 610_000,
  available: (ctx) => activeDecisionModel(ctx.config) !== null,
  forContext: (ctx) => {
    const model = activeDecisionModel(ctx.config);
    return { description: description(model), jsonSchema: jsonSchema(model?.capabilities.includes('image') ?? false) };
  },
  async handler(input, ctx) {
    const model = activeDecisionModel(ctx.config);
    if (!model) return { status: 'unavailable', reason: 'not-configured', guidance: GUIDANCE['not-configured'] };
    let images: DecisionRequest['images'];
    if (input.images) {
      if (!model.capabilities.includes('image')) return { status: 'unavailable', reason: 'images-unsupported', guidance: GUIDANCE['images-unsupported'] };
      const loaded = await loadImages(input.images, ctx);
      if (typeof loaded === 'string') return { status: 'unavailable', reason: 'unsupported-input', guidance: GUIDANCE['unsupported-input'], detail: loaded };
      images = loaded;
    }
    return evaluateDecision(
      model,
      { state: input.state, questions: input.questions as DecisionRequest['questions'], ...(images ? { images } : {}) },
      { ...(ctx.signal ? { signal: ctx.signal } : {}), logCtx: { agent: ctx.agent, session: ctx.session } },
    );
  },
};

export function decisionTools(): ToolDefinition[] {
  return [decisionEvaluate as ToolDefinition];
}
