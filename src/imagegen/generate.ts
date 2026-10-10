// The single code path both entrances use: the web app's Images window
// (POST /images/generate) and the agents' `image_generate` tool. Two
// implementations would drift, and then the UI can do something the
// agent can't.
//
// Wire target is the OpenAI-shaped image endpoint. OpenRouter answers
// with base64 in `data[].b64_json`; OpenAI direct answers with a URL
// unless asked otherwise. Both are handled — a URL is fetched and the
// bytes stored, so the caller always ends up with a local file.
//
// The prompt is passed through VERBATIM. Specs travel as sibling fields
// in the request body, never appended to the prompt text — that's the
// whole reason this uses the image endpoint instead of chat completions
// with image modalities.

import { Buffer } from 'node:buffer';
import type { Config, ImageModel, Provider } from '../config/types.ts';
import { resolveImageModel } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { ratioMismatch, requestedRatio, translateAspectForOpenAiWire } from './aspect.ts';
import { applyDefaults, resolveCapabilities, validateSpecs } from '../media/capabilities.ts';
import { linkMedia, storeMedia } from '../media/store.ts';
import { parseSizeSpec, readDimensions } from '../multimodal/dimensions.ts';
import { newMediaId, writeRecord } from '../media/records.ts';
import type { ImageJobPaths, ImageSpecs, ModelCapabilities } from './types.ts';
import { errorMessage, normaliseStatus } from '../videogen/dialects.ts';
import type { MediaRecord } from '../media/types.ts';

/** One reference image, as handed to the generator. */
export interface ReferenceImage {
  bytes: Buffer;
  /** Concrete MIME, sniffed from the bytes by the caller. */
  mime: string;
  /** Filename sent in the multipart part — some backends key format
   *  detection off the extension. */
  filename: string;
}

export interface GenerateInput {
  prompt: string;
  /** Config handle. Omitted → first configured model. */
  model?: string;
  specs?: ImageSpecs;
  /** Extra destination for the finished file(s). Hardlinked. */
  saveTo?: string;
  /** Reference images for image-to-image, already read from disk by
   *  the caller. Bytes rather than paths: the read policy that decides
   *  WHICH files an agent may open belongs in the tool layer, where the
   *  agent identity is known — this module only knows how to talk to an
   *  endpoint. */
  references?: ReferenceImage[];
  /** Provider-specific fields passed through untouched. */
  extra?: Record<string, unknown>;
  agent?: string;
  session?: string;
}

export interface GenerateOutput {
  images: MediaRecord[];
  /** Sum over the batch, when the upstream reported it. */
  costUsd?: number;
  /**
   * Things the caller should know that did not stop the generation:
   * a parameter the endpoint ignored, a size it substituted. Empty on a
   * clean run. Surfaced rather than logged, because the caller is
   * usually a model and it cannot fix what it is not told.
   */
  warnings?: string[];
  /** Models that were tried and were unavailable, in order, when a
   *  `fallback:` chain had to be walked. Absent on a first-try success.
   *  Surfaced to the caller because a chain that has quietly settled on
   *  its last resort is a cost and quality change nobody would notice
   *  otherwise. */
  fellBackFrom?: string[];
}

/** Thrown for anything the caller can fix by changing its input. The
 *  tool layer relays `message` to the model verbatim; it is written to
 *  be actionable. */
export class ImageGenError extends Error {
  constructor(
    message: string,
    /**
     * `unavailable` is deliberately separate from `upstream`: an image
     * backend commonly shares a GPU box that runs one profile at a
     * time and answers 503 when its own isn't active. That is a
     * temporary state of the world, not a broken endpoint and not the
     * caller's mistake — it deserves a message that says "come back
     * later", and an HTTP status that says the same to the web app.
     */
    readonly kind: 'config' | 'input' | 'upstream' | 'unavailable' = 'input',
  ) {
    super(message);
    this.name = 'ImageGenError';
  }
}

/** Why the image came back in another size than asked for. Edit models
 *  commonly take their canvas from the first reference image and use
 *  `size` only as a pixel budget; when the result has that reference's
 *  shape, say so instead of guessing at caps and rounding — the guess
 *  sent an agent hunting for a model bug (2026-10-05). */
