// Image tools — text-to-image generation and an index over everything
// generated so far.
//
// Both tools sit on src/imagegen/, the same core the web app's Images
// window calls through POST /images/generate. Nothing model-facing
// lives here beyond argument shaping and the two decisions that are
// genuinely agent-specific: whether the image comes back into the
// agent's context, and whether this turn is still within its budget.

import { z } from 'zod';
import { generateImage, ImageGenError } from '../../imagegen/generate.ts';
import { listRecords } from '../../imagegen/records.ts';
import type { ImageRecord, ImageSpecs } from '../../imagegen/types.ts';
import { loadPersona } from '../../persona/loader.ts';
import { logger } from '../../server/logger.ts';
import { checkWriteAllowed, resolveLocalPath } from '../file/policy.ts';
import type { MultimodalToolResult, ToolContext, ToolDefinition } from '../types.ts';
import { checkImageBudget, recordImagesInTurn } from './budget.ts';

function imageGenEnabled(ctx: ToolContext): boolean {
  return ctx.config.imageGen?.enabled === true && (ctx.config.imageGen?.models.length ?? 0) > 0;
}

const GenerateInput = z
  .object({
    prompt: z.string().min(1).max(4000).describe('What to draw. Passed to the model verbatim.'),
    model: z.string().min(1).optional(),
    aspect_ratio: z.string().min(1).optional(),
    resolution: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    quality: z.string().min(1).optional(),
    output_format: z.string().min(1).optional(),
    background: z.string().min(1).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    seed: z.number().int().optional(),
    n: z.number().int().min(1).max(10).optional(),
    save_to: z.string().min(1).optional(),
    reference_images: z.array(z.string().min(1)).max(16).optional(),
    return_image: z.boolean().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type GenerateArgs = z.infer<typeof GenerateInput>;

interface GeneratedRow {
  id: string;
  path: string;
  filename: string;
  linked_to: string[];
  cost_usd?: number;
}

interface GenerateOutput {
  images: GeneratedRow[];
  model: string;
  specs: ImageSpecs;
  cost_usd?: number;
  /** Non-fatal remarks — a destination that couldn't be linked, the
   *  image withheld because the model can't see images, etc. */
  notes?: string[];
}

function toSpecs(input: GenerateArgs): ImageSpecs {
  const specs: ImageSpecs = {};
  if (input.aspect_ratio !== undefined) specs.aspect_ratio = input.aspect_ratio;
  if (input.resolution !== undefined) specs.resolution = input.resolution;
  if (input.size !== undefined) specs.size = input.size;
  if (input.quality !== undefined) specs.quality = input.quality;
  if (input.output_format !== undefined) specs.output_format = input.output_format;
  if (input.background !== undefined) specs.background = input.background;
  if (input.output_compression !== undefined) specs.output_compression = input.output_compression;
  if (input.seed !== undefined) specs.seed = input.seed;
  if (input.n !== undefined) specs.n = input.n;
  return specs;
}

/** agent.yaml `imageReview: always` makes looking at the result the
 *  default for this agent; an explicit `return_image` on the call still
 *  wins, so a task can opt out of the cost. */
async function wantsImageBack(input: GenerateArgs, ctx: ToolContext): Promise<boolean> {
  if (input.return_image !== undefined) return input.return_image;
  try {
    const persona = await loadPersona(ctx.agent);
    return persona?.imageReview === 'always';
  } catch {
    return false;
  }
}

function modelCanSeeImages(ctx: ToolContext): boolean {
  return ctx.activeModel?.model.capabilities.includes('image') === true;
}

// TOutput left unbound (like file_read): the handler returns either a
// plain payload or a MultimodalToolResult, and the registry
// discriminates on the brand at runtime.
export const imageGenerate: ToolDefinition<GenerateArgs> = {
  name: 'image_generate',
  toolset: 'image',
  description:
    'Generate an image from a text prompt and save it. Returns the file path and metadata, ' +
    'NOT the image itself — set return_image: true if you need to SEE the result (costs ~2k ' +
    'tokens and requires a vision-capable model). The user sees every generated image in ' +
    'their chat automatically, so you do not need to send it to them. ' +
    'Specs are real request fields, not prompt text: pass aspect_ratio ("16:9"), resolution ' +
    '("1K", "2K"), quality, n (how many), output_format, seed. Do NOT write them into the ' +
    'prompt. Allowed values differ per model; an invalid one is rejected with the list of ' +
    'valid ones. Images always land in the configured images directory; save_to additionally ' +
    'places a hardlink where you want it (relative paths resolve against your workspace). ' +
    'reference_images takes base64 images for image-to-image, where the model supports it.',
  inputSchema: GenerateInput,
  jsonSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to draw. Passed to the model verbatim.' },
      model: {
        type: 'string',
        description: 'Configured image-model handle. Omit for the default.',
      },
      aspect_ratio: { type: 'string', description: 'e.g. "1:1", "16:9", "9:16", "4:3".' },
      resolution: { type: 'string', description: 'Tier, e.g. "512", "1K", "2K", "4K".' },
      size: { type: 'string', description: 'Alternative to resolution: explicit "1024x1024".' },
      quality: { type: 'string', description: 'e.g. "auto", "low", "medium", "high".' },
      output_format: { type: 'string', description: '"png", "jpeg", "webp", "svg".' },
      background: { type: 'string', description: '"auto", "transparent", "opaque".' },
      output_compression: { type: 'number', description: '0-100, webp/jpeg only.' },
      seed: { type: 'number', description: 'Repeat a previous result exactly.' },
      n: { type: 'number', description: 'How many images (1-10, model-dependent).' },
      save_to: {
        type: 'string',
        description: 'Extra destination — a directory or a full file path. Hardlinked.',
      },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Base64 images to guide generation (image-to-image).',
      },
      return_image: {
        type: 'boolean',
        description: 'Also return the image so you can look at it. Default false.',
      },
      extra: {
        type: 'object',
        description: 'Provider-specific fields, passed through untouched.',
        additionalProperties: true,
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  // Image models are slow by nature — a 2K render takes tens of seconds
  // and 4K can take minutes. The engine-level 30s default would cancel
  // a request the provider is still billing for.
  defaultTimeoutMs: 300_000,
  available: (ctx) => imageGenEnabled(ctx),
  async handler(input, ctx): Promise<GenerateOutput | MultimodalToolResult> {
    const cfg = ctx.config.imageGen;
    if (!cfg?.enabled) {
      throw new Error(
        'image_generate: image generation is not enabled. Ask the user to set imageGen.enabled and configure a model in config.yaml.',
      );
    }

    const requested = input.n ?? 1;
    const budget = checkImageBudget(ctx.turnId, requested, cfg.maxImagesPerTurn);
    if (!budget.ok) {
      throw new Error(`image_generate: ${budget.reason}`);
    }

    // A caller-chosen destination goes through the same gate as
    // file_write. Without it, "generate an image to ~/.ssh/authorized_keys"
    // would be a way around exactly the rule that gate enforces.
    let saveTo: string | undefined;
    if (input.save_to) {
      const { absolute, warning } = await resolveLocalPath(input.save_to, ctx.agent, ctx.config);
      const verdict = checkWriteAllowed(absolute, ctx.agent);
      if (!verdict.ok) {
        throw new Error(`image_generate: save_to ${verdict.reason}`);
      }
      if (warning) logger.debug({ msg: 'imagegen.save_to_warning', warning });
      // Keep the trailing separator so a directory stays a directory —
      // resolveLocalPath normalizes it away.
      saveTo = /[\\/]$/.test(input.save_to) ? `${absolute}/` : absolute;
    }

    const wantImage = await wantsImageBack(input, ctx);
    const notes: string[] = [];

    // Refuse early rather than after paying for the image: the caller
    // asked to see it and can't, so it should know before deciding to
    // generate at all.
    if (wantImage && input.return_image === true && !modelCanSeeImages(ctx)) {
      const active = ctx.activeModel
        ? `'${ctx.activeModel.providerName}/${ctx.activeModel.modelId}'`
        : '(unknown)';
      throw new Error(
        `image_generate: return_image was requested but the active model ${active} lacks ` +
          `'image' capability. Generate without return_image and inspect the file with ` +
          `analyze_file({path:"..."}), which dispatches to the configured vision worker.`,
      );
    }

    let result;
    try {
      result = await generateImage(
        {
          prompt: input.prompt,
          ...(input.model ? { model: input.model } : {}),
          specs: toSpecs(input),
          ...(saveTo ? { saveTo } : {}),
          ...(input.reference_images ? { references: input.reference_images } : {}),
          ...(input.extra ? { extra: input.extra } : {}),
          agent: ctx.agent,
          ...(ctx.session ? { session: ctx.session } : {}),
        },
        ctx.config,
      );
    } catch (err) {
      // ImageGenError messages are written to be acted on — relay them
      // as-is rather than wrapping them in a generic failure.
      if (err instanceof ImageGenError) throw new Error(`image_generate: ${err.message}`);
      throw err;
    }

    recordImagesInTurn(ctx.turnId, result.images.length);

    if (input.save_to && result.images.some((img) => img.linkedTo.length === 0)) {
      notes.push(
        `Could not place a copy at '${input.save_to}' — the image is saved in the images directory.`,
      );
    }

    const payload: GenerateOutput = {
      images: result.images.map((img) => ({
        id: img.id,
        path: img.path,
        filename: img.filename,
        linked_to: img.linkedTo,
        ...(img.costUsd !== undefined ? { cost_usd: img.costUsd } : {}),
      })),
      model: result.images[0]?.modelId ?? '',
      specs: result.images[0]?.specs ?? {},
      ...(result.costUsd !== undefined ? { cost_usd: result.costUsd } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };

    if (!wantImage) return payload;

    // imageReview: always on a text-only model — generate anyway and say
    // why the image isn't attached, rather than failing a call the agent
    // didn't explicitly ask to see the result of.
    if (!modelCanSeeImages(ctx)) {
      payload.notes = [
        ...(payload.notes ?? []),
        `Image not attached: the active model cannot see images. Use analyze_file({path:"${result.images[0]?.path}"}) to have it described.`,
      ];
      return payload;
    }

    const { readFile } = await import('node:fs/promises');
    const blocks: MultimodalToolResult['contentBlocks'] = [
      { type: 'text', text: JSON.stringify(payload) },
    ];
    for (const img of result.images) {
      try {
        const bytes = await readFile(img.path);
        blocks.push({
          type: 'image',
          source: { kind: 'base64', mediaType: img.mime, data: bytes.toString('base64') },
        });
      } catch (err) {
        logger.warn({ msg: 'imagegen.readback_failed', path: img.path, err: (err as Error).message });
      }
    }
    return { _somoraMultimodal: true, contentBlocks: blocks };
  },
};

const ListInput = z
  .object({
    query: z.string().min(1).max(200).optional(),
    model: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    mine_only: z.boolean().optional(),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

type ListArgs = z.infer<typeof ListInput>;

interface ListRow {
  id: string;
  created_at: string;
  prompt: string;
  model: string;
  path: string;
  specs: ImageSpecs;
  agent?: string;
  cost_usd?: number;
}

interface ListOutput {
  total: number;
  returned: number;
  images: ListRow[];
}

function toRow(r: ImageRecord): ListRow {
  return {
    id: r.id,
    created_at: r.createdAt,
    prompt: r.prompt,
    model: r.modelName,
    path: r.path,
    specs: r.specs,
    ...(r.agent ? { agent: r.agent } : {}),
    ...(r.costUsd !== undefined ? { cost_usd: r.costUsd } : {}),
  };
}

export const imageList: ToolDefinition<ListArgs, ListOutput> = {
  name: 'image_list',
  toolset: 'image',
  description:
    'Find images generated earlier, newest first. Use this to recover the path of an image ' +
    'whose tool result has scrolled out of the conversation — "the koala one", "the last ' +
    'image I made". Filter by prompt substring (query), model, agent, or date range. ' +
    'Returns paths and metadata; pass a path to file_read or analyze_file to actually look ' +
    'at the image.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Case-insensitive substring of the prompt.' },
      model: { type: 'string', description: 'Image-model handle.' },
      agent: { type: 'string', description: 'Restrict to images generated by this agent.' },
      mine_only: { type: 'boolean', description: 'Only images you generated yourself.' },
      since: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      until: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      limit: { type: 'number', description: 'Default 20, max 200.' },
      offset: { type: 'number', description: 'For paging through the total.' },
    },
    additionalProperties: false,
  },
  available: (ctx) => imageGenEnabled(ctx),
  async handler(input, ctx): Promise<ListOutput> {
    const agent = input.mine_only ? ctx.agent : input.agent;
    const { total, images } = await listRecords({
      ...(input.query ? { query: input.query } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(agent ? { agent } : {}),
      ...(input.since ? { since: input.since } : {}),
      ...(input.until ? { until: input.until } : {}),
      limit: input.limit ?? 20,
      offset: input.offset ?? 0,
    });
    return { total, returned: images.length, images: images.map(toRow) };
  },
};

export function imageTools(): ToolDefinition[] {
  return [imageGenerate as ToolDefinition, imageList as ToolDefinition];
}
