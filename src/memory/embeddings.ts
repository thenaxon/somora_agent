// Embedding provider. Default = local via @huggingface/transformers (ONNX
// runtime, no native llama.cpp build, no GPU required). Wraps any embedding
// model into the same `embed(texts: string[]) → Float32Array[]` interface,
// so swapping to remote providers (OpenAI, Gemini, …) later is a one-file
// change.
//
// Why @huggingface/transformers and not node-llama-cpp:
//   - smaller download (~30MB for all-MiniLM-L6-v2 vs hundreds of MB for GGUF)
//   - no native build step (uses prebuilt onnxruntime-node binaries)
//   - sufficient for synonym-style recall (DECISION #26)
//   - swappable: if a stronger embedding model is desired later
//     (e.g., embeddinggemma-300m), a local-llama-cpp provider drops in
//     without touching consumers
//
// Models are cached under a STABLE, install-independent directory
// (`<SOMORA_HOME>/models/transformers/`) — NOT the transformers.js
// default of a package-local `.cache/` inside node_modules, which every
// `npm install -g` / `somora update` wipes (forcing a flaky re-download
// after each deploy). See createLocalProvider. First call downloads once
// per machine; every later call + every future update is local-only.

import { join } from 'node:path';

import type { MemoryConfig } from '../config/types.ts';
import { logger, SOMORA_HOME_DIR } from '../server/logger.ts';

