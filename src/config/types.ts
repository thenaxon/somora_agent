// Server config schema. Lives at ~/.somora/config.yaml (override via SOMORA_HOME).
// Engines are the protocol adapters (claude-cli, openai-compatible).
// Providers are concrete instances of an engine with baseUrl/apiKey and a model list.
// Personas reference models as `<provider>/<modelId>`.

import { z } from 'zod';

// Model capabilities. `text` is universal. `image` enables Vision (image
// content blocks). `pdf` enables PDF document content blocks (Anthropic
// natively, OpenAI via file-API; most local OMX models lack it). The
// runtime gates `file_read` on these — agent gets a clear error when
// it tries to read media a model can't process. `reasoning` enables
// per-engine "thinking" effort levels.
export const ModelCapabilitySchema = z.enum(['text', 'image', 'pdf', 'reasoning']);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

// Cross-engine "thinking" knob. Values map per-engine in each adapter:
//   claude-cli         → SDK `effort: 'low'|'medium'|'high'` (or thinking: disabled)
//   codex-cli          → -c model_reasoning_effort=<level>
//   openai-compatible  → reasoning_effort: <level>
// 'off' disables thinking entirely; the level otherwise guides depth.
// Only applied when the model has the 'reasoning' capability — otherwise
// the setting is dormant (header surfaces this honestly).
export const ThinkingLevelSchema = z.enum(['off', 'low', 'medium', 'high']);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

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
  /**
   * Where the per-turn memory recall block lands in the prompt sent to
   * the backend. The choice matters because openai-compatible can sit
   * in front of any backend (mlx-omx, ollama, vLLM, OpenAI itself,
   * llama.cpp gateways, ...) and prefix-cache support varies.
   *
   * - `inline-user` (default): the memory block is persisted on each
   *   `user_message` JSONL event (`ephemeral` field), and rebuilt
   *   into the user-message content on every history reconstruction.
   *   The byte sequence at turn N+1 matches what was sent at turn N
   *   for the entire prior conversation, so prefix-cache holds across
   *   the whole history. Memory still updates per turn — only the
   *   LATEST user message has a freshly-computed block; older turns
   *   keep the block they had at their original send time.
   *
   * - `system`: legacy — concat the memory block onto the persistent
   *   system prompt. Cache-destructive (system block changes every
   *   turn) but maximally compatible with backends that mishandle
   *   embedded memory inside user-message content. Opt-in fallback.
   *
   * claude-cli + codex-cli intentionally don't carry this field —
   * claude-cli's backend is always Anthropic so we hardcode
   * inline-user there (claude-agent-sdk has no multi-system escape),
   * and codex-cli's stdin payload structure puts memory in the right
   * place by construction.
   */
  memoryInjectMode: z
    .enum(['inline-user', 'system'])
    .default('inline-user')
    .optional(),
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
// codex-cli have their own internal loops and ignore these values for
// the per-tool-call race; the long-task fields ALSO inform CLI-engine
// tools (subagent_result, agent_ask) which run inside MCP children.
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
   * Per-tool-call timeout in milliseconds for FAST tools that don't
   * declare their own (memory_search, web_fetch, time_now, file_read,
   * obsidian_*). 30s is plenty for everything that hits a local DB,
   * reads a file, or does a single HTTP round-trip. Tools that legitimately
   * take longer (subagent_result with wait_until_done, agent_ask, exec)
   * declare their own timeouts via ToolDefinition.timeoutFromInput +
   * maxTimeoutMs (DECISION #37) and use longTask*TimeoutMs below.
   */
  toolCallTimeoutMs: z.number().int().positive().default(30_000),
  /**
   * DEFAULT timeout for SLOW Agent-to-Agent tools when the caller doesn't
   * specify timeout_ms (subagent_result wait_until_done, agent_ask).
   * Local models (gemma4big via mlx-omx, ollama) routinely need several
   * minutes for a single turn — this default needs to be generous so
   * agents don't have to adapt with retries on every call. 5 min is the
   * "first checkpoint": when this elapses the tool returns
   * state: "pending" (NOT an error), the sub keeps running, and the
   * caller can retry with a higher timeout_ms or check status later
   * (DECISION #37 pending-pattern). Honest "I'm still working" beats
   * a fake error every time.
   */
  longTaskDefaultTimeoutMs: z.number().int().positive().default(300_000),
  /**
   * MAX timeout the caller can pass for slow Agent-to-Agent tools, even
   * with an explicit timeout_ms. Hard ceiling for a single tool-call
   * blocking — the underlying sub-task itself runs unbounded in the
   * background (capped only by its own agentLoop.maxRounds), so this
   * really just bounds how long a single subagent_result or agent_ask
   * call sits open. 30 min covers any realistic local-model workload;
   * raise if you have an exceptionally slow setup (CPU-only inference,
   * huge models). claudeCli.mcpToolTimeoutMs and codexCli.toolTimeoutSec
   * MUST be ≥ this value, otherwise the CLI's MCP layer will cut us off
   * before our own ceiling kicks in.
   */
  longTaskMaxTimeoutMs: z.number().int().positive().default(1_800_000),
  /**
   * Max concurrent background exec jobs PER agent. Prevents runaway
   * loops where a confused model fires off dozens of `exec` calls
   * with background:true and floods the host. 8 is the rough sweet
   * spot — tight enough to catch obvious mistakes, loose enough that
   * legitimate parallel-build / parallel-test patterns aren't blocked.
   * Counts both local AND remote background jobs against the same
   * cap (the host's resources are what we're protecting; whether the
   * load lands on the somora server or on spiderman doesn't change
   * the basic "don't go nuts" intent).
   */
  execMaxConcurrentPerAgent: z.number().int().positive().default(8),
  /**
   * Server-wide cap across ALL agents. Multiple agents collectively
   * still shouldn't be allowed to spawn 100 background processes.
   * 32 is generous (4 agents × 8 each), enough headroom for normal
   * multi-agent operation while still preventing a runaway scenario.
   */
  execMaxConcurrentGlobal: z.number().int().positive().default(32),
}).default({
  maxRounds: 8,
  toolCallTimeoutMs: 30_000,
  longTaskDefaultTimeoutMs: 300_000,
  longTaskMaxTimeoutMs: 1_800_000,
  execMaxConcurrentPerAgent: 8,
  execMaxConcurrentGlobal: 32,
});
export type AgentLoopConfig = z.infer<typeof AgentLoopConfigSchema>;

