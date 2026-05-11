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
// Models are cached under HF_HOME (default ~/.cache/huggingface). First
// call downloads, subsequent calls are local-only.

import type { MemoryConfig } from '../config/types.ts';
import { logger } from '../server/logger.ts';

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
  cachedLocal = await createLocalProvider(cfg.model);
  cachedLocalKey = key;
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

  // Override env.fetch with an undici-backed fetch that disables the
  // 5-minute body/headers timeouts. Defaults are fine for all-MiniLM-L6-v2
  // (~30MB) on a normal link, but a larger model (e.g. embeddinggemma-300m
  // ~300MB) or a slow connection would hit undici's 5-min cliff and abort
  // mid-download. The HF lib only downloads on cache-miss, so this matters
  // exactly once per (machine, model) pair — but when it matters, it must
  // not fail. See DECISIONS #47 for the rest of the HTTPS-timeout sweep.
  const { Agent, fetch: undiciFetch } = await import('undici');
  const patientAgent = new Agent({
    bodyTimeout: 0,
    headersTimeout: 0,
    connectTimeout: 30_000,
  });
  env.fetch = ((input: string | URL, init?: unknown) =>
    undiciFetch(input as never, { ...(init as object), dispatcher: patientAgent } as never)) as typeof env.fetch;

  const repoId = resolveModelRepoId(modelName);
  logger.info({ msg: 'memory.embedding_load_start', model: modelName, repoId });
  const start = Date.now();
  const extractor = await pipeline('feature-extraction', repoId);
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
