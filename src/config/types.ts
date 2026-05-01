// Server config schema. Lives at ~/.somora/config.yaml (override via SOMORA_HOME).
// Engines are the protocol adapters (claude-cli, openai-compatible).
// Providers are concrete instances of an engine with baseUrl/apiKey and a model list.
// Personas reference models as `<provider>/<modelId>`.

import { z } from 'zod';

export const ModelCapabilitySchema = z.enum(['text', 'image']);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const ModelSchema = z.object({
  id: z.string().min(1),
  /**
   * Optional shorthand. Must be globally unique across the whole config.
   * Lets you write `model: opus` in a persona instead of
   * `model: anthropic/claude-opus-4-7`.
   */
  alias: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, 'alias must match [A-Za-z0-9_-]+')
    .optional(),
  contextWindow: z.number().int().positive(),
  capabilities: z.array(ModelCapabilitySchema).default(['text']),
  maxTokens: z.number().int().positive().optional(),
});
export type Model = z.infer<typeof ModelSchema>;

export const ClaudeCliProviderSchema = z.object({
  engine: z.literal('claude-cli'),
  models: z.array(ModelSchema).min(1),
});

// codex-cli: auth handled by the binary itself via `codex login`
// (ChatGPT subscription preferred) or OPENAI_API_KEY env. No baseUrl /
// apiKey here — they would do nothing.
export const CodexCliProviderSchema = z.object({
  engine: z.literal('codex-cli'),
  models: z.array(ModelSchema).min(1),
});

export const OpenAiCompatibleProviderSchema = z.object({
  engine: z.literal('openai-compatible'),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  models: z.array(ModelSchema).min(1),
});

export const ProviderSchema = z.discriminatedUnion('engine', [
  ClaudeCliProviderSchema,
  CodexCliProviderSchema,
  OpenAiCompatibleProviderSchema,
]);
export type Provider = z.infer<typeof ProviderSchema>;
export type EngineName = Provider['engine'];

export const CompactionConfigSchema = z
  .object({
    /** Fraction of contextWindow at which compaction triggers (0..1). Default 0.8. */
    triggerRatio: z.number().positive().max(1).optional(),
    /** Recent user/assistant pairs that stay uncompacted. Default 4. */
    safetyCushionPairs: z.number().int().nonnegative().optional(),
    /** Optional override for the worker model (alias or `provider/modelId`). */
    modelOverride: z.string().min(1).optional(),
  })
  .optional();
export type CompactionConfigSchema = z.infer<typeof CompactionConfigSchema>;

// Memory-Layer config (DECISIONS #25–#27). All optional with sensible defaults.
// Per-agent overrides may live in agent.yaml later. (Phase 2-Stufe-B)
export const MemoryEmbeddingConfigSchema = z.object({
  /** Embedding provider. 'local' uses @huggingface/transformers (ONNX); remote providers TBD. */
  provider: z.enum(['local', 'openai', 'gemini', 'mistral', 'ollama']).default('local'),
  /** Model identifier — semantics depend on provider. For 'local': HF Hub repo or alias. */
  model: z.string().min(1).default('all-MiniLM-L6-v2'),
}).default({ provider: 'local', model: 'all-MiniLM-L6-v2' });

export const MemoryChunkingConfigSchema = z.object({
  targetTokens: z.number().int().positive().default(400),
  overlapTokens: z.number().int().nonnegative().default(80),
}).default({ targetTokens: 400, overlapTokens: 80 });

export const MemoryAutoInjectConfigSchema = z.object({
  /** How many last conversation turns feed the embedding query. */
  queryTurns: z.number().int().positive().default(3),
  /** Top-N matches injected per turn. */
  maxResults: z.number().int().positive().default(5),
  /** Discard matches below this hybrid score (0..1). */
  minScore: z.number().min(0).max(1).default(0.5),
  /** Hard cap on tokens of the injected memory block (Heuristik 4 chars/token). */
  maxTokens: z.number().int().positive().default(1500),
}).default({ queryTurns: 3, maxResults: 5, minScore: 0.5, maxTokens: 1500 });

export const MemoryHybridConfigSchema = z.object({
  vectorWeight: z.number().min(0).max(1).default(0.7),
  bm25Weight: z.number().min(0).max(1).default(0.3),
}).default({ vectorWeight: 0.7, bm25Weight: 0.3 });