// claude-cli engine tunables. Mostly thin wrappers over claude-agent-sdk
// env vars — surfaced here so they're visible/editable in config.yaml
// instead of hidden as undocumented env overrides. Applied at server boot
// via applyClaudeCliSdkEnv() (config wins unless the env var was already
// set explicitly — explicit env always wins as the override layer).
export const ClaudeCliConfigSchema = z
  .object({
    /**
     * Per-MCP-tool-call timeout (ms). Maps to MCP_TOOL_TIMEOUT in the
     * claude-agent-sdk subprocess. The SDK's hidden default is 5 min
     * (300_000) — way too short for slow local models. We default to
     * 30 min to match agentLoop.longTaskMaxTimeoutMs so the CLI's MCP
     * layer never cuts off a long-blocking tool call before our own
     * ceiling does. Raise both together if you need more, lower
     * mcpToolTimeoutMs for fail-fast behavior on a fast setup.
     */
    mcpToolTimeoutMs: z.number().int().positive().default(1_800_000),
    /**
     * Initial MCP server connect timeout (ms). Maps to MCP_TIMEOUT.
     * Affects only server startup handshake, not running calls.
     */
    mcpConnectTimeoutMs: z.number().int().positive().default(60_000),
  })
  .default({ mcpToolTimeoutMs: 1_800_000, mcpConnectTimeoutMs: 60_000 });
