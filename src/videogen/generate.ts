// Starting, polling and collecting a video render.
//
// The lifecycle is provider-neutral: everything that differs between
// endpoints lives in dialects.ts, and everything that survives a
// restart lives in jobs.ts. What is left here is the sequence —
// validate, create, poll, download, store, notify — and the decisions
// that go with it.

import { Buffer } from 'node:buffer';
import type { Config, VideoModel } from '../config/types.ts';
import { resolveVideoModel } from '../config/types.ts';
import type { OpenAiCompatibleProvider } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { resolveCapabilities, validateSpecs } from '../media/capabilities.ts';
import type { ModelCapabilities } from '../imagegen/types.ts';
import { linkMedia, storeMedia } from '../media/store.ts';
import { newMediaId, writeRecord } from '../media/records.ts';
import type { MediaRecord } from '../media/types.ts';
import { readVideoMeta } from '../multimodal/dimensions.ts';
import type { ReferenceImage } from '../imagegen/generate.ts';
import {
  dialectFor,
  decodeBase64,
  DEFAULT_ENDPOINTS,
  errorMessage,
  type ContentVariant,
  type JobState,
} from './dialects.ts';
import { checkSlot, isActive, readJob, updateJob, writeJob, type VideoJob } from './jobs.ts';

/** Thrown for anything the caller can fix. Relayed to the model as-is;
 *  `unavailable` means "not right now" and is not the caller's fault. */
export class VideoGenError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'input' | 'upstream' | 'unavailable' | 'busy' = 'input',
  ) {
    super(message);
    this.name = 'VideoGenError';
  }
}

export interface StartInput {
  prompt: string;
  model?: string;
  specs?: Record<string, unknown>;
  /** Ordered — with two, the first is the opening frame and the second
   *  the closing one. Order carries meaning here, unlike with images. */
  references?: ReferenceImage[];
  saveTo?: string;
  agent?: string;
  session?: string;
}

function resolveOrThrow(config: Config, name?: string) {
  if (!config.videoGen?.enabled) {
    throw new VideoGenError(
      'Video generation is not enabled. Set videoGen.enabled: true in config.yaml and configure at least one model.',
      'config',
    );
  }
  const resolved = resolveVideoModel(config, name);
  if (resolved) return resolved;
  const configured = (config.videoGen?.models ?? []).map((m) => m.name);
  throw new VideoGenError(
    name && configured.length > 0
      ? `Unknown video model '${name}'. Configured: ${configured.join(', ')}`
      : 'No video models configured under videoGen.models.',
    configured.length > 0 ? 'input' : 'config',
  );
}

function endpointsFor(entry: VideoModel) {
  const d = DEFAULT_ENDPOINTS[entry.wire];
  return {
    create: entry.createEndpoint ?? d.create,
    status: entry.statusEndpoint ?? d.status,
    content: entry.contentEndpoint ?? d.content,
  };
}

function authHeaders(provider: OpenAiCompatibleProvider): Record<string, string> {
  return provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
}

/** Capabilities from the provider's catalog, or the operator's `allow`
 *  block where there is none. Same precedence as images. */
async function capsFor(
  providerName: string,
  provider: OpenAiCompatibleProvider,
  entry: VideoModel,
): Promise<ModelCapabilities> {
  if (entry.allow) {
    const values: Record<string, string[]> = {};
    if (entry.allow.aspect_ratio) values.aspect_ratio = entry.allow.aspect_ratio;
    if (entry.allow.size) values.size = entry.allow.size;
    return {
      known: true,
      source: 'config',
      values: values as ModelCapabilities['values'],
      ...(entry.allow.supported ? { supported: entry.allow.supported } : {}),
      ...(entry.allow.maxReferences !== undefined
        ? { maxReferences: entry.allow.maxReferences }
        : {}),
    };
  }
  return resolveCapabilities(providerName, provider, {
    // The catalog reader only needs these three fields; video and image
    // catalogs publish the same shape, which is why it is shared.
    name: entry.name,
    model: entry.model,
    capabilitiesEndpoint: entry.capabilitiesEndpoint,
  } as never);
}