export interface EmbeddingProvider {
  /** Human-readable model identifier — gets persisted in memory.db meta. */
  readonly name: string;
  /** Output vector dimension. */
  readonly dim: number;
  /** Embed a batch of texts. Returns one Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

let cachedLocal: EmbeddingProvider | null = null;
let cachedLocalKey: string | null = null;

/**
 * Process-wide embedder health, surfaced on `GET /health` as
 * `memoryEmbedder`. Exists because a broken embedder is otherwise
 * invisible: every agent silently degrades to FTS-only retrieval and the
 * only trace is a `warn` line per search. Six weeks of that went unnoticed
 * on a fresh install (2026-09-07 report) — a red field in /health is the
 * canary that would have caught it on day one.
 */
export interface EmbedderStatus {
  /** `ok` = model loaded; `failed` = last load attempt threw (memory is
   *  FTS-only until the next retry succeeds); `loading` = attempt in
   *  flight; `idle` = never attempted (memory not used yet). */
  state: 'idle' | 'loading' | 'ok' | 'failed';
  provider: string | null;
  model: string | null;
  dim: number | null;
  /** Last load error, verbatim. Cleared on success. */
  error: string | null;
  /** Epoch ms of the state's last transition. */
  since: number | null;
  /** Load attempts (successful or not) since process start. */
  attempts: number;
  /** Load time of the current model in ms; null unless `ok`. */
  loadMs: number | null;
}

const status: EmbedderStatus = {
  state: 'idle',
  provider: null,
  model: null,
  dim: null,
  error: null,
  since: null,
  attempts: 0,
  loadMs: null,
};

export function getEmbedderStatus(): EmbedderStatus {
  return { ...status };
}

/**
 * Load the embedder once at server boot so a broken model path is
 * reported LOUDLY (one `error` line) instead of surfacing as a throttled
 * `warn` per agent per minute after the first chat turn. The provider is
 * cached, so the later per-agent `ensureEmbedder()` calls are free.
 * Never throws — boot must not depend on the model download.
 */
export async function warmupEmbedder(cfg: MemoryConfig['embedding']): Promise<void> {
  try {
    await resolveEmbeddingProvider(cfg);
  } catch (err) {
    logger.error({
      msg: 'memory.embedder_boot_failed',
      provider: cfg.provider,
      model: cfg.model,
      err: (err as Error).message,
      hint: 'memory retrieval is FTS-only on every agent until this is fixed; check GET /health → memoryEmbedder',
    });
  }
}

/**
 * Resolve the configured embedding provider. Caches the local provider
 * across calls so we don't reload the model per invocation.
 */
export async function resolveEmbeddingProvider(
  cfg: MemoryConfig['embedding'],
): Promise<EmbeddingProvider> {
  if (cfg.provider !== 'local') {
    throw new Error(
      `embedding provider '${cfg.provider}' not yet implemented — only 'local' is wired up so far`,
    );
  }
  const key = `local:${cfg.model}`;
  if (cachedLocal && cachedLocalKey === key) return cachedLocal;
  status.attempts++;
  status.state = 'loading';
  status.provider = cfg.provider;
  status.model = cfg.model;
  status.since = Date.now();
  const start = Date.now();
  try {
    cachedLocal = await createLocalProvider(cfg.model);
  } catch (err) {
    status.state = 'failed';
    status.error = (err as Error).message;
    status.since = Date.now();
    status.dim = null;
    status.loadMs = null;
    throw err;
  }
  cachedLocalKey = key;
  status.state = 'ok';
  status.error = null;
  status.dim = cachedLocal.dim;
  status.loadMs = Date.now() - start;
  status.since = Date.now();
  return cachedLocal;
}

/**
 * Map a configured model name to a HF Hub repo id. We accept friendly
 * shorthands and hub-paths interchangeably. Aliases are limited to
 * verified-working repos; unknown shorthands fall through to `Xenova/<name>`
 * (which may or may not resolve — user gets a clear download error).
 */
function resolveModelRepoId(modelName: string): string {
  if (modelName.includes('/')) return modelName;
  const aliases: Record<string, string> = {
    'all-MiniLM-L6-v2': 'Xenova/all-MiniLM-L6-v2',
    'all-mpnet-base-v2': 'Xenova/all-mpnet-base-v2',
    'paraphrase-multilingual-MiniLM-L12-v2': 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  };
  return aliases[modelName] ?? `Xenova/${modelName}`;
}

async function createLocalProvider(modelName: string): Promise<EmbeddingProvider> {
  // Lazy import — pulling @huggingface/transformers on every server start
  // adds ~80ms even when memory isn't in use.
  const { pipeline, env } = await import('@huggingface/transformers');

  // Override env.fetch with a dispatcher that disables the 5-minute
  // body/headers timeouts. Defaults are fine for all-MiniLM-L6-v2 (~30MB)
  // on a normal link, but a larger model (e.g. embeddinggemma-300m ~300MB)
  // or a slow connection would hit undici's 5-min cliff and abort
  // mid-download. The HF lib only downloads on cache-miss, so this matters
  // exactly once per (machine, model) pair — but when it matters, it must
  // not fail. See DECISIONS #47 for the rest of the HTTPS-timeout sweep.
  //
  // The response MUST satisfy `instanceof globalThis.Response` AT THE TIME
  // transformers.js checks it (loadResourceFile → toCacheResponse). If it
  // doesn't, the download succeeds (HTTP 200) but the file is never
  // written to the cache and the load fails with the opaque "Unable to
  // get model file path or buffer." Two things break that check in this
  // process, and every fresh install between 2026.05.11 and 2026.09.07
  // hit them and silently ran FTS-only:
  //   1. `undici.fetch` from the package returns the package's own
  //      Response class, not Node's built-in one. (Node's global fetch
  //      accepts an undici `dispatcher` in RequestInit, so the timeout
  //      override doesn't need the package's fetch at all.)
  //   2. @hono/node-server's serve() replaces `globalThis.Response` with
  //      its lightweight subclass (overrideGlobalObjects, default on).
  //      From then on even a NATIVE fetch response is no longer an
  //      instance of the global class — so this fails inside the server
  //      while a standalone repro script passes.
  // Hence: use the global fetch, then re-wrap the response into whatever
  // `globalThis.Response` currently is unless it already is one. Both
  // classes delegate body/headers/arrayBuffer to the native object, so
  // the download stream is untouched.
  const { Agent } = await import('undici');
  const patientAgent = new Agent({
    bodyTimeout: 0,
    headersTimeout: 0,
    connectTimeout: 30_000,
  });
  env.fetch = (async (input: string | URL, init?: unknown) => {
    const r: Response = await globalThis.fetch(input as never, {
      ...(init as object),
      dispatcher: patientAgent,
    } as never);
    // (Cast: TS narrows `r` to `never` in the else-branch otherwise, since
    // it doesn't know the global class can be swapped at runtime.)
    if ((r as object) instanceof globalThis.Response) return r;
    return new globalThis.Response(r.body, {
      status: r.status,
      statusText: r.statusText,
      headers: r.headers,
    });
  }) as typeof env.fetch;

  // Pin the model cache to a stable, install-independent directory.
  // transformers.js otherwise caches into a package-local `.cache/` inside
  // node_modules, which `npm install -g` / `somora update` replace
  // wholesale on every deploy — so the model re-downloads after each
  // update and, when that download flakes, every agent's memory silently
  // drops to FTS-only ("Unable to get model file path or buffer"). A path
  // under SOMORA_HOME survives updates and is shared by every agent on the
  // instance: one download per machine, not one per deploy.
  env.cacheDir = join(SOMORA_HOME_DIR, 'models', 'transformers');

  const repoId = resolveModelRepoId(modelName);
  logger.info({ msg: 'memory.embedding_load_start', model: modelName, repoId });
  const start = Date.now();
  let extractor: Awaited<ReturnType<typeof pipeline<'feature-extraction'>>>;
  try {
    extractor = await pipeline('feature-extraction', repoId);
  } catch (err) {
    // transformers.js swallows the real cause behind one generic message
    // (it applies to both "download failed" and "downloaded but could not
    // be cached"). Translate it into something an operator can act on.
    const m = (err as Error).message;
    if (m.includes('Unable to get model file path or buffer')) {
      throw new Error(
        `embedding model ${repoId} could not be loaded into ${env.cacheDir} (${m}). ` +
          'Either the download from huggingface.co failed (check network/proxy) or the ' +
          'downloaded file could not be written to the cache dir (check permissions/disk).',
      );
    }
    throw err;
  }
  const elapsed = Date.now() - start;
  logger.info({ msg: 'memory.embedding_load_done', model: modelName, ms: elapsed });

  // Probe dimension with a single token.
  const probe = await extractor(['probe'], { pooling: 'mean', normalize: true });
  const dim = probe.dims[probe.dims.length - 1] as number;

  return {
    name: modelName,
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      const flat = out.data as Float32Array;
      const result: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        // tolist() copies; we slice the underlying flat buffer instead
        result.push(new Float32Array(flat.buffer, flat.byteOffset + i * dim * 4, dim).slice());
      }
      return result;
    },
  };
}