export type ClaudeCliConfig = z.infer<typeof ClaudeCliConfigSchema>;

// codex-cli engine tunables. Same posture as claudeCli — surface
// codex-internal limits in config.yaml so they're visible/editable.
// Applied via -c TOML overrides on each `codex exec` invocation by
// somoraMemoryCodexFlags() in src/mcp/config.ts.
export const CodexCliConfigSchema = z
  .object({
    /**
     * Per-MCP-tool-call timeout in seconds. Codex's hidden default is
     * 60s (`tool_timeout_sec`) — way too short for slow local models.
     * Maps to `mcp_servers.somora-memory.tool_timeout_sec` in codex's
     * TOML. Default 1800s (30 min) matches claudeCli.mcpToolTimeoutMs
     * and agentLoop.longTaskMaxTimeoutMs so the CLI's MCP layer never
     * cuts off a long-blocking tool call before our own ceiling does.
     */
    toolTimeoutSec: z.number().int().positive().default(1800),
  })
  .default({ toolTimeoutSec: 1800 });
export type CodexCliConfig = z.infer<typeof CodexCliConfigSchema>;

// Workspace — default cwd for the file_* tools. NOT a sandbox: agents
// can also write outside the workspace (their own persona files, the
// global config) — protection comes from a path-blacklist in the file
// tools themselves, not from confinement here. Per-agent override lives
// in agent.yaml under `workspace.path`. The path is auto-created
// (mkdir -p) at server start; ~ expands to $HOME.
export const WorkspaceConfigSchema = z
  .object({
    default: z.string().min(1).default('~/somoraworkspace'),
  })
  .default({ default: '~/somoraworkspace' });
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// Resources — named SSH targets that file_* and exec tools can act on
// via a `target` parameter. SSH-only for v1; the discriminated union
// is set up so we can add other transport types later (Docker host,
// k8s pod, ...) without breaking existing entries.
export const SshResourceSchema = z.object({
  type: z.literal('ssh'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  /**
   * Path to the private key file ON THE SOMORA SERVER. ~ expands. The
   * key is loaded once at first connection and held in memory for the
   * pool's lifetime — tools never see it.
   */
  keyPath: z.string().min(1),
  /**
   * Free-form description shown to the agent via resource_list so it
   * knows what each target is for. Multi-line OK.
   */
  description: z.string().optional(),
  /**
   * Default working directory on the remote. Used when file_* tools
   * are called with a relative path against this resource. Falls back
   * to the user's home dir on the remote if unset.
   */
  workspace: z.string().optional(),
  /**
   * Optional SHA256 host-key fingerprint for strict verification.
   * Format: 'sha256:<base64>'. When set, mismatches refuse connection.
   * When unset → TOFU: first connection accepts any key and pins it
   * to ~/.somora/known_hosts; subsequent connections enforce the pin.
   */
  hostKey: z.string().optional(),
});
export type SshResource = z.infer<typeof SshResourceSchema>;

export const ResourceSchema = z.discriminatedUnion('type', [SshResourceSchema]);
export type Resource = z.infer<typeof ResourceSchema>;

export const ResourcesConfigSchema = z
  .record(
    z.string().regex(/^[A-Za-z0-9_-]+$/, 'resource name must match [A-Za-z0-9_-]+'),
    ResourceSchema,
  )
  .default({});
export type ResourcesConfig = z.infer<typeof ResourcesConfigSchema>;

// Web tools — provider credentials. Each tool reads its own slice; if a
// provider block isn't configured the corresponding tool's `available()`
// probe returns false and the model never sees it.
export const WebConfigSchema = z
  .object({
    brave: z
      .object({
        apiKey: z.string().min(1),
      })
      .optional(),
  })
  .default({});
export type WebConfig = z.infer<typeof WebConfigSchema>;

// TUI display preferences. Only affect what the Ink CLI renders into the
// scrollback — never affect actual memory injection or tool execution
// (those still happen on the server).
//
// `show.*`     — line visibility (off = the row doesn't appear at all)
// `verbose.*`  — detail level when the row IS shown (off = compact summary,
//                on = full payload / inject text / system prompt)
//
// Both are TUI-side display state; the server emits enough data for the
// "verbose" form on every event so toggling is instant. Live-changeable
// via `/show <topic> on|off` and `/verbose <topic> on|off`.
export const TuiConfigSchema = z.object({
  show: z.object({
    memory: z.boolean().default(true),
    tools: z.boolean().default(true),
  }).default({ memory: true, tools: true }),
  verbose: z.object({
    tools: z.boolean().default(false),
    memory: z.boolean().default(false),
    system: z.boolean().default(false),
  }).default({ tools: false, memory: false, system: false }),
}).default({
  show: { memory: true, tools: true },
  verbose: { tools: false, memory: false, system: false },
});
export type TuiConfig = z.infer<typeof TuiConfigSchema>;

// Vision/multimodal worker config. Two tools route through this:
//   - file_read polymorph (for the active main model, when it has the
//     right capability — content blocks land directly in main context)
//   - analyze_file (always dispatches to a separate worker model via
//     openai-compatible API, returns the worker's text description)
//
// `worker` is the default for both image and PDF dispatch. `pdfWorker`
// is an optional override for PDF specifically (use case: cheap haiku
// for image triage but a stronger model for PDF reasoning, à la
// OpenClaw's `pdfModel ≠ imageModel` distinction). When unset, PDF
// falls back to `worker`. When `worker` itself is unset, analyze_file
// returns a clear error at call time — no silent degradation.
//
// v1 constraint: workers must be openai-compatible (proxied via
// openrouter etc. for Claude). Direct Anthropic SDK as worker is
// future work — same constraint as Dream-Mode. See
// `private/skills-design.md` and the dream-mode docs for the rationale.
export const VisionConfigSchema = z
  .object({
    /** Default worker for image + PDF analysis. Format `<provider>/<modelId>`.
     *  Worker model MUST have `image` capability; PDF use also requires
     *  `pdf` capability (or set `pdfWorker` to a separate model that has it). */
    worker: z.string().min(1).optional(),
    /** Optional override for PDF dispatch only. Format `<provider>/<modelId>`.
     *  When unset, PDF falls back to `worker`. Use case: cheap image-only
     *  worker + a separate PDF-capable worker for cost control. */
    pdfWorker: z.string().min(1).optional(),
  })
  .default({});
export type VisionConfig = z.infer<typeof VisionConfigSchema>;

// Skills budget. Mirrors OpenClaw's defaults — they've shipped 53 real
// skills against these limits for months, so we treat them as known-
// good rather than re-deriving. Configurable via config.yaml per
// `feedback_config_over_env.md`. See `private/skills-design.md`.
export const SkillsConfigSchema = z
  .object({
    /** Hard cap on number of skills surfaced in the system-prompt
     *  registry. Beyond this, the registry-renderer falls back to
     *  compact format (name+description only). */
    maxSkillsInPrompt: z.number().int().positive().default(150),
    /** Char budget for the rendered registry block. Compact-format
     *  fallback kicks in if XML rendering would exceed this. */
    maxPromptChars: z.number().int().positive().default(18_000),
    /** Per-file size limit for SKILL.md when activated via the Skill
     *  tool. Skills with larger bodies fail to load with an error. */
    maxSkillFileBytes: z.number().int().positive().default(256_000),
  })
  .default({
    maxSkillsInPrompt: 150,
    maxPromptChars: 18_000,
    maxSkillFileBytes: 256_000,
  });

// Wiki-System (Phase 4) — long-term shared knowledge in an Obsidian
// vault subfolder, written by Dream-B, audited by Dream-C/Lint, read
// by all agents. See `private/wiki-design.md` for the full design.
//
// `enabled: false` is the default so existing setups don't change
// behavior until the operator opts in.
export const WikiPromotionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Real-clock cadence for Dream-B (memory → wiki promotion). */
    intervalHours: z.number().positive().default(12),
    /** How long before each Dream-B run to forcibly run Dream-A on
     *  any agent with un-processed sessions. Zero disables sweep. */
    preSweepMinutes: z.number().nonnegative().default(60),
    /** Worker model for Dream-B. Format `<provider>/<modelId>`. */
    model: z.string().min(1).optional(),
    /** Dream-B auto-applies (no approval). Reserved as bool in case
     *  we ever need to flip back on. */
    requireApproval: z.boolean().default(false),
  })
  .default({
    enabled: true,
    intervalHours: 12,
    preSweepMinutes: 60,
    requireApproval: false,
  });