export function sizeSubstitutionNote(
  requested: { width: number; height: number },
  got: { width: number; height: number },
  firstReference: { width: number; height: number } | null,
  referenceCount: number,
): string {
  const head = `Requested ${requested.width}x${requested.height} but the image came back ${got.width}x${got.height}.`;
  const ratio = (d: { width: number; height: number }) => d.width / d.height;
  if (firstReference && Math.abs(ratio(got) / ratio(firstReference) - 1) < 0.03) {
    return (
      `${head} It has the shape of the first reference image (${firstReference.width}x${firstReference.height}): ` +
      'this edit model takes its canvas from reference image 1, and size only sets the pixel budget. ' +
      `For a ${requested.width}x${requested.height} result, pass a first reference with that aspect ratio.`
    );
  }
  if (referenceCount > 0) {
    return (
      `${head} Reference images were passed — edit models often take the shape of the first reference; ` +
      "check the model's endpoint_note in image_models. Otherwise the endpoint capped or rounded the size."
    );
  }
  return `${head} The endpoint substituted a size — it may cap dimensions or round to sizes it supports.`;
}

function ensureEnabled(config: Config): void {
  if (!config.imageGen?.enabled) {
    throw new ImageGenError(
      'Image generation is not enabled. Set imageGen.enabled: true in config.yaml and configure at least one model.',
      'config',
    );
  }
}

function resolveOrThrow(
  config: Config,
  name?: string,
): { entry: ImageModel; provider: Provider; providerName: string } {
  const resolved = resolveImageModel(config, name);
  if (resolved) return resolved;

  const configured = (config.imageGen?.models ?? []).map((m) => m.name);
  if (name && configured.length > 0) {
    throw new ImageGenError(
      `Unknown image model '${name}'. Configured: ${configured.join(', ')}`,
      'input',
    );
  }
  if (configured.length === 0) {
    throw new ImageGenError('No image models configured under imageGen.models.', 'config');
  }
  // Handle resolved but its provider entry is missing.
  const entry = config.imageGen?.models.find((m) => m.name === (name ?? configured[0]));
  throw new ImageGenError(
    `Image model '${entry?.name}' points at provider '${entry?.provider}', which is not defined under providers.`,
    'config',
  );
}

/** Strip a `data:image/png;base64,` prefix if present — callers hand us
 *  either form and both are common. */
function bareBase64(v: string): string {
  const comma = v.indexOf(',');
  return v.startsWith('data:') && comma > 0 ? v.slice(comma + 1) : v;
}

interface UpstreamImage {
  bytes: Buffer;
  mime?: string;
}

interface RawImageRow {
  b64_json?: string;
  /** Some routers return the field explicitly nulled (LiteLLM does this
   *  when it has already inlined the bytes as b64_json). Typed as
   *  nullable so that shape is handled rather than tripped over. */
  url?: string | null;
  image_url?: { url?: string | null };
  media_type?: string;
  mime_type?: string;
}

/**
 * Turn one response row into bytes, following a URL if that's what we
 * got. Providers differ here and the difference is not worth exposing
 * to callers — every path ends in a local file either way.
 *
 * Three shapes are in the wild and all three occur against endpoints we
 * target:
 *   - `b64_json` — what a public endpoint hands out when it does not
 *     want to serve files itself. Nothing to fetch.
 *   - an absolute URL — OpenAI direct does this, on a different host
 *     with the credentials baked into the link.
 *   - a RELATIVE path — an image server addressed directly tends to
 *     answer with a path into its own output tree ("/output/x.png"),
 *     because from its point of view the client already knows the host.
 *
 * The relative case is why `baseUrl` is a parameter: without it such a
 * row is undecodable and the whole generation is thrown away after it
 * was already paid for.
 */