/** Which content flavours this model serves. The catalog answers it;
 *  `allow.variants` is the fallback for providers without one (OpenAI
 *  publishes no video catalog, and it does serve thumbnails). */
function variantsFor(caps: ModelCapabilities, entry: VideoModel): string[] {
  return entry.allow?.variants ?? caps.variants ?? ['video'];
}

export interface StartResult {
  job: VideoJob;
  /** Roughly how long this is expected to take, when we can say. */
  note?: string;
}

/**
 * Validate, create the job, and return. Deliberately does NOT wait: the
 * render runs for minutes, and the caller gets its result through a
 * wake-up rather than by holding a turn open.
 */
export async function startVideoJob(input: StartInput, config: Config): Promise<StartResult> {
  const prompt = input.prompt?.trim();
  if (!prompt) throw new VideoGenError('prompt must not be empty.', 'input');

  const { entry, provider, providerName } = resolveOrThrow(config, input.model);
  const label = entry.label ?? entry.name;
  if (provider.engine !== 'openai-compatible') {
    throw new VideoGenError(
      `Video model '${entry.name}' uses provider '${providerName}' with engine '${provider.engine}'; video generation needs an openai-compatible provider.`,
      'config',
    );
  }

  const slot = await checkSlot(config);
  if (!slot.ok) throw new VideoGenError(slot.reason!, 'busy');

  const caps = await capsFor(providerName, provider, entry);
  const specs: Record<string, unknown> = { ...entry.defaults, ...(input.specs ?? {}) };
  const problems = validateSpecs(specs as never, caps, label);
  const references = input.references ?? [];
  if (caps.maxReferences !== undefined && references.length > caps.maxReferences) {
    problems.push(
      caps.maxReferences === 0
        ? `${label} does not work from reference images — drop reference_images, or pick a model that does.`
        : `${references.length} reference images passed, but ${label} accepts at most ${caps.maxReferences}.`,
    );
  }
  if (problems.length > 0) throw new VideoGenError(problems.join('\n'), 'input');

  const dialect = dialectFor(entry.wire);
  const ep = endpointsFor(entry);
  const url = dialect.createUrl(provider.baseUrl, ep, entry.model);
  const timeoutMs = config.videoGen?.requestTimeoutMs ?? 120_000;

  // Multipart once files are involved, JSON otherwise — the same split
  // images make, for the same reason.
  let body: BodyInit;
  const headers = authHeaders(provider);
  if (references.length > 0) {
    const form = new FormData();
    form.append('model', entry.model);
    form.append('prompt', prompt);
    for (const [k, v] of Object.entries(specs)) {
      if (v !== undefined) form.append(k, String(v));
    }
    // Two references mean first frame and last frame, and the endpoint
    // must be told WHICH is which — leaving that to array order would
    // make the result depend on how a caller happened to sort a
    // directory listing.
    if (references.length === 2) {
      form.append('first_frame', blobOf(references[0]!), references[0]!.filename);
      form.append('last_frame', blobOf(references[1]!), references[1]!.filename);
    } else {
      for (const ref of references) form.append('image[]', blobOf(ref), ref.filename);
    }
    body = form;
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ model: entry.model, prompt, ...specs });
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new VideoGenError(
      `Video upstream unreachable: ${(err as Error).message}`,
      'upstream',
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 503 || res.status === 504) {
      throw new VideoGenError(
        `Video model '${entry.name}' is not available right now (upstream ${res.status}). ` +
          `This is usually temporary. Upstream says: ${text.slice(0, 300)}`,
        'unavailable',
      );
    }
    throw new VideoGenError(`Video upstream returned ${res.status}: ${text.slice(0, 300)}`, 'upstream');
  }

  const payload = (await res.json()) as Record<string, unknown>;
  const created = dialect.parseCreate(payload);
  if (!created.id) {
    throw new VideoGenError('Video upstream accepted the request but returned no job id.', 'upstream');
  }

  const warnings = collectWarnings(payload);
  const now = new Date().toISOString();
  const job: VideoJob = {
    id: newMediaId(),
    providerJobId: created.id,
    modelName: entry.name,
    provider: providerName,
    prompt,
    specs,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.session ? { session: input.session } : {}),
    ...(references.length > 0 ? { references: references.length } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  await writeJob(job);
  logger.info({
    msg: 'videogen.job_started',
    job: job.id,
    providerJob: created.id,
    model: entry.name,
    agent: input.agent,
    active: slot.active + 1,
    limit: slot.limit,
  });
  return { job };
}