export const WikiLintConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalDays: z.number().positive().default(7),
    /** Worker model for Dream-C / Lint. */
    model: z.string().min(1).optional(),
    /** Lint findings need user approval before wiki-edits apply. */
    requireApproval: z.boolean().default(true),
    /** Which agent's chat surfaces the lint findings. */
    approvalAgent: z.string().min(1).default('hans'),
  })
  .default({
    enabled: true,
    intervalDays: 7,
    requireApproval: true,
    approvalAgent: 'hans',
  });

export const WikiSearchConfigSchema = z
  .object({
    /** Score multipliers applied to vector-similarity before top-k cut.
     *  Higher = ranked first. */
    boostWiki: z.number().positive().default(1.0),
    boostMemory: z.number().positive().default(0.85),
    boostVault: z.number().positive().default(0.65),
    /** Max chars of the auto-injected wiki-overview block (verkürzte
     *  index.md). Larger overviews would invalidate prompt-cache too
     *  often. */
    overviewMaxChars: z.number().int().positive().default(1500),
    /** Top-N most-referenced slugs to list in the overview when wiki
     *  grows past overviewMaxChars. */
    overviewTopNSlugs: z.number().int().positive().default(30),
  })
  .default({
    boostWiki: 1.0,
    boostMemory: 0.85,
    boostVault: 0.65,
    overviewMaxChars: 1500,
    overviewTopNSlugs: 30,
  });

