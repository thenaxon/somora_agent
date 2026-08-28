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
import { applyDefaults, resolveCapabilities, validateSpecs } from '../media/capabilities.ts';
import { linkMedia, storeMedia } from '../media/store.ts';
import { parseSizeSpec, readDimensions } from '../multimodal/dimensions.ts';
import { newMediaId, writeRecord } from '../media/records.ts';
import type { ImageSpecs } from './types.ts';
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
    for (const [key, value] of Object.entries(specs)) {
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
    for (const [key, value] of Object.entries(specs)) {
      if (value !== undefined) body[key] = value;
    }
    if (references.length > 0) {
      body.input_references = references.map((r) => r.bytes.toString('base64'));
    }
    requestBody = JSON.stringify(body);
  }

  const startedAt = Date.now();
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

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ msg: 'imagegen.upstream_error', status: res.status, body: text.slice(0, 500) });
    // 503/504 means "not right now". The upstream body typically names
    // WHY — the active GPU profile, for instance — so it is relayed
    // verbatim rather than summarised away.
    if (res.status === 503 || res.status === 504) {
      throw new ImageGenError(
        `Image model '${entry.name}' is not available right now (upstream ${res.status}). ` +
          `This is usually temporary. Upstream says: ${text.slice(0, 300)}`,
        'unavailable',
      );
    }
    throw new ImageGenError(
      `Image upstream returned ${res.status}: ${text.slice(0, 300)}`,
      'upstream',
    );
  }

  const payload = (await res.json()) as {
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
  };
  const rows = payload.data ?? payload.images ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ImageGenError(
      'Image upstream returned no image data. The model may not support this endpoint.',
      'upstream',
    );
  }

  const decoded: UpstreamImage[] = [];
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

  const costUsd = typeof payload.usage?.cost === 'number' ? payload.usage.cost : undefined;

  const warnings: string[] = [];
  // Whatever the endpoint volunteered, relayed as-is.
  if (Array.isArray(payload.ignored_params)) {
    const names = payload.ignored_params.filter((x): x is string => typeof x === 'string');
    if (names.length > 0) {
      warnings.push(
        `The endpoint ignored these parameters — they had no effect: ${names.join(', ')}.`,
      );
    }
  }
  if (Array.isArray(payload.warnings)) {
    for (const w of payload.warnings) if (typeof w === 'string' && w) warnings.push(w);
  }

  // And the check that needs no cooperation: did we get the size we
  // asked for? A cap, a rounding to a supported step, or a model that
  // only renders squares all answer 200 with a perfectly good image of
  // the wrong shape. Only comparable when the request named pixels —
  // a tier like "2K" is a different vocabulary.
  const requested = parseSizeSpec(specs.size);
  const firstDims = readDimensions(decoded[0]!.bytes);
  if (requested && firstDims &&
      (requested.width !== firstDims.width || requested.height !== firstDims.height)) {
    warnings.push(
      `Requested ${requested.width}x${requested.height} but the image came back ` +
        `${firstDims.width}x${firstDims.height}. The endpoint substituted a size — ` +
        `it may cap dimensions or round to sizes it supports.`,
    );
    logger.info({
      msg: 'imagegen.size_substituted',
      model: entry.name,
      requested: specs.size,
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
      outputFormat: specs.output_format,
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
      specs: { ...specs },
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
