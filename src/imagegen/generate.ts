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
import { applyDefaults, resolveCapabilities, validateSpecs } from './capabilities.ts';
import { linkImage, storeImage } from './store.ts';
import { newImageId, writeRecord } from './records.ts';
import type { ImageRecord, ImageSpecs } from './types.ts';

export interface GenerateInput {
  prompt: string;
  /** Config handle. Omitted → first configured model. */
  model?: string;
  specs?: ImageSpecs;
  /** Extra destination for the finished file(s). Hardlinked. */
  saveTo?: string;
  /** Base64 image data (with or without data-URI prefix) for
   *  image-to-image. */
  references?: string[];
  /** Provider-specific fields passed through untouched. */
  extra?: Record<string, unknown>;
  agent?: string;
  session?: string;
}

export interface GenerateOutput {
  images: ImageRecord[];
  /** Sum over the batch, when the upstream reported it. */
  costUsd?: number;
}

/** Thrown for anything the caller can fix by changing its input. The
 *  tool layer relays `message` to the model verbatim; it is written to
 *  be actionable. */
export class ImageGenError extends Error {
  constructor(
    message: string,
    readonly kind: 'config' | 'input' | 'upstream' = 'input',
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
  url?: string;
  image_url?: { url?: string };
  media_type?: string;
  mime_type?: string;
}

/** Turn one response row into bytes, following a URL if that's what we
 *  got. Providers differ here and the difference is not worth exposing
 *  to callers. */
async function rowToBytes(row: RawImageRow, timeoutMs: number): Promise<UpstreamImage | null> {
  const mime = row.media_type ?? row.mime_type;
  if (typeof row.b64_json === 'string' && row.b64_json.length > 0) {
    return { bytes: Buffer.from(bareBase64(row.b64_json), 'base64'), mime };
  }
  const url = row.url ?? row.image_url?.url;
  if (typeof url === 'string' && url.startsWith('data:')) {
    return { bytes: Buffer.from(bareBase64(url), 'base64'), mime };
  }
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      throw new ImageGenError(
        `Upstream returned an image URL that could not be fetched (${res.status}).`,
        'upstream',
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf, mime: res.headers.get('content-type') ?? mime };
  }
  return null;
}

export async function generateImage(
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

  const specs = applyDefaults(input.specs ?? {}, entry);
  const caps = await resolveCapabilities(providerName, provider, entry);
  const problems = validateSpecs(specs, caps, label);

  const references = input.references ?? [];
  if (caps.maxReferences !== undefined && references.length > caps.maxReferences) {
    problems.push(
      `${references.length} reference images passed, but ${label} accepts at most ${caps.maxReferences}.`,
    );
  }
  if (problems.length > 0) throw new ImageGenError(problems.join('\n'), 'input');

  const timeoutMs = config.imageGen?.timeoutMs ?? 300_000;
  const url = provider.baseUrl.replace(/\/+$/, '') + entry.endpoint;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const body: Record<string, unknown> = {
    ...(input.extra ?? {}),
    model: entry.model,
    prompt,
  };
  for (const [key, value] of Object.entries(specs)) {
    if (value !== undefined) body[key] = value;
  }
  if (references.length > 0) {
    body.input_references = references.map((r) => bareBase64(r));
  }

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
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
    throw new ImageGenError(
      `Image upstream returned ${res.status}: ${text.slice(0, 300)}`,
      'upstream',
    );
  }

  const payload = (await res.json()) as {
    data?: RawImageRow[];
    images?: RawImageRow[];
    usage?: { cost?: number };
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
    const img = await rowToBytes(row, timeoutMs);
    if (img && img.bytes.length > 0) decoded.push(img);
  }
  if (decoded.length === 0) {
    throw new ImageGenError(
      'Image upstream returned rows without usable image data (no b64_json and no fetchable url).',
      'upstream',
    );
  }

  const costUsd = typeof payload.usage?.cost === 'number' ? payload.usage.cost : undefined;
  const batchId = newImageId();
  const now = new Date();
  const records: ImageRecord[] = [];

  for (const [i, img] of decoded.entries()) {
    const stored = await storeImage({
      bytes: img.bytes,
      prompt,
      config,
      declaredMime: img.mime,
      outputFormat: specs.output_format,
      now,
    });

    const linkedTo: string[] = [];
    if (input.saveTo) {
      try {
        linkedTo.push(await linkImage(stored.path, input.saveTo));
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

    const record: ImageRecord = {
      id: newImageId(),
      createdAt: now.toISOString(),
      prompt,
      modelName: entry.name,
      modelId: entry.model,
      provider: providerName,
      specs,
      path: stored.path,
      filename: stored.filename,
      mime: stored.mime,
      bytes: stored.bytes,
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

  return { images: records, ...(costUsd !== undefined ? { costUsd } : {}) };
}