export const WikiConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Path relative to each agent's vault root where the somora wiki
     *  lives. Dream-B writes here; everything else in the vault is
     *  read-only for somora. */
    vaultSubfolder: z.string().min(1).default('somora'),
    /** Subdirs Dream-B uses by default. New subdirs may be created
     *  on demand when topics don't fit. */
    defaultSubdirs: z.array(z.string().min(1)).default(['personen', 'projekte', 'wissen']),
    promotion: WikiPromotionConfigSchema,
    lint: WikiLintConfigSchema,
    search: WikiSearchConfigSchema,
  })
  .default({
    enabled: false,
    vaultSubfolder: 'somora',
    defaultSubdirs: ['personen', 'projekte', 'wissen'],
    promotion: {
      enabled: true,
      intervalHours: 12,
      preSweepMinutes: 60,
      requireApproval: false,
    },
    lint: {
      enabled: true,
      intervalDays: 7,
      requireApproval: true,
      approvalAgent: 'hans',
    },
    search: {
      boostWiki: 1.0,
      boostMemory: 0.85,
      boostVault: 0.65,
      overviewMaxChars: 1500,
      overviewTopNSlugs: 30,
    },
  });
export type WikiConfig = z.infer<typeof WikiConfigSchema>;

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
  claudeCli: ClaudeCliConfigSchema,
  codexCli: CodexCliConfigSchema,
  tui: TuiConfigSchema,
  web: WebConfigSchema,
  workspace: WorkspaceConfigSchema,
  resources: ResourcesConfigSchema,
  skills: SkillsConfigSchema,
  vision: VisionConfigSchema,
  wiki: WikiConfigSchema,
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
