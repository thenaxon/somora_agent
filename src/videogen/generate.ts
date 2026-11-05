// Starting, polling and collecting a video render.
//
// The lifecycle is provider-neutral: everything that differs between
// endpoints lives in dialects.ts, and everything that survives a
// restart lives in jobs.ts. What is left here is the sequence —
// validate, create, poll, download, store, notify — and the decisions
// that go with it.

import { Buffer } from 'node:buffer';
import { markRunning, openWork } from '../server/work-ledger.ts';
import type { Config, VideoModel } from '../config/types.ts';
import { resolveVideoModel } from '../config/types.ts';
import type { OpenAiCompatibleProvider } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { forgetCatalog, paramInfos, resolveCapabilities, validateSpecs } from '../media/capabilities.ts';
import type { ModelCapabilities } from '../imagegen/types.ts';
import { storeMedia } from '../media/store.ts';
import { newMediaId, writeRecord } from '../media/records.ts';
import type { MediaRecord } from '../media/types.ts';
import { readVideoMeta } from '../multimodal/dimensions.ts';
import { extractFrame } from './frame.ts';
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
import { buildCreateBody, checkMedia, describeSlots, mediaFromReferences, mediaSlots, type MediaItem } from './media.ts';

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
   *  the closing one. Order carries meaning here, unlike with images.
   *  The older form of `media` (mediaFromReferences). */
  references?: ReferenceImage[];
  /** Input files by meaning (media.ts). Not together with `references`. */
  media?: MediaItem[];
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
      ...(entry.allow.parameters ? { params: paramInfos(entry.allow.parameters) } : {}),
      ...(entry.allow.variants ? { variants: entry.allow.variants } : {}),
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

/** What a configured model accepts — from its `allow` block or its
 *  provider's catalog. Unknown when the model or provider is unusable. */
export async function videoModelCapabilities(config: Config, name: string): Promise<ModelCapabilities> {
  const resolved = resolveVideoModel(config, name);
  const unknown: ModelCapabilities = { known: false, source: 'unknown', values: {} };
  if (!resolved || resolved.provider.engine !== 'openai-compatible') return unknown;
  return capsFor(resolved.providerName, resolved.provider as OpenAiCompatibleProvider, resolved.entry).catch(() => unknown);
}

/** The input files a configured model takes, as clients show them
 *  (GET /video/status). Empty when the model or its provider is unusable. */
export async function videoModelMedia(config: Config, name: string): Promise<ReturnType<typeof describeSlots>> {
  const resolved = resolveVideoModel(config, name);
  if (!resolved || resolved.provider.engine !== 'openai-compatible') return {};
  return describeSlots(mediaSlots(resolved.entry, await videoModelCapabilities(config, name)));
}

/** Which content flavours this model serves. The catalog answers it;
 *  `allow.variants` is the fallback for providers without one (OpenAI
 *  publishes no video catalog, and it does serve thumbnails). */
function variantsFor(caps: ModelCapabilities, entry: VideoModel): string[] {
  return entry.allow?.variants ?? caps.variants ?? ['video'];
}

/** The provider's own words from an error body: `error.message`,
 *  `detail` and the like, with a code in front when it names one. The
 *  raw body when it is not JSON or says nothing readable. */
function readableError(text: string): string {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const msg = errorMessage(raw);
    if (!msg) return text;
    const err = raw.error as Record<string, unknown> | undefined;
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : undefined;
    return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
  } catch {
    return text;
  }
}

export interface StartResult {
  job: VideoJob;
  /** Roughly how long this is expected to take, when we can say. */
  note?: string;
}

/** The models to try, following each entry's `fallback:`; a handle
 *  already in the chain ends it, so a → b → a cannot spin. */
function fallbackChain(config: Config, first: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let name: string | undefined = first;
  while (name && !seen.has(name)) {
    seen.add(name);
    chain.push(name);
    name = config.videoGen?.models.find((m) => m.name === name)?.fallback;
  }
  return chain;
}

/**
 * Validate, create the job, and return. Deliberately does NOT wait: the
 * render runs for minutes, and the caller gets its result through a
 * wake-up rather than by holding a turn open.
 *
 * A model that is unavailable (unreachable, 5xx, 503 while the GPU box
 * has another model loaded) hands the request to its `fallback:`, as
 * for images. Anything else — a value the model refuses, a busy slot —
 * is the caller's and ends here, so the real message is not buried.
 */
export async function startVideoJob(input: StartInput, config: Config): Promise<StartResult> {
  const first = input.model ?? config.videoGen?.models[0]?.name;
  const chain = first ? fallbackChain(config, first) : [undefined];
  const skipped: string[] = [];
  for (const [i, name] of chain.entries()) {
    try {
      const out = await startOnce({ ...input, ...(name ? { model: name } : {}) }, config);
      if (skipped.length === 0) return out;
      logger.warn({ msg: 'videogen.fell_back', requested: first, used: name, skipped, agent: input.agent });
      const note = `Used the fallback model '${name}' — ${skipped.join('; ')}`;
      const job: VideoJob = { ...out.job, fellBackFrom: skipped, warnings: [note, ...(out.job.warnings ?? [])] };
      await writeJob(job);
      return { ...out, job };
    } catch (err) {
      const unavailable = err instanceof VideoGenError && (err.kind === 'upstream' || err.kind === 'unavailable');
      if (!unavailable || i === chain.length - 1) throw err;
      skipped.push(`'${name}' was unavailable: ${(err as Error).message}`);
      logger.warn({ msg: 'videogen.model_unavailable', model: name, next: chain[i + 1], err: (err as Error).message });
    }
  }
  throw new VideoGenError(`No video model in the chain from '${first}' started a render.`, 'upstream');
}