function blobOf(ref: ReferenceImage): Blob {
  return new Blob([new Uint8Array(ref.bytes)], { type: ref.mime });
}

/** `ignored_params` and `warnings`, where a provider volunteers them. */
export function collectWarnings(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(payload.ignored_params)) {
    const names = payload.ignored_params.filter((x): x is string => typeof x === 'string');
    if (names.length > 0) {
      out.push(`The endpoint ignored these parameters — they had no effect: ${names.join(', ')}.`);
    }
  }
  if (Array.isArray(payload.warnings)) {
    for (const w of payload.warnings) if (typeof w === 'string' && w) out.push(w);
  }
  return out;
}

/** Ask the provider how a job is doing and write what it said. */
export async function pollJob(job: VideoJob, config: Config): Promise<VideoJob> {
  const resolved = resolveVideoModel(config, job.modelName);
  if (!resolved) {
    return (await updateJob(job.id, {
      status: 'failed',
      error: `model '${job.modelName}' is no longer configured`,
    }))!;
  }
  const { entry, provider } = resolved;
  const dialect = dialectFor(entry.wire);
  const ep = endpointsFor(entry);
  const call = dialect.statusCall(
    (provider as OpenAiCompatibleProvider).baseUrl,
    ep,
    job.providerJobId,
    entry.model,
  );
  const timeoutMs = config.videoGen?.requestTimeoutMs ?? 120_000;

  let state: JobState;
  try {
    const res = await fetch(call.url, {
      method: call.method,
      headers: { ...authHeaders(provider as OpenAiCompatibleProvider), ...call.headers },
      ...(call.body ? { body: call.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // A transient 5xx is not a failed render; only a 4xx says the job
      // is gone for good.
      if (res.status >= 500) {
        logger.debug({ msg: 'videogen.poll_transient', job: job.id, status: res.status });
        return job;
      }
      return (await updateJob(job.id, {
        status: 'failed',
        error: errorMessage(payload) ?? `status check returned ${res.status}`,
      }))!;
    }
    state = dialect.parseStatus(payload);
  } catch (err) {
    // Network hiccup — leave the job alone and try again next tick.
    logger.debug({ msg: 'videogen.poll_error', job: job.id, err: (err as Error).message });
    return job;
  }

  if (state.status === 'failed') {
    logger.warn({ msg: 'videogen.job_failed', job: job.id, err: state.error });
    return (await updateJob(job.id, { status: 'failed', error: state.error ?? 'render failed' }))!;
  }
  if (state.status !== 'completed') {
    return (await updateJob(job.id, {
      status: state.status,
      ...(state.progress !== undefined ? { progress: state.progress } : {}),
      ...(state.queuePosition !== undefined ? { queuePosition: state.queuePosition } : {}),
    }))!;
  }

  return collect(job, state, config);
}

/** Download the finished render, store it, and write the media record. */
async function collect(job: VideoJob, state: JobState, config: Config): Promise<VideoJob> {
  const resolved = resolveVideoModel(config, job.modelName)!;
  const { entry, provider } = resolved;
  const dialect = dialectFor(entry.wire);
  const ep = endpointsFor(entry);
  const p = provider as OpenAiCompatibleProvider;
  const timeoutMs = config.videoGen?.requestTimeoutMs ?? 120_000;

  const fetchVariant = async (variant: ContentVariant): Promise<Buffer | null> => {
    // Veo hands the result back in the poll response; there is nothing
    // to fetch.
    if (variant === 'video' && state.resultBase64) return decodeBase64(state.resultBase64);
    const url =
      variant === 'video' && state.resultUrl
        ? state.resultUrl
        : dialect.contentUrl(p.baseUrl, ep, job.providerJobId, variant);
    if (!url) return null;
    const sameOrigin = (() => {
      try {
        return new URL(url).origin === new URL(p.baseUrl).origin;
      } catch {
        return false;
      }
    })();
    const res = await fetch(url, {
      headers: sameOrigin ? authHeaders(p) : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  };

  let bytes: Buffer | null;
  try {
    bytes = await fetchVariant('video');
  } catch (err) {
    logger.warn({ msg: 'videogen.download_failed', job: job.id, err: (err as Error).message });
    return job; // try again next tick; the provider keeps the file
  }
  if (!bytes || bytes.length === 0) {
    return (await updateJob(job.id, {
      status: 'failed',
      error: 'the render finished but no video bytes could be fetched',
    }))!;
  }

  const now = new Date();
  const stored = await storeMedia({
    bytes,
    prompt: job.prompt,
    config,
    kind: 'video',
    declaredMime: 'video/mp4',
    now,
  });
  const meta = readVideoMeta(bytes);

  // A still, where the provider serves one. Best-effort: a missing
  // thumbnail costs a gallery preview, never the video.
  let thumbPath: string | undefined;
  let thumbMime: string | undefined;
  const caps = await capsFor(resolved.providerName, p, entry);
  if (variantsFor(caps, entry).includes('thumbnail')) {
    try {
      const thumb = await fetchVariant('thumbnail');
      if (thumb && thumb.length > 0) {
        const t = await storeMedia({
          bytes: thumb,
          prompt: job.prompt,
          config,
          kind: 'video',
          declaredMime: 'image/webp',
          filenameStem: stored.filename.replace(/\.[^.]+$/, '') + '-thumb',
          now,
        });
        thumbPath = t.path;
        thumbMime = t.mime;
      }
    } catch (err) {
      logger.debug({ msg: 'videogen.thumbnail_failed', job: job.id, err: (err as Error).message });
    }
  }

  const record: MediaRecord = {
    id: newMediaId(),
    kind: 'video',
    createdAt: now.toISOString(),
    prompt: job.prompt,
    modelName: entry.name,
    modelId: entry.model,
    provider: job.provider,
    specs: job.specs,
    path: stored.path,
    filename: stored.filename,
    mime: stored.mime,
    bytes: stored.bytes,
    ...(meta ? { width: meta.width, height: meta.height, durationSec: meta.durationSec } : {}),
    ...(thumbPath ? { thumbPath, thumbMime } : {}),
    linkedTo: [],
    ...(job.agent ? { agent: job.agent } : {}),
    ...(job.session ? { session: job.session } : {}),
    ...(job.references ? { references: job.references } : {}),
    batchId: job.id,
    batchIndex: 0,
  };
  await writeRecord(record);
  logger.info({
    msg: 'videogen.job_completed',
    job: job.id,
    media: record.id,
    model: entry.name,
    bytes: stored.bytes,
    durationSec: meta?.durationSec,
    thumbnail: Boolean(thumbPath),
  });

  return (await updateJob(job.id, {
    status: 'completed',
    progress: 100,
    mediaId: record.id,
    path: stored.path,
  }))!;
}

export { isActive, readJob };
export async function linkFinished(job: VideoJob, dest: string): Promise<string | null> {
  if (!job.path) return null;
  try {
    return await linkMedia(job.path, dest);
  } catch (err) {
    logger.warn({ msg: 'videogen.link_failed', job: job.id, err: (err as Error).message });
    return null;
  }
}