export const MemoryConfigSchema = z.object({
  embedding: MemoryEmbeddingConfigSchema,
  chunking: MemoryChunkingConfigSchema,
  autoInject: MemoryAutoInjectConfigSchema,
  hybrid: MemoryHybridConfigSchema,
}).default({
  embedding: { provider: 'local', model: 'all-MiniLM-L6-v2' },
  chunking: { targetTokens: 400, overlapTokens: 80 },
  autoInject: { queryTurns: 3, maxResults: 5, minScore: 0.5, maxTokens: 1500 },
  hybrid: { vectorWeight: 0.7, bm25Weight: 0.3 },
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

// Agent-loop tunables for engines that run their own tool-call loop
// (currently only openai-compatible — Phase 2-Stufe-C). claude-cli and
// codex-cli have their own internal loops and ignore these values.
export const AgentLoopConfigSchema = z.object({
  /**
   * Max tool-call rounds per turn. The vast majority of conversations
   * finish in 1-3 rounds; this is a defensive cap that prevents a confused
   * or adversarial model from looping forever. Most agent frameworks
   * default to 10-25; we pick 8 for somora since memory tools are
   * narrow and a higher cap rarely helps.
   */
  maxRounds: z.number().int().positive().max(100).default(8),
  /**
   * Per-tool-call timeout in milliseconds. If a single tool invocation
   * exceeds this, we cancel it and feed an error back to the model.
   * memory_* tools are fast (~1s); the cap is mostly insurance against
   * future slow tools (web fetch, large file reads, etc.) that hang.
   */
  toolCallTimeoutMs: z.number().int().positive().default(30_000),
}).default({ maxRounds: 8, toolCallTimeoutMs: 30_000 });
export type AgentLoopConfig = z.infer<typeof AgentLoopConfigSchema>;

export const ConfigSchema = z.object({
  server: z
    .object({
      port: z.number().int().positive().default(18737),
    })
    .default({ port: 18737 }),
  providers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), ProviderSchema),
  compaction: CompactionConfigSchema,
  memory: MemoryConfigSchema,
  agentLoop: AgentLoopConfigSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

// A resolved (provider, model) pair — what the engine adapter receives at turn time.
export interface ResolvedModel {
  providerName: string;
  provider: Provider;
  modelId: string;
  model: Model;
}

export function resolveModelRef(config: Config, ref: string): ResolvedModel | null {
  const slash = ref.indexOf('/');
  if (slash < 0) return null;
  const providerName = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const provider = config.providers[providerName];
  if (!provider) return null;
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) return null;
  return { providerName, provider, modelId, model };
}

/**
 * Resolve a string ref to a model. Tries (in order): alias → provider/id → bare id.
 * Aliases are global and take precedence; bare ids are backwards-compat for older
 * AGENTS.md files written before the provider/id format existed.
 */
export function resolveAnyRef(config: Config, ref: string): ResolvedModel | null {
  // 1. alias lookup (global unique)
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      if (model.alias === ref) {
        return { providerName, provider, modelId: model.id, model };
      }
    }
  }
  // 2. provider/modelId
  if (ref.includes('/')) return resolveModelRef(config, ref);
  // 3. bare modelId (backwards-compat)
  for (const [providerName, provider] of Object.entries(config.providers)) {
    const model = provider.models.find((m) => m.id === ref);
    if (model) return { providerName, provider, modelId: ref, model };
  }
  return null;
}

/**
 * Enumerate every (provider, model) pair in the config as a ResolvedModel.
 * Used by compaction to pick a worker model with appropriate context
 * window (DECISION #21a) — independent of which model the current
 * turn is on.
 */
export function listAllModels(config: Config): ResolvedModel[] {
  const list: ResolvedModel[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      list.push({ providerName, provider, modelId: model.id, model });
    }
  }
  return list;
}

/**
 * Walks the config and asserts that no alias is shared by two models.
 * Throws with a descriptive error if duplicates are found.
 */
export function assertUniqueAliases(config: Config): void {
  const seen = new Map<string, string>();
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      if (!model.alias) continue;
      const previous = seen.get(model.alias);
      const here = `${providerName}/${model.id}`;
      if (previous) {
        throw new Error(`alias '${model.alias}' is used by both '${previous}' and '${here}' — aliases must be globally unique`);
      }
      seen.set(model.alias, here);
    }
  }
}