async function startOnce(input: StartInput, config: Config): Promise<StartResult> {
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

  const specs: Record<string, unknown> = { ...entry.defaults, ...(input.specs ?? {}) };
  const references = input.references ?? [];
  if (references.length > 0 && (input.media?.length ?? 0) > 0) {
    throw new VideoGenError('Pass input files either as reference_images or as media, not both.', 'input');
  }
  const items = input.media ?? mediaFromReferences(references);
  const check = (caps: ModelCapabilities) => {
    const problems = validateSpecs(specs as never, caps, label);
    const media = checkMedia(items, entry, caps, label);
    problems.push(...media.problems);
    const maxSeconds = entry.allow?.maxSeconds;
    const seconds = Number(specs.seconds);
    if (maxSeconds !== undefined && specs.seconds !== undefined && Number.isFinite(seconds) && seconds > maxSeconds) {
      problems.push(`${label} renders at most ${maxSeconds} s; ${specs.seconds} s was asked for.`);
    }
    if (caps.maxReferences !== undefined && references.length > caps.maxReferences) {
      problems.push(
        caps.maxReferences === 0
          ? `${label} does not work from reference images — drop reference_images, or pick a model that does.`
          : `${references.length} reference images passed, but ${label} accepts at most ${caps.maxReferences}.`,
      );
    }
    return { problems, media };
  };
  let caps = await capsFor(providerName, provider, entry);
  let { problems, media } = check(caps);
  // Refused on what the catalog said? It may have changed since it was
  // read — ask once more before telling the caller no.
  if (problems.length > 0 && caps.source === 'catalog') {
    forgetCatalog(providerName, entry.capabilitiesEndpoint);
    caps = await capsFor(providerName, provider, entry);
    ({ problems, media } = check(caps));
  }
  if (problems.length > 0) throw new VideoGenError(problems.join('\n'), 'input');

  const dialect = dialectFor(entry.wire);
  const ep = endpointsFor(entry);
  const url = dialect.createUrl(provider.baseUrl, ep, entry.model);
  const timeoutMs = config.videoGen?.requestTimeoutMs ?? 120_000;

  // The body in the dialect's published format: JSON without files,
  // multipart parts or data: URIs with them (media.ts).
  const headers = authHeaders(provider);
  const built = buildCreateBody({
    wire: entry.wire,
    model: entry.model,
    prompt,
    specs,
    items,
    slots: media.slots,
    ...(entry.transport ? { transport: entry.transport } : {}),
    ...((entry.fps ?? caps.fps) !== undefined ? { fps: entry.fps ?? caps.fps } : {}),
  });
  const body = built.body;
  if (built.contentType) headers['content-type'] = built.contentType;

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
    // A 4xx is the provider refusing THIS request — a value, a file, a
    // missing field. The caller can fix it, and a retry of the same
    // request cannot; reporting it as a broken upstream invited exactly
    // that retry. Auth, permission and rate limits stay upstream trouble.
    const refused = res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status);
    // A provider that wants JSON says so in words somora cannot act on
    // by itself; the operator can, in one line of config.
    const sentMultipart = !built.contentType;
    const hint = sentMultipart && (res.status === 415 || /application\/json|content-type/i.test(text))
      ? ` The files went as multipart form data; if this provider takes JSON, set transport: json on videoGen.models '${entry.name}' (docs/videogen.md).`
      : '';
    throw new VideoGenError(
      `Video ${refused ? 'provider refused the request' : 'upstream returned'} ${res.status}: ${readableError(text).slice(0, 300)}${hint}`,
      refused ? 'input' : 'upstream',
    );
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
    ...(items.length > 0 ? { references: items.length } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  await writeJob(job);
  // In the work ledger from the start (Phase 2): the session that asked
  // sees the render under "from here", and the wake when it is done
  // goes through the same grace and the same suppression as every
  // other finished piece of work.
  if (job.agent) {
    openWork({
      id: job.id,
      origin: { kind: 'wake', about: 'job', ref: job.id },
      target: { agent: job.agent, session: job.session ?? 'main' },
      requester: { agent: job.agent, session: job.session ?? 'main' },
      text: `video render (${entry.name}): ${prompt}`,
      waiting: false,
    });
    markRunning(job.id);
  }
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
  // No still from the provider: cut one, a tenth of the way in.
  if (!thumbPath) {
    const frame = await extractFrame(stored.path, (meta?.durationSec ?? 0) * 0.1);
    if (frame) {
      const t = await storeMedia({
        bytes: frame,
        prompt: job.prompt,
        config,
        kind: 'video',
        declaredMime: 'image/jpeg',
        filenameStem: stored.filename.replace(/\.[^.]+$/, '') + '-thumb',
        now,
      });
      thumbPath = t.path;
      thumbMime = t.mime;
    } else {
      logger.debug({ msg: 'videogen.local_thumbnail_unavailable', job: job.id });
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
