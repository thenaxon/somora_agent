// Video tools — start a render, ask how it is going.
//
// `video_generate` does NOT wait. A render runs for minutes and the
// backend works through them one at a time; holding a turn open for
// that would block the agent and everything queued behind it. The job
// is started, the turn ends, and the agent is woken when its video is
// ready — the same arrangement the tmux watcher uses for a long-running
// terminal.
//
// The main server owns the job loop, so in an MCP child (claude-cli,
// codex-cli, grok-cli) these tools hand the request over by HTTP rather
// than starting a loop that would die with the child.

import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { startVideoJob, VideoGenError } from '../../videogen/generate.ts';
import { checkSlot, listJobs, readJob } from '../../videogen/jobs.ts';
import { resolveCapabilities } from '../../media/capabilities.ts';
import { resolveVideoModel } from '../../config/types.ts';
import { referenceFromBytes } from '../../imagegen/references.ts';
import { ImageGenError } from '../../imagegen/generate.ts';
import {
  checkReadAllowed,
  realpathSafeAncestor,
  resolveLocalPath,
} from '../file/policy.ts';
import { logger } from '../../server/logger.ts';
import { loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';

function videoGenEnabled(ctx: ToolContext): boolean {
  return ctx.config.videoGen?.enabled === true && (ctx.config.videoGen?.models.length ?? 0) > 0;
}

const GenerateInput = z
  .object({
    prompt: z.string().min(1).max(4000),
    model: z.string().min(1).optional(),
    seconds: z.number().positive().optional(),
    size: z.string().min(1).optional(),
    aspect_ratio: z.string().min(1).optional(),
    audio: z.boolean().optional(),
    quality: z.boolean().optional(),
    seed: z.number().int().optional(),
    reference_images: z.array(z.string().min(1)).max(4).optional(),
    save_to: z.string().min(1).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type GenerateArgs = z.infer<typeof GenerateInput>;

interface StartOutput {
  job_id: string;
  status: string;
  model: string;
  note: string;
  active_jobs: number;
  slot_limit: number;
  warnings?: string[];
}

/** Read reference images from disk under the same policy as file_read.
 *  Paths, never base64 — the caller works on this machine, and base64
 *  in a tool argument would mean loading a file into its context only
 *  to send it straight back out. */
async function readReferences(input: GenerateArgs, ctx: ToolContext) {
  const out = [];
  for (const ref of input.reference_images ?? []) {
    const { absolute } = await resolveLocalPath(ref, ctx.agent, ctx.config);
    for (const candidate of [absolute, await realpathSafeAncestor(absolute)]) {
      const verdict = checkReadAllowed(candidate);
      if (!verdict.ok) throw new Error(`video_generate: reference_images ${verdict.reason}`);
    }
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch (err) {
      throw new Error(
        `video_generate: could not read reference image '${ref}': ${(err as Error).message}`,
      );
    }
    try {
      out.push(referenceFromBytes(bytes, ref));
    } catch (err) {
      if (err instanceof ImageGenError) throw new Error(`video_generate: ${err.message}`);
      throw err;
    }
  }
  return out;
}

/**
 * Is this the MCP child rather than the main server?
 *
 * The job loop lives in the main server: it polls for minutes and wakes
 * agents, and a child process spawned for one turn cannot do either —
 * it exits and the render is orphaned. So when the tool runs there, the
 * request is handed over by HTTP instead. Detected by the env the child
 * launcher sets, the same way spawn and dream decide.
 */
function inMcpChild(): boolean {
  // SOMORA_AGENT is set by the MCP child's launcher and by nothing
  // else — the main server carries the agent in a call argument, not
  // in its environment.
  return Boolean(process.env.SOMORA_AGENT);
}

async function startViaHttp(
  body: Record<string, unknown>,
): Promise<{ job: { id: string; status: string; modelName: string; warnings?: string[] } }> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const res = await loopbackFetch(`${scheme}://${host}:${port}/video/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `video_generate: ${typeof payload.error === 'string' ? payload.error : `server returned ${res.status}`}`,
    );
  }
  return payload as never;
}

export const videoGenerate: ToolDefinition<GenerateArgs, StartOutput> = {
  name: 'video_generate',
  toolset: 'video',
  description:
    'Start a video render and return immediately — it does NOT wait. A render takes minutes ' +
    'and the backend does one at a time, so you get a job id now and are woken with the ' +
    'finished video later; carry on with something else in the meantime. Use video_status to ' +
    'look in on it. Which fields a model takes differs per model (video_models tells you) and ' +
    'one it does not take is rejected before the request goes out. reference_images takes FILE ' +
    'PATHS and the ORDER matters: none = text-to-video, one = that image is the opening frame, ' +
    'two = opening and closing frame with the video interpolated between them.',
  inputSchema: GenerateInput,
  jsonSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What should happen in the video.' },
      model: { type: 'string', description: 'Configured video-model handle. Omit for the default.' },
      seconds: { type: 'number', description: 'Length in seconds. Model-dependent maximum.' },
      size: { type: 'string', description: 'Explicit pixels, e.g. "1344x768".' },
      aspect_ratio: { type: 'string', description: 'e.g. "16:9", "9:16", "1:1".' },
      audio: { type: 'boolean', description: 'Generate sound, where the model can.' },
      quality: { type: 'boolean', description: 'Slower, better. Default false.' },
      seed: { type: 'number', description: 'Repeat a previous result.' },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Paths. One = opening frame; two = opening and closing frame, in that order.',
      },
      save_to: { type: 'string', description: 'Extra destination for the finished file.' },
      extra: {
        type: 'object',
        description: 'Provider-specific fields, passed through untouched.',
        additionalProperties: true,
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  available: (ctx) => videoGenEnabled(ctx),
  async handler(input, ctx): Promise<StartOutput> {
    const references = await readReferences(input, ctx);
    const specs: Record<string, unknown> = { ...(input.extra ?? {}) };
    for (const key of ['seconds', 'size', 'aspect_ratio', 'audio', 'quality', 'seed'] as const) {
      if (input[key] !== undefined) specs[key] = input[key];
    }

    // In the MCP child the job must be started by the main server —
    // see inMcpChild. References travel as base64 there because the
    // child and the server share a filesystem but not a request.
    if (inMcpChild()) {
      const { job } = await startViaHttp({
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...specs,
        agent: ctx.agent,
        ...(ctx.session ? { session: ctx.session } : {}),
        ...(references.length > 0
          ? { reference_images: references.map((r) => r.bytes.toString('base64')) }
          : {}),
      });
      return {
        job_id: job.id,
        status: job.status,
        model: job.modelName,
        note:
          'Started. You will be woken when it is done — do not poll in a loop, and do not wait ' +
          'for it in this turn.',
        active_jobs: 0,
        slot_limit: ctx.config.videoGen?.maxConcurrent ?? 4,
        ...(job.warnings ? { warnings: job.warnings } : {}),
      };
    }

    try {
      const { job } = await startVideoJob(
        {
          prompt: input.prompt,
          ...(input.model ? { model: input.model } : {}),
          specs,
          ...(references.length > 0 ? { references } : {}),
          ...(input.save_to ? { saveTo: input.save_to } : {}),
          agent: ctx.agent,
          ...(ctx.session ? { session: ctx.session } : {}),
        },
        ctx.config,
      );
      const slot = await checkSlot(ctx.config);
      return {
        job_id: job.id,
        status: job.status,
        model: job.modelName,
        note:
          'Started. You will be woken when it is done — do not poll in a loop, and do not wait ' +
          'for it in this turn.',
        active_jobs: slot.active,
        slot_limit: slot.limit,
        ...(job.warnings ? { warnings: job.warnings } : {}),
      };
    } catch (err) {
      if (err instanceof VideoGenError) throw new Error(`video_generate: ${err.message}`);
      throw err;
    }
  },
};

const StatusInput = z
  .object({
    job_id: z.string().min(1).optional(),
    mine_only: z.boolean().optional(),
  })
  .strict();
type StatusArgs = z.infer<typeof StatusInput>;

export const videoStatus: ToolDefinition<StatusArgs, { jobs: unknown[] }> = {
  name: 'video_status',
  toolset: 'video',
  description:
    'Look in on video renders — yours by default. Shows status, progress and, once finished, ' +
    'the path to the file. You do not need this to receive a result: you are woken when a ' +
    'render completes. It is for answering "is it still going?" without waiting.',
  inputSchema: StatusInput,
  jsonSchema: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'One job. Omit for all of them.' },
      mine_only: { type: 'boolean', description: 'Only your own jobs. Default true.' },
    },
    additionalProperties: false,
  },
  available: (ctx) => videoGenEnabled(ctx),
  async handler(input, ctx): Promise<{ jobs: unknown[] }> {
    const rows = input.job_id
      ? [await readJob(input.job_id)].filter(Boolean)
      : await listJobs(input.mine_only === false ? {} : { agent: ctx.agent });
    return {
      jobs: rows.map((j) => ({
        job_id: j!.id,
        status: j!.status,
        model: j!.modelName,
        prompt: j!.prompt,
        ...(j!.progress !== undefined ? { progress: j!.progress } : {}),
        ...(j!.queuePosition !== undefined ? { queue_position: j!.queuePosition } : {}),
        ...(j!.path ? { path: j!.path } : {}),
        ...(j!.error ? { error: j!.error } : {}),
        created_at: j!.createdAt,
      })),
    };
  },
};

const ModelsInput = z
  .object({
    model: z
      .string()
      .min(1)
      .optional()
      .describe('Handle to describe in detail. Omit to just list what is configured.'),
  })
  .strict();
type ModelsArgs = z.infer<typeof ModelsInput>;

interface VideoModelRow {
  name: string;
  label?: string;
  model: string;
  provider: string;
  is_default: boolean;
  accepts?: Record<string, string[] | string>;
  max_references?: number;
  variants?: string[];
  note?: string;
}

/**
 * Without this, picking a video model is guesswork: `model` is a free
 * string and nothing tells the caller which handles exist. Worse here
 * than it was for images, because video models differ sharply in what
 * they accept — one takes length, aspect ratio and an audio toggle,
 * another takes a seed and nothing else — and a parameter a model
 * ignores costs minutes of GPU before anyone notices it did nothing.
 *
 * Two-speed, like image_models: listing handles reads config and is
 * free; asking about one model hits its catalog.
 */
export const videoModels: ToolDefinition<ModelsArgs, { models: VideoModelRow[] }> = {
  name: 'video_models',
  toolset: 'video',
  description:
    'List the configured video models for video_generate. Call this before rendering when you ' +
    'need a model other than the default, or to see which parameters a model actually accepts — ' +
    'they differ a lot between video models, and one that is not accepted is rejected. Pass ' +
    'model: "<handle>" for the detail of one, including how many reference images it takes.',
  inputSchema: ModelsInput,
  jsonSchema: {
    type: 'object',
    properties: {
      model: {
        type: 'string',
        description: 'Handle to describe in detail. Omit to list all configured models.',
      },
    },
    additionalProperties: false,
  },
  available: (ctx) => videoGenEnabled(ctx),
  async handler(input, ctx): Promise<{ models: VideoModelRow[] }> {
    const configured = ctx.config.videoGen?.models ?? [];
    if (configured.length === 0) {
      throw new Error('video_models: no video models configured under videoGen.models.');
    }
    if (input.model && !configured.some((m) => m.name === input.model)) {
      throw new Error(
        `video_models: unknown video model '${input.model}'. Configured: ` +
          configured.map((m) => m.name).join(', '),
      );
    }

    const wanted = input.model ? configured.filter((m) => m.name === input.model) : configured;
    const rows: VideoModelRow[] = [];
    for (const entry of wanted) {
      const row: VideoModelRow = {
        name: entry.name,
        ...(entry.label ? { label: entry.label } : {}),
        model: entry.model,
        provider: entry.provider,
        is_default: entry.name === configured[0]?.name,
      };
      if (input.model) {
        const resolved = resolveVideoModel(ctx.config, entry.name);
        if (!resolved || resolved.provider.engine !== 'openai-compatible') {
          row.note =
            `provider '${entry.provider}' is not an openai-compatible provider — ` +
            'video_generate will refuse this model.';
        } else if (entry.allow) {
          row.accepts = Object.fromEntries(
            (entry.allow.supported ?? []).map((f) => [f, 'any value']),
          );
          if (entry.allow.maxReferences !== undefined) row.max_references = entry.allow.maxReferences;
          if (entry.allow.variants) row.variants = entry.allow.variants;
          row.note = 'Declared in config; this provider publishes no catalog.';
        } else {
          try {
            const caps = await resolveCapabilities(resolved.providerName, resolved.provider, {
              name: entry.name,
              model: entry.model,
              capabilitiesEndpoint: entry.capabilitiesEndpoint,
            } as never);
            const accepts: Record<string, string[] | string> = {};
            for (const [field, values] of Object.entries(caps.values)) {
              if (Array.isArray(values) && values.length > 0) accepts[field] = values;
            }
            if (caps.supported) {
              for (const field of caps.supported) {
                if (!(field in accepts)) accepts[field] = 'any value';
              }
              row.note =
                'Fields not listed here are not accepted by this model — passing them is an error.';
            } else {
              row.note = 'No published parameter list; unlisted fields are passed through untouched.';
            }
            row.accepts = accepts;
            if (caps.maxReferences !== undefined) row.max_references = caps.maxReferences;
            if (caps.variants) row.variants = caps.variants;
          } catch (err) {
            row.note = `could not load capabilities: ${(err as Error).message}`;
            logger.debug({ msg: 'videogen.capabilities_lookup_failed', model: entry.name });
          }
        }
      }
      rows.push(row);
    }
    return { models: rows };
  },
};

export function videoTools(): ToolDefinition[] {
  return [
    videoGenerate as ToolDefinition,
    videoStatus as ToolDefinition,
    videoModels as ToolDefinition,
  ];
}

export { logger };