async function rowToBytes(
  row: RawImageRow,
  timeoutMs: number,
  baseUrl: string,
  apiKey?: string,
): Promise<UpstreamImage | null> {
  const mime = row.media_type ?? row.mime_type;
  if (typeof row.b64_json === 'string' && row.b64_json.length > 0) {
    return { bytes: Buffer.from(bareBase64(row.b64_json), 'base64'), mime };
  }
  const url = row.url ?? row.image_url?.url;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (url.startsWith('data:')) {
    return { bytes: Buffer.from(bareBase64(url), 'base64'), mime };
  }

  // Absolute stays absolute; anything else is resolved against the
  // endpoint we just talked to.
  let resolved: URL;
  try {
    resolved = new URL(url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;

  // The key travels ONLY back to the host we already authenticated
  // against. A provider that answers with a pre-signed link on someone
  // else's host does not need it, and sending it there would hand our
  // credential to a third party.
  const headers: Record<string, string> = {};
  if (apiKey && resolved.origin === new URL(baseUrl).origin) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(resolved, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    // 401/403 on the follow-up fetch has one likely cause, and guessing
    // it here saves an hour of confusion: the key is only sent back to
    // the origin we authenticated against, so a link served from a
    // DIFFERENT internal host arrives unauthenticated.
    const authHint =
      res.status === 401 || res.status === 403
        ? ` The image link is on a different origin than the provider's baseUrl, so no API key was` +
          ` sent with it (by design — a key is never handed to another host). Configure the model's` +
          ` provider baseUrl to match the host that serves the images, or have the endpoint return` +
          ` b64_json instead of a link.`
        : '';
    throw new ImageGenError(
      `Upstream returned an image URL that could not be fetched (${res.status}): ${resolved.href}.${authHint}`,
      'upstream',
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { bytes: buf, mime: res.headers.get('content-type') ?? mime };
}

/** What an image endpoint answers with — the sync response, or for a
 *  job the fields its create and status answers carried. */
interface UpstreamPayload {
  data?: RawImageRow[];
  images?: RawImageRow[];
  usage?: { cost?: number };
  /** Non-standard, and worth reading where a provider offers it: the
   *  parameters it accepted but did not use, and free-text notes
   *  about anything it adjusted. Absent almost everywhere — a strict
   *  OpenAI-shaped proxy in front of a backend will drop them, which
   *  is exactly why the size check below does not depend on them. */
  ignored_params?: unknown;
  warnings?: unknown;
}

/** The error for a non-2xx answer. 503/504 means "not right now": the
 *  upstream body typically names WHY — the active GPU profile, a busy
 *  GPU — so it is relayed verbatim rather than summarised away, with
 *  the endpoint's own retry hint when it gives one. */
async function upstreamFailure(res: Response, modelName: string): Promise<ImageGenError> {
  const text = await res.text().catch(() => '');
  logger.warn({ msg: 'imagegen.upstream_error', status: res.status, body: text.slice(0, 500) });
  if (res.status === 503 || res.status === 504) {
    const retry = retryAfterSeconds(res, text);
    return new ImageGenError(
      `Image model '${modelName}' is not available right now (upstream ${res.status}). ` +
        `This is usually temporary.${retry !== undefined ? ` The endpoint suggests trying again in about ${retry}s.` : ''} ` +
        `Upstream says: ${text.slice(0, 300)}`,
      'unavailable',
    );
  }
  return new ImageGenError(`Image upstream returned ${res.status}: ${text.slice(0, 300)}`, 'upstream');
}

/** A retry hint in seconds: `retry_after_seconds` in a JSON body, else a
 *  numeric `Retry-After` header. */
function retryAfterSeconds(res: Response, text: string): number | undefined {
  try {
    const v = (JSON.parse(text) as Record<string, unknown>).retry_after_seconds;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  } catch {
    // not JSON — the header is the other place it lives
  }
  const h = Number(res.headers.get('retry-after'));
  return Number.isFinite(h) && h >= 0 && res.headers.get('retry-after') !== null ? Math.round(h) : undefined;
}

/**
 * The job paths to use, or null for the sync request. The operator's
 * `lifecycle` wins; unset, configured `jobs` paths or the catalog's
 * `async` block turn jobs on. A model with `allow` does not read the
 * catalog, so it only uses jobs when configured.
 */
function jobRoute(entry: ImageModel, caps: ModelCapabilities, label: string): ImageJobPaths | null {
  if (entry.lifecycle === 'sync') return null;
  const paths = entry.jobs ?? caps.jobs ?? null;
  if (entry.lifecycle === 'jobs' && !paths) {
    throw new ImageGenError(
      `${label} is set to lifecycle: jobs, but neither its config (jobs: {create, status, content}) nor the provider's catalog names the job paths.`,
      'config',
    );
  }
  return paths;
}

/** A job path with the id in it: `{id}` is replaced, otherwise the id
 *  is appended (`/img/status?id=` + id, `/jobs/` + id). */
function jobUrl(base: string, path: string, id: string): string {
  const enc = encodeURIComponent(id);
  return base + (path.includes('{id}') ? path.replaceAll('{id}', enc) : path + enc);
}

let jobPollMs = 2_000;
/** Tests only: poll faster than the 2 s a real endpoint deserves. */
export function setImageJobPollMs(ms: number): void {
  jobPollMs = ms;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The same request as the sync call, sent as a job: create it, ask for
 * its status until it is done, fetch the image. For the caller nothing
 * changes — this returns what the sync answer would have carried.
 *
 * Status answers are read with the video code's vocabulary (queued |
 * in_progress | completed | failed, the provider's spelling folded in);
 * `warnings` and `ignored_params` are taken from the last answer that
 * had them, because an endpoint stores them with the job.
 */
async function runImageJob(a: {
  base: string;
  paths: ImageJobPaths;
  headers: Record<string, string>;
  body: BodyInit;
  requestTimeoutMs: number;
  jobTimeoutMs: number;
  label: string;
  modelName: string;
  baseUrl: string;
  apiKey?: string;
  warnings: string[];
}): Promise<{ payload: UpstreamPayload; decoded: UpstreamImage[] }> {
  const deadline = Date.now() + a.jobTimeoutMs;
  const auth: Record<string, string> = a.headers.authorization ? { authorization: a.headers.authorization } : {};
  const unreachable = (err: unknown, what: string): ImageGenError => {
    logger.warn({ msg: 'imagegen.job_unreachable', model: a.modelName, step: what, err: (err as Error).message });
    return new ImageGenError(`Image upstream unreachable (${what}): ${(err as Error).message}`, 'upstream');
  };

  let res: Response;
  try {
    res = await fetch(a.base + a.paths.create, {
      method: 'POST',
      headers: a.headers,
      body: a.body,
      signal: AbortSignal.timeout(a.requestTimeoutMs),
    });
  } catch (err) {
    throw unreachable(err, 'create');
  }
  if (!res.ok) throw await upstreamFailure(res, a.modelName);
  const created = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const id = typeof created.id === 'string' && created.id ? created.id : undefined;
  if (!id) {
    throw new ImageGenError('The image endpoint accepted the job but returned no job id.', 'upstream');
  }
  logger.info({ msg: 'imagegen.job_created', model: a.modelName, id, waitingForGpu: created.waiting_for_gpu === true });

  // Time spent waiting for a GPU, reported back so a slow answer has a
  // reason the caller can see.
  let waitStart: number | undefined = created.waiting_for_gpu === true ? Date.now() : undefined;
  let waitedMs = 0;
  let last: Record<string, unknown> = created;
  let failures = 0;
  const stillWaiting = (p: Record<string, unknown>) => {
    if (p.waiting_for_gpu === true) waitStart ??= Date.now();
    else if (waitStart !== undefined) {
      waitedMs += Date.now() - waitStart;
      waitStart = undefined;
    }
  };
  const timedOut = (): ImageGenError => {
    logger.warn({ msg: 'imagegen.job_timeout', model: a.modelName, id, jobTimeoutMs: a.jobTimeoutMs });
    return new ImageGenError(
      `The image job for ${a.label} did not finish within ${a.jobTimeoutMs >= 120_000 ? `${Math.round(a.jobTimeoutMs / 60_000)} min` : `${Math.round(a.jobTimeoutMs / 1000)}s`}. ` +
        `The endpoint may still finish it: job ${id}, status at ${jobUrl('', a.paths.status, id)} on the provider. ` +
        "somora stopped waiting — raise imageGen.jobTimeoutMs (or the model's jobTimeoutMs) if this repeats.",
      'upstream',
    );
  };

  let done = normaliseStatus(created.status) === 'completed';
  while (!done) {
    if (Date.now() >= deadline) throw timedOut();
    await sleep(jobPollMs);
    let sres: Response;
    try {
      sres = await fetch(jobUrl(a.base, a.paths.status, id), { headers: auth, signal: AbortSignal.timeout(a.requestTimeoutMs) });
    } catch (err) {
      // One lost status call is not a lost job.
      if (++failures >= 5) throw unreachable(err, 'status');
      continue;
    }
    if (sres.status === 404) {
      throw new ImageGenError(`The image endpoint no longer knows job ${id} (404) — it expired or was dropped.`, 'upstream');
    }
    if (!sres.ok) {
      const text = await sres.text().catch(() => '');
      if (sres.status >= 500 && ++failures < 5) continue;
      throw new ImageGenError(`Image job status returned ${sres.status}: ${text.slice(0, 300)}`, 'upstream');
    }
    failures = 0;
    last = (await sres.json().catch(() => ({}))) as Record<string, unknown>;
    stillWaiting(last);
    const status = normaliseStatus(last.status);
    if (status === 'failed') {
      logger.warn({ msg: 'imagegen.job_failed', model: a.modelName, id, error: last.error });
      throw new ImageGenError(`The image job for ${a.label} failed: ${errorMessage(last) ?? 'the endpoint gave no reason'}`, 'upstream');
    }
    done = status === 'completed';
  }
  if (waitStart !== undefined) waitedMs += Date.now() - waitStart;

  // The result. A 409 means "not ready yet" even after a completed
  // status on an endpoint that writes the file a moment later.
  let decoded: UpstreamImage[] = [];
  let contentPayload: UpstreamPayload = {};
  for (;;) {
    let cres: Response;
    try {
      cres = await fetch(jobUrl(a.base, a.paths.content, id), { headers: auth, signal: AbortSignal.timeout(a.requestTimeoutMs) });
    } catch (err) {
      throw unreachable(err, 'content');
    }
    if (cres.status === 409) {
      if (Date.now() >= deadline) throw timedOut();
      await sleep(jobPollMs);
      continue;
    }
    if (!cres.ok) {
      const text = await cres.text().catch(() => '');
      throw new ImageGenError(`Fetching the finished image returned ${cres.status}: ${text.slice(0, 300)}`, 'upstream');
    }
    const ct = cres.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      // An endpoint that answers in the sync response's shape.
      contentPayload = (await cres.json()) as UpstreamPayload;
      for (const row of contentPayload.data ?? contentPayload.images ?? []) {
        const img = await rowToBytes(row, a.requestTimeoutMs, a.baseUrl, a.apiKey);
        if (img && img.bytes.length > 0) decoded.push(img);
      }
    } else {
      const bytes = Buffer.from(await cres.arrayBuffer());
      if (bytes.length > 0) decoded = [{ bytes, ...(ct ? { mime: ct.split(';')[0]!.trim() } : {}) }];
    }
    break;
  }
  if (decoded.length === 0) {
    throw new ImageGenError('The image job finished but its content held no image data.', 'upstream');
  }

  // Below this it is the normal hand-over to the GPU, not a busy one.
  if (waitedMs >= 10_000) {
    a.warnings.push(`The endpoint's GPU was busy: this image waited about ${Math.round(waitedMs / 1000)}s before rendering started.`);
  }
  logger.info({ msg: 'imagegen.job_done', model: a.modelName, id, waitedForGpuMs: waitedMs });
  const pick = (k: keyof UpstreamPayload) => contentPayload[k] ?? last[k] ?? created[k];
  return {
    payload: {
      ignored_params: pick('ignored_params'),
      warnings: pick('warnings'),
      ...(pick('usage') ? { usage: pick('usage') as UpstreamPayload['usage'] } : {}),
    },
    decoded,
  };
}

/**
 * Build the ordered list of model handles to try, following each
 * entry's `fallback:`. A cycle in the config (a → b → a) would
 * otherwise spin forever, so a handle already in the chain ends it.
 */
function fallbackChain(config: Config, first: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let name: string | undefined = first;
  while (name && !seen.has(name)) {
    seen.add(name);
    chain.push(name);
    name = config.imageGen?.models.find((m) => m.name === name)?.fallback;
  }
  return chain;
}

/**
 * Generate, walking the `fallback:` chain when a model turns out to be
 * unavailable. Everything except availability is fatal on the first
 * attempt: a bad spec value or an unknown handle is the caller's to
 * fix, and trying the next model would only bury the real message.
 */
export async function generateImage(
  input: GenerateInput,
  config: Config,
): Promise<GenerateOutput> {
  ensureEnabled(config);
  const first = input.model ?? config.imageGen?.models[0]?.name;
  if (!first) {
    throw new ImageGenError('No image models configured under imageGen.models.', 'config');
  }
  const chain = fallbackChain(config, first);
  const fellBackFrom: string[] = [];

  for (const [i, name] of chain.entries()) {
    const last = i === chain.length - 1;
    try {
      const out = await generateOnce({ ...input, model: name }, config);
      if (fellBackFrom.length > 0) {
        logger.warn({
          msg: 'imagegen.fell_back',
          requested: first,
          used: name,
          skipped: fellBackFrom,
          agent: input.agent,
        });
        return { ...out, fellBackFrom };
      }
      return out;
    } catch (err) {
      const unavailable =
        err instanceof ImageGenError && (err.kind === 'upstream' || err.kind === 'unavailable');
      if (!unavailable || last) throw err;
      fellBackFrom.push(`${name}: ${(err as Error).message}`);
      logger.warn({
        msg: 'imagegen.model_unavailable',
        model: name,
        next: chain[i + 1],
        err: (err as Error).message,
      });
    }
  }
  // Unreachable: the loop either returns or throws on the last entry.
  throw new ImageGenError(`No image model in the chain from '${first}' produced an image.`, 'upstream');
}

async function generateOnce(
  input: GenerateInput,
  config: Config,
): Promise<GenerateOutput> {
  ensureEnabled(config);

  const prompt = input.prompt?.trim();
  if (!prompt) throw new ImageGenError('prompt must not be empty.', 'input');

  const { entry, provider, providerName } = resolveOrThrow(config, input.model);
  const label = entry.label ?? entry.name;

  if (provider.engine !== 'openai-compatible') {
    throw new ImageGenError(
      `Image model '${entry.name}' uses provider '${providerName}' with engine '${provider.engine}'; image generation needs an openai-compatible provider.`,
      'config',
    );
  }

  const caps = await resolveCapabilities(providerName, provider, entry);
  const specs = applyDefaults(input.specs ?? {}, entry, caps);
  const problems = validateSpecs(specs, caps, label);

  const references = input.references ?? [];
  if (caps.maxReferences !== undefined && references.length > caps.maxReferences) {
    problems.push(
      caps.maxReferences === 0
        ? `${label} does not work from reference images — drop reference_images, or pick a model that does.`
        : `${references.length} reference images passed, but ${label} accepts at most ${caps.maxReferences}.`,
    );
  }
  if (problems.length > 0) throw new ImageGenError(problems.join('\n'), 'input');

  // What the caller asked for stays `specs` (validation, warnings, the
  // ratio check on the result); `wireSpecs` is what actually goes out.
  // On the OpenAI wire `aspect_ratio` becomes `size` — the wire has no
  // ratio field and routers drop it on /images/edits (aspect.ts).
  const warnings: string[] = [];
  let wireSpecs: ImageSpecs = specs;
  if (entry.wire === 'openai') {
    const t = translateAspectForOpenAiWire(specs, caps, references.length > 0 ? 'multipart' : 'json');
    wireSpecs = t.specs;
    if (t.translated) {
      logger.info({
        msg: 'imagegen.aspect_ratio_translated',
        model: entry.name,
        from: t.translated.from,
        to: t.translated.to,
        via: t.translated.via,
        exact: t.translated.exact,
      });
      if (!t.translated.exact) {
        warnings.push(
          `${label} takes no aspect_ratio on this wire; ${t.translated.from} was sent as size ${t.translated.to}, ` +
            `the closest shape available — not an exact ${t.translated.from}.`,
        );
      }
    } else if (t.dropped) {
      logger.warn({ msg: 'imagegen.aspect_ratio_dropped', model: entry.name, from: t.dropped.from, reason: t.dropped.reason });
      warnings.push(`aspect_ratio '${t.dropped.from}' could not be expressed for ${label} and was not sent (${t.dropped.reason}).`);
    }
  }

  const timeoutMs = config.imageGen?.timeoutMs ?? 300_000;
  const base = provider.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  // The two dialects differ ONLY once reference images are involved;
  // plain generation is the same JSON POST everywhere. See
  // ImageModelSchema.wire for why this is configured, not sniffed.
  const useMultipart = references.length > 0 && entry.wire === 'openai';
  const url = base + (useMultipart ? entry.editEndpoint : entry.endpoint);

  let requestBody: BodyInit;
  if (useMultipart) {
    // OpenAI's edit endpoint (and LiteLLM's passthrough to a local
    // backend) takes files, not base64: one `image[]` part per
    // reference. Sending several is the entire point of multi-reference
    // work, so the array form is used even for a single image.
    const form = new FormData();
    form.append('model', entry.model);
    form.append('prompt', prompt);
    for (const [key, value] of Object.entries(wireSpecs)) {
      if (value !== undefined) form.append(key, String(value));
    }
    for (const [key, value] of Object.entries(input.extra ?? {})) {
      if (value !== undefined) {
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
    for (const ref of references) {
      form.append('image[]', new Blob([new Uint8Array(ref.bytes)], { type: ref.mime }), ref.filename);
    }
    // No content-type header on purpose — fetch has to set it itself so
    // the multipart boundary matches the body it generates.
    requestBody = form;
  } else {
    headers['content-type'] = 'application/json';
    const body: Record<string, unknown> = {
      ...(input.extra ?? {}),
      model: entry.model,
      prompt,
    };
    for (const [key, value] of Object.entries(wireSpecs)) {
      if (value !== undefined) body[key] = value;
    }
    if (references.length > 0) {
      // OpenRouter's Image API (`POST /api/v1/images`) rejects bare base64
      // strings with a ZodError ("expected object, received string") —
      // verified live 2026-09-01. It wants chat-completions-style objects
      // carrying a data URL. Bound to the openrouter dialect on purpose:
      // a future JSON dialect that wants bare strings must not inherit
      // the object form silently. `wire: openai` never reaches this branch
      // with references (multipart above).
      // https://openrouter.ai/docs/guides/overview/multimodal/image-generation
      body.input_references =
        entry.wire === 'openrouter'
          ? references.map((r) => ({
              type: 'image_url',
              image_url: { url: `data:${r.mime};base64,${r.bytes.toString('base64')}` },
            }))
          : references.map((r) => r.bytes.toString('base64'));
    }
    requestBody = JSON.stringify(body);
  }

  const jobPaths = jobRoute(entry, caps, label);

  // The fields as sent (no bytes) — the arbiter when a shape comes back
  // wrong. The 2026-09-06 case took a day to pin on the router because
  // nothing recorded what left somora.
  logger.info({
    msg: 'imagegen.request',
    model: entry.name,
    wire: entry.wire,
    endpoint: useMultipart ? entry.editEndpoint : entry.endpoint,
    multipart: useMultipart,
    ...(jobPaths ? { lifecycle: 'jobs', create: jobPaths.create } : {}),
    references: references.length,
    specs: Object.fromEntries(Object.entries(wireSpecs).filter(([, v]) => v !== undefined)),
    ...(input.extra && Object.keys(input.extra).length > 0 ? { extra: Object.keys(input.extra) } : {}),
  });

  const startedAt = Date.now();
  let payload: UpstreamPayload;
  let decoded: UpstreamImage[];
  if (jobPaths) {
    ({ payload, decoded } = await runImageJob({
      base,
      paths: jobPaths,
      headers,
      body: requestBody,
      requestTimeoutMs: timeoutMs,
      jobTimeoutMs: entry.jobTimeoutMs ?? config.imageGen?.jobTimeoutMs ?? 900_000,
      label,
      modelName: entry.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      warnings,
    }));
  } else {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const msg = (err as Error).message;
      const timedOut = (err as Error).name === 'TimeoutError';
      logger.warn({ msg: 'imagegen.upstream_unreachable', url, err: msg });
      throw new ImageGenError(
        timedOut
          ? `Image request timed out after ${Math.round(timeoutMs / 1000)}s. Large resolutions take longer — raise imageGen.timeoutMs if this repeats.`
          : `Image upstream unreachable: ${msg}`,
        'upstream',
      );
    }

    if (!res.ok) throw await upstreamFailure(res, entry.name);

    payload = (await res.json()) as UpstreamPayload;
    const rows = payload.data ?? payload.images ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ImageGenError(
        'Image upstream returned no image data. The model may not support this endpoint.',
        'upstream',
      );
    }

    decoded = [];
    for (const row of rows) {
      const img = await rowToBytes(row, timeoutMs, provider.baseUrl, provider.apiKey);
      if (img && img.bytes.length > 0) decoded.push(img);
    }
    if (decoded.length === 0) {
      throw new ImageGenError(
        'Image upstream returned rows without usable image data (no b64_json and no fetchable url).',
        'upstream',
      );
    }
  }

  const costUsd = typeof payload.usage?.cost === 'number' ? payload.usage.cost : undefined;

  // Whatever the endpoint volunteered, relayed as-is.
  if (Array.isArray(payload.ignored_params)) {
    const names = payload.ignored_params.filter((x): x is string => typeof x === 'string');
    if (names.length > 0) {
      warnings.push(
        `The endpoint ignored these parameters — they had no effect: ${names.join(', ')}.`,
      );
    }
  }
  const endpointNotes: string[] = [];
  if (Array.isArray(payload.warnings)) {
    for (const w of payload.warnings) if (typeof w === 'string' && w) {
      warnings.push(w);
      endpointNotes.push(w);
    }
  }

  // And the check that needs no cooperation: did we get the size we
  // asked for? A cap, a rounding to a supported step, or a model that
  // only renders squares all answer 200 with a perfectly good image of
  // the wrong shape. Only comparable when the request named pixels —
  // a tier like "2K" is a different vocabulary.
  const requested = parseSizeSpec(wireSpecs.size);
  const firstDims = readDimensions(decoded[0]!.bytes);
  if (requested && firstDims &&
      (requested.width !== firstDims.width || requested.height !== firstDims.height)) {
    // The endpoint may already have said why, naming the size it
    // delivered; a second explanation of the same thing is noise.
    const explained = endpointNotes.some((w) => w.includes(`${firstDims.width}x${firstDims.height}`));
    if (!explained) {
      warnings.push(sizeSubstitutionNote(requested, firstDims, references[0] ? readDimensions(references[0].bytes) : null, references.length));
    }
    logger.info({
      msg: 'imagegen.size_substituted',
      model: entry.name,
      requested: wireSpecs.size,
      actual: `${firstDims.width}x${firstDims.height}`,
    });
  }
  // Same check for a SHAPE: a ratio was asked for (as aspect_ratio, or
  // as a named size) and the pixels say otherwise. This is what would
  // have stopped a whole series of "16:9" squares after the first one.
  const wantedRatio = requestedRatio(specs) ?? requestedRatio(wireSpecs);
  if (!requested && wantedRatio !== null && firstDims && ratioMismatch(wantedRatio, firstDims.width, firstDims.height)) {
    const asked = specs.aspect_ratio ?? wireSpecs.size ?? specs.size;
    warnings.push(
      `Requested aspect ratio ${asked} but the image came back ${firstDims.width}x${firstDims.height} ` +
        `(${(firstDims.width / firstDims.height).toFixed(2)}:1). The endpoint or a router in front of it ` +
        `ignored the ratio — check the model's catalog and prefer an explicit size if this repeats.`,
    );
    logger.warn({
      msg: 'imagegen.aspect_ratio_substituted',
      model: entry.name,
      requested: asked,
      sent: Object.fromEntries(Object.entries(wireSpecs).filter(([, v]) => v !== undefined)),
      actual: `${firstDims.width}x${firstDims.height}`,
    });
  }

  const batchId = newMediaId();
  const now = new Date();
  const records: MediaRecord[] = [];

  for (const [i, img] of decoded.entries()) {
    const stored = await storeMedia({
      bytes: img.bytes,
      kind: 'image',
      prompt,
      config,
      declaredMime: img.mime,
      outputFormat: wireSpecs.output_format,
      now,
    });

    const linkedTo: string[] = [];
    if (input.saveTo) {
      try {
        linkedTo.push(await linkMedia(stored.path, input.saveTo));
      } catch (err) {
        // The image exists and is safe in its canonical home; failing
        // the whole call over a second name would throw away a paid
        // generation. Report it as a warning instead.
        logger.warn({
          msg: 'imagegen.link_failed',
          dest: input.saveTo,
          err: (err as Error).message,
        });
      }
    }

    const dims = readDimensions(img.bytes);
    const record: MediaRecord = {
      id: newMediaId(),
      kind: 'image',
      createdAt: now.toISOString(),
      prompt,
      modelName: entry.name,
      modelId: entry.model,
      provider: providerName,
      // As SENT — the gallery must never show a spec the endpoint never
      // saw as if it were the image's shape (width/height carry the truth).
      specs: { ...wireSpecs },
      path: stored.path,
      filename: stored.filename,
      mime: stored.mime,
      bytes: stored.bytes,
      ...(dims ? { width: dims.width, height: dims.height } : {}),
      linkedTo,
      // Upstreams bill per request, not per image; splitting evenly
      // keeps the gallery's per-image figure honest for n > 1.
      ...(costUsd !== undefined ? { costUsd: costUsd / decoded.length } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(references.length > 0 ? { references: references.length } : {}),
      batchId,
      batchIndex: i,
    };
    await writeRecord(record);
    records.push(record);
  }

  logger.info({
    msg: 'imagegen.generated',
    model: entry.model,
    count: records.length,
    ms: Date.now() - startedAt,
    costUsd,
    agent: input.agent,
  });

  return {
    images: records,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
