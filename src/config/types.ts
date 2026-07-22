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
   * How PDFs ride along on user-attachments via this provider.
   *   - `rasterize` (default): render PDF pages to PNG via pdf-to-img
   *     and pass them as image_url blocks. Works against every backend
   *     that supports vision (omlx, ollama, gemma, anything OpenAI-
   *     style image-capable). Pages × image-tokens cost-wise, but
   *     universally compatible.
   *   - `native`: pass the PDF as a `{type:'file', file:{file_data:
   *     'data:application/pdf;base64,…'}}` content block. Anthropic
   *     via OpenRouter and OpenAI direct accept this; most local
   *     servers (omlx, ollama) do not. Only enable when you've
   *     verified the backend behind this provider supports it.
   * claude-cli always uses native DocumentBlock (Anthropic SDK
   * supports it), codex-cli always rasterizes (its `--image` flag
   * accepts only images). The knob is intentionally limited to this
   * provider type because only here does the answer vary by the
   * concrete backend.
   */
  pdfMode: z.enum(['rasterize', 'native']).default('rasterize').optional(),
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
  /** Discard matches below this hybrid score (0..1). 0.35 lets short
   *  single-keyword queries surface wiki/vault hits where vector recall
   *  alone wouldn't put them in top-k (BM25-only floor ≈ bm25Weight * 1.0
   *  * sourceBoost). Raise to 0.5+ if auto-injection becomes too noisy. */
  minScore: z.number().min(0).max(1).default(0.35),
  /** Hard cap on tokens of the injected memory block (Heuristik 4 chars/token). */
  maxTokens: z.number().int().positive().default(1500),
}).default({ queryTurns: 3, maxResults: 5, minScore: 0.35, maxTokens: 1500 });

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
  autoInject: { queryTurns: 3, maxResults: 5, minScore: 0.35, maxTokens: 1500 },
  hybrid: { vectorWeight: 0.7, bm25Weight: 0.3 },
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

// Global REM tunables (server-wide). Per-agent REM settings (worker
// model, idle trigger, chunking) stay in agent.yaml `rem:` — this block
// is for behavior that should not vary per agent.
//
// dedup (2026-07-21, buffet's workspace-dedup report): mechanical
// post-extraction filter against already-persisted knowledge. The
// extractor prompt ALSO asks the worker model to dedupe, but small
// worker models (gemma-class) demonstrably ignore that — 26/27 findings
// in one review round were repeats. This filter is code, not a prompt:
//   - exact slug collision with an existing memory note / loaded wiki
//     page → finding is dropped before review (logged).
//   - hybrid-search similarity (memory+wiki sources) at or above
//     `similarityThreshold` → finding is KEPT but marked
//     `likely_duplicate` so the review can batch-dismiss. Similarity is
//     a judgment call, so no silent drop.
// Threshold semantics: fused hybrid score in [0,1] (see
// memory/retrieval.ts). Default 0.8 is deliberately conservative —
// ordinary "related" pages score ~0.4-0.6; only near-verbatim content
// clears 0.8. Tune down if buffet-style noise still gets through.
export const RemDedupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  similarityThreshold: z.number().min(0).max(1).default(0.8),
}).default({ enabled: true, similarityThreshold: 0.8 });

export type RemDedupConfig = z.infer<typeof RemDedupConfigSchema>;

export const RemGlobalConfigSchema = z.object({
  dedup: RemDedupConfigSchema,
}).default({ dedup: { enabled: true, similarityThreshold: 0.8 } });
export type RemGlobalConfig = z.infer<typeof RemGlobalConfigSchema>;

// Engine watchdog tunables (Phase A2 — 2026-05-14). Idle-event timeout
// per engine. If an engine produces no events for the configured
// duration mid-turn we assume the underlying subprocess died (or the
// remote HTTP call is wedged), abort, and surface a clean error so the
// per-session lock releases and the user can try again.
//
// Defaults are tuned to engine-realistic latency:
//   - claude-cli / codex-cli: 300s. Subscription-hosted, fast first
//     event; any 5min silence is a dead child, not slow thinking.
//   - openai-compatible: 1200s. Local LLMs (oMLX, ollama, vLLM) on
//     consumer hardware can legitimately take many minutes per turn,
//     especially Wan/Flux-class image pipelines or 30B+ models on
//     CPU/MPS. 20min is generous — raise per-provider if needed.
//
// Dream workers (Deep/Lucid) bypass this entirely — they run via
// src/dream/deep-llm.ts which spawns its own children with its own
// abort timing, never enters the per-session chat lock.
export const EngineWatchdogConfigSchema = z.object({
  claudeCliIdleMs: z.number().int().positive().default(300_000),
  codexCliIdleMs: z.number().int().positive().default(300_000),
  openaiCompatibleIdleMs: z.number().int().positive().default(1_200_000),
}).default({
  claudeCliIdleMs: 300_000,
  codexCliIdleMs: 300_000,
  openaiCompatibleIdleMs: 1_200_000,
});
export type EngineWatchdogConfig = z.infer<typeof EngineWatchdogConfigSchema>;

// SSE broadcast tunables. A healthy writeSSE finishes in microseconds
// (local TransformStream write). A wedged subscriber — mobile browser
// backgrounded, TCP receive window stuck at 0, half-dead TLS handshake
// — can backpressure forever without throwing. Without a budget, ONE
// stuck subscriber freezes every turn on that (agent, session). Per-
// sub timeout + parallel-write isolates clients from each other.
export const SseConfigSchema = z.object({
  /** Max wall-clock per single writeSSE before we evict the subscriber.
   *  A healthy write is µs; legitimate slow paths (network jitter, slow
   *  mobile link) finish well under 1s. Default 10 000 ms is two orders
   *  of magnitude more than a healthy write needs but still self-heals
   *  a wedged stream fast. Bug 2026-05-19 driver: iOS Safari background
   *  freeze. */
  publishTimeoutMs: z.number().int().positive().default(10_000),
  /** When true (default), broadcast events to all subscribers in
   *  parallel — one slow client never blocks the others. When false,
   *  subscribers run sequentially in insertion order (legacy behaviour;
   *  only flip this if you need strict per-subscriber send ordering for
   *  some odd integration). */
  publishParallel: z.boolean().default(true),
}).default({
  publishTimeoutMs: 10_000,
  publishParallel: true,
});
export type SseConfig = z.infer<typeof SseConfigSchema>;

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
  /**
   * Inject a short "you have tools — call them, don't narrate" block
   * into the system prompt whenever the agent has at least one tool.
   *
   * Tools reach the model through a separate API field, never through
   * the prompt text. Strong models treat that formal declaration as
   * binding; weaker local models weigh the conversation more heavily
   * and can talk themselves out of tool use (bug 2026-07-22 — see
   * src/engine/tool-trace.ts for the measured case). This block is the
   * cheap belt to that fix's braces. Constant text, so it costs one
   * cache invalidation on rollout and nothing afterwards.
   */
  toolUsageReminder: z.boolean().default(true),
}).default({
  maxRounds: 8,
  toolUsageReminder: true,
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
    /**
     * Shared-login self-healing. When true (default), somora treats
     * `~/.claude/.credentials.json` and the isolated claude-home copy
     * as ONE OAuth session and auto-repairs the symlink whenever the
     * claude CLI's atomic token-refresh write materializes it into a
     * drifting real file (boot-time + on auth-failure during a turn).
     * Set false ONLY if somora deliberately runs on a separate claude
     * account inside CLAUDE_CONFIG_DIR — then somora never touches
     * either credentials file.
     */
    sharedUserCredentials: z.boolean().default(true),
  })
  .default({
    mcpToolTimeoutMs: 1_800_000,
    mcpConnectTimeoutMs: 60_000,
    sharedUserCredentials: true,
  });
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
    /**
     * How codex's `--sandbox read-only` mode forwards env vars to the
     * shell processes spawned by its `exec` tool.
     *
     * `inherit-all` (default) — pass the full somora-server process
     *   env into codex's tool shells. Required for skills like `gog`
     *   that depend on credentials living in the server's env (loaded
     *   via systemd EnvironmentFile or ~/.somora/somora.env).
     * `core-only` — codex's own restrictive default, which keeps only
     *   PATH/HOME/USER/LANG/etc. Skills with declared env_vars then
     *   silently see them as missing inside the shell — exactly the
     *   2026-05-10 lisa/GOG_KEYRING_PASSWORD bug. Use only if you have
     *   a hardening reason and have audited every skill.
     *
     * Maps to codex's `-c shell_environment_policy.inherit=all|core`
     * flag (codex 0.125+).
     */
    shellEnvironmentPolicy: z.enum(['inherit-all', 'core-only']).default('inherit-all'),
  })
  .default({ toolTimeoutSec: 1800, shellEnvironmentPolicy: 'inherit-all' });
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
  /**
   * Privileged-command allowlist that overrides the global exec-tool
   * blacklist (`sudo`, `reboot`, `shutdown`, etc.) FOR THIS RESOURCE
   * ONLY. The global blacklist is the safe default; this is an opt-in
   * escape valve for dedicated agent-workstations where Somora-agents
   * legitimately maintain the host.
   *
   * Match semantics (intentionally simple): trim+collapse whitespace on
   * both the incoming command and each entry, then entry `E` matches
   * command `C` iff `C === E` OR `C.startsWith(E + ' ')`. No regex, no
   * shell parsing — what you type is what's allowed, plus arguments
   * after a space boundary. Example: `sudo` matches `sudo apt …` and
   * bare `sudo`, but not `pseudo`. `systemctl reboot` matches itself
   * and `systemctl reboot --now`, but not `systemctl rebootthing`.
   *
   * Each match → execute + write one line to
   * `~/.somora/audit/exec-privileged.jsonl`. `local` target ignores
   * this (host-policy is enforced on the resource side).
   */
  allowBlocked: z.array(z.string().min(1)).default([]),
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

// Mobile PWA display knobs. Reduced-surface counterpart to TuiConfig:
// the mobile chat surface is minimal by design (chat-only), and the
// tool/memory rows that desktop +TUI default-on are default-off here
// to keep screen real-estate for the conversation. Operators can flip
// them on per-deployment in config.yaml if they prefer the verbose
// view on phone too.
export const MobileConfigSchema = z.object({
  show: z.object({
    /** Show `[tool call · …]` / `[tool result · …]` rows in the
     *  mobile chat. Default off; flip to true if you want
     *  desktop-parity verbosity. */
    tools: z.boolean().default(false),
    /** Show `[memory · …]` inject rows in the mobile chat. Default
     *  off; same rationale as `tools`. */
    memory: z.boolean().default(false),
  }).default({ tools: false, memory: false }),
}).default({
  show: { tools: false, memory: false },
});
export type MobileConfig = z.infer<typeof MobileConfigSchema>;

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

// Speech-to-Text config. Standalone (not in providers.X.models) so the
// STT model never leaks into chat-model pickers, agent-config validation,
// or `/v1/models` — STT is a separate service surface, not "another
// model to pick". The web mic button POSTs audio to `/stt/transcribe`,
// somora forwards multipart to `providers[stt.provider].baseUrl +
// /audio/transcriptions` (OpenAI-compatible STT endpoint, supported by
// oMLX, faster-whisper-server, OpenAI itself, etc.).
export const SttConfigSchema = z
  .object({
    /** Master toggle. When false (or block omitted), the /stt/transcribe
     *  endpoint returns 503 and the web mic button auto-hides. */
    enabled: z.boolean().default(false),
    /** Name of an existing entry in `providers`. Reuses its baseUrl +
     *  apiKey so connection details aren't duplicated. Provider must be
     *  `openai-compatible` engine. */
    provider: z.string().min(1),
    /** Model id passed in the `model` field of the multipart request
     *  (e.g. `mlx-community/whisper-large-v3-turbo`). Whatever string
     *  the upstream STT server expects. */
    model: z.string().min(1),
    /** Optional default language hint (ISO 639-1: `de`, `en`, …). Whisper
     *  auto-detects without it, but a hint cuts latency and prevents
     *  language confusion on short utterances. */
    language: z.string().min(2).max(8).optional(),
  })
  .optional();
export type SttConfig = z.infer<typeof SttConfigSchema>;

// Text-to-Speech config. Mirror-image of STT: somora proxies a
// client-issued `text → audio` request to an OpenAI-compatible TTS
// endpoint (oMLX, fish-audio, etc), caches the result, and serves
// it back as audio bytes. Same as STT, the TTS model is NOT listed
// in providers.X.models — it's a separate service surface, not "a
// chat model to pick".
//
// Auto-TTS gating: the run-turn pipeline generates an
// `assistant_audio` artifact only when ALL of (1) tts.enabled,
// (2) the user message arrived via STT (input.modality === 'voice'),
// (3) the client requested autoPlayRequested=true with that turn,
// and (4) the assistant text passes the speech-sanitizer all hold.
// Otherwise the chat behaves text-only.
//
// `/voice/turn` is independent of the auto-TTS gate: it's a
// dedicated audio-in → audio-out endpoint that always generates TTS.
export const TtsClientPolicySchema = z.object({
  /** Default for the per-session "auto-play voice replies" toggle. */
  autoPlayVoiceReplies: z.boolean().default(false),
  /** If false, the per-session toggle is hidden in the UI and the
   *  default is forced. Use for kiosk-style installs. */
  allowUserOverride: z.boolean().default(true),
});
export type TtsClientPolicy = z.infer<typeof TtsClientPolicySchema>;

export const TtsConfigSchema = z
  .object({
    /** Master toggle. When false (or block omitted), /tts/* returns
     *  503 and play-buttons stay hidden client-side. */
    enabled: z.boolean().default(false),
    /** Name of an existing entry in `providers`. Reuses its baseUrl +
     *  apiKey. Provider engine must be `openai-compatible`. */
    provider: z.string().min(1),
    /** Model id passed in the OpenAI-compatible /v1/audio/speech call.
     *  Whatever string the upstream expects (e.g. `fish-audio-s2-pro-8bit`). */
    model: z.string().min(1),
    /** Optional voice/speaker selector. Forwarded to the upstream as
     *  `voice`. Provider-specific; omit if your model uses one.
     *  Note: many open-source TTS engines (incl. mlx-audio's fish-s2-pro
     *  adapter) ignore this field — see `textPrefix` / `agentVoices`
     *  for an inline-prefix mechanism that works with such engines. */
    voice: z.string().min(1).optional(),
    /** Optional default language hint (ISO 639-1). Forwarded as `language`. */
    language: z.string().min(2).max(8).optional(),
    /** Optional text-prefix prepended to EVERY synthesize input. Used
     *  to inline speaker / emotion / style tags that the engine reads
     *  as part of the text. Example for Fish Audio S2 Pro on mlx-audio:
     *    textPrefix: "<|speaker:0|>"
     *  Acts as the fallback when an agent doesn't have its own override
     *  in `agentVoices`. */
    textPrefix: z.string().optional(),
    /** Optional per-agent text-prefix overrides. Key = agent name (e.g.
     *  "naxon", "hans"); value = the prefix string to prepend to the
     *  synthesize input when somora is generating audio FOR that agent.
     *  Lookup order at synth time:
     *    1. agentVoices[<agent>]  →  use it
     *    2. else textPrefix       →  use it
     *    3. else no prefix
     *  The prefix flows into the cache-key, so different speakers get
     *  different cached audio files for the same reply text. */
    agentVoices: z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]+$/, 'agent name must match [A-Za-z0-9_-]+'),
        z.string(),
      )
      .default({}),
    /** Cache settings for generated audio. */
    cache: z
      .object({
        /** Days a cached audio file lingers after creation. 0 disables
         *  GC entirely (manual cleanup only). */
        retentionDays: z.number().int().min(0).max(3650).default(7),
        /** Hard cap on the cache directory size. Older files evicted
         *  first when exceeded. */
        maxSizeMB: z.number().int().min(1).default(500),
      })
      .default({ retentionDays: 7, maxSizeMB: 500 }),
    /** Optional re-encode pipeline. When enabled, somora can serve
     *  opus/m4a on top of the upstream's native WAV via ffmpeg. */
    reencode: z
      .object({
        enabled: z.boolean().default(true),
        opusBitrateKbps: z.number().int().min(8).max(256).default(24),
      })
      .default({ enabled: true, opusBitrateKbps: 24 }),
    /** Per-client defaults for the auto-play feature. The web + mobile
     *  PWA clients read this on first session-open to seed their
     *  per-session localStorage toggle. */
    clients: z
      .object({
        web: TtsClientPolicySchema.default({
          autoPlayVoiceReplies: false,
          allowUserOverride: true,
        }),
        mobile: TtsClientPolicySchema.default({
          autoPlayVoiceReplies: false,
          allowUserOverride: true,
        }),
      })
      .default({
        web: { autoPlayVoiceReplies: false, allowUserOverride: true },
        mobile: { autoPlayVoiceReplies: false, allowUserOverride: true },
      }),
  })
  .optional();
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

// Projects — pointer-file index over existing storage locations
// (Obsidian, local paths, URLs, remote resources). Each project is a
// Markdown+frontmatter file under ~/.somora/projects/<slug>.md; a
// session can pin one as its current focus, and the pointer-list lands
// in the system prompt so the agent knows which paths matter.
//
// Entities are a CONTROLLED VOCABULARY — projects belong to one entity
// (e.g. "privat", "enovom"), and at write time the agent's chosen
// entity is validated against this list. Prevents STT mishearings from
// inventing new phantom entities ("enofhom" silently becomes a new
// category). The list is intentionally USER-curated and edited in
// config.yaml — agents cannot extend it via tools.
export const ProjectEntitySchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9_-]+$/, 'entity slug must match [a-z0-9_-]+'),
  label: z.string().min(1),
});
export type ProjectEntity = z.infer<typeof ProjectEntitySchema>;

export const ProjectsConfigSchema = z
  .object({
    /** Master toggle. When false (or block omitted) the project tools,
     *  slash-commands, HTTP routes and UI surfaces are all dormant.
     *  Existing setups don't change behavior until the operator opts in. */
    enabled: z.boolean().default(false),
    /** Curated entity list. Required when enabled. With enabled=true
     *  but entities=[], project_create errors with "no entities
     *  configured" — anti-foot-gun (better than silently letting the
     *  agent pick any string). */
    entities: z.array(ProjectEntitySchema).default([]),
  })
  .optional();
export type ProjectsConfig = z.infer<typeof ProjectsConfigSchema>;

// Sentinel — proactive trigger runtime config. Phase 1 has a single
// knob: how long to keep completed/error triggers around before the
// scheduler garbage-collects them. Set to 0 to disable GC entirely
// (triggers + history are never auto-removed; user/agent has to
// delete manually). Default 7 days = balance between clean list and
// usable history for debugging.
export const SentinelConfigSchema = z
  .object({
    /** Days to retain `completed` triggers (one-shot `at` fires that
     *  have already run, OR daily-cap auto-paused via `paused`/`error`
     *  paths that haven't been resumed). Counted from `lastFireAt`.
     *  Defaults to 7. Set to 0 to disable auto-GC. */
    completedRetentionDays: z.number().int().min(0).max(3650).default(7),
  })
  .default({ completedRetentionDays: 7 });
export type SentinelConfig = z.infer<typeof SentinelConfigSchema>;

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

// Obsidian Vault — server-global since 2026.05.08.8 (was per-agent
// before). Single shared vault for all agents. Markdown content gets
// indexed as a recall source; the wiki layer (Phase 4) lives in a
// designated subfolder.
export const ObsidianConfigSchema = z
  .object({
    /** Absolute path (or `~`-prefixed) to the Obsidian vault. When
     *  unset, no vault is wired up — agents work with own memory only. */
    vault: z.string().min(1).optional(),
  })
  .default({});
export type ObsidianConfig = z.infer<typeof ObsidianConfigSchema>;

// Wiki-System (Phase 4) — long-term shared knowledge in an Obsidian
// vault subfolder, written by Deep, audited by Lucid, read by all
// agents. See `private/dream-system-v2.md` for the full design.
//
// `enabled: false` is the default so existing setups don't change
// behavior until the operator opts in.
// Anti-clobber guard for Deep's MERGE path. The Deep prompt asks the
// worker model to return the FULL updated page body; on large pages a
// model may silently summarize instead of integrating, and the caller
// would write that shrunken body as the new page. Real incident
// 2026-07-13 on an external instance: a 22 KB page came back as 2.7 KB
// and the pre-existing content was lost (Deep auto-applies, so no human
// saw it). The guard compares body sizes before writing and refuses the
// merge when the result shrank past `minRatio`.
//
// `minExistingBytes` exempts small pages: on a 400-byte stub a rewrite
// to 150 bytes is normal editing, not a catastrophe, and blocking it
// would just stall consolidation.
export const WikiMergeShrinkGuardSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Refuse the merge when newBody < existingBody * minRatio. */
    minRatio: z.number().positive().max(1).default(0.5),
    /** Pages smaller than this (bytes of body) are never guarded. */
    minExistingBytes: z.number().int().nonnegative().default(2000),
  })
  .default({ enabled: true, minRatio: 0.5, minExistingBytes: 2000 });
export type WikiMergeShrinkGuard = z.infer<typeof WikiMergeShrinkGuardSchema>;

export const WikiDeepConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Real-clock cadence for Deep (Memory → Wiki consolidation). */
    intervalHours: z.number().positive().default(12),
    /** Worker model for Deep. Format `<provider>/<modelId>`. */
    model: z.string().min(1).optional(),
    /** Deep auto-applies (no approval). Reserved as bool in case we
     *  ever need to flip back on. */
    requireApproval: z.boolean().default(false),
    /** Optional thinking-level for the Deep LLM one-shot. When set and
     *  the worker model declares the 'reasoning' capability, the call
     *  forwards effort/reasoning_effort per engine. Unset = engine
     *  default (no thinking). */
    thinking: ThinkingLevelSchema.optional(),
    /** Anti-clobber guard on the MERGE write path. */
    mergeShrinkGuard: WikiMergeShrinkGuardSchema,
  })
  .default({
    enabled: true,
    intervalHours: 12,
    requireApproval: false,
    mergeShrinkGuard: { enabled: true, minRatio: 0.5, minExistingBytes: 2000 },
  });

export const WikiLucidConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalDays: z.number().positive().default(7),
    /** Worker model for Lucid (wiki cleanup / contradiction detection). */
    model: z.string().min(1).optional(),
    /** Lucid findings need user approval before wiki-edits apply.
     *  Approval happens via `dream_list` / `dream_get` / `dream_apply`
     *  / `dream_dismiss` — any agent with the `dream` toolset can
     *  review platform-wide Lucid runs. */
    requireApproval: z.boolean().default(true),
    /** Optional thinking-level for the Lucid LLM one-shot. Semantics
     *  identical to wiki.deep.thinking. */
    thinking: ThinkingLevelSchema.optional(),
    /** Per-turn cap on `wiki_*` tool invocations from the Lucid loop
     *  holder. Prevents the model from batch-editing many pages in
     *  one turn without per-page user confirmation. The cap resets
     *  on every user turn. Raise if you regularly OK multi-page
     *  plans and find the default of 3 cuts off legitimate work;
     *  lower if you want stricter check-in-with-user enforcement. */
    maxCallsPerTurn: z.number().int().positive().default(3),
  })
  .default({
    enabled: true,
    intervalDays: 7,
    requireApproval: true,
    maxCallsPerTurn: 3,
  });

export const WikiSearchConfigSchema = z
  .object({
    /** Score multipliers applied to the fused hybrid score per source.
     *  Higher = ranked first. Wiki at 1.4 is intentional: BM25-only matches
     *  on short keyword queries (e.g. "garten") only reach ~0.3 hybrid
     *  before boost, so wiki-curated pages need a lift to surface above
     *  noisier memory chunks that vector-recall happens to pick up. */
    boostWiki: z.number().positive().default(1.4),
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
    boostWiki: 1.4,
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
    deep: WikiDeepConfigSchema,
    lucid: WikiLucidConfigSchema,
    search: WikiSearchConfigSchema,
  })
  .default({
    enabled: false,
    vaultSubfolder: 'somora',
    defaultSubdirs: ['personen', 'projekte', 'wissen'],
    deep: {
      enabled: true,
      intervalHours: 12,
      requireApproval: false,
      mergeShrinkGuard: { enabled: true, minRatio: 0.5, minExistingBytes: 2000 },
    },
    lucid: {
      enabled: true,
      intervalDays: 7,
      requireApproval: true,
      maxCallsPerTurn: 3,
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

// TLS — switches the server from plain HTTP/1.1 to HTTP/2-over-TLS.
// HTTP/2 multiplexes all streams (SSE, fetch, future WebSocket) over a
// single TCP connection, dodging the 6-per-origin browser limit that
// otherwise caps how many chat windows + tmux attaches a user can open.
//
// somora's only supported deployment for HTTPS is **Tailscale**: run
// `tailscale cert <your-tailnet-fqdn>` to get Let's-Encrypt-signed
// certs for free, then point cert/key at the resulting files. Tailscale
// certs are publicly trusted (Node + browsers accept them out of the
// box) and renew via the same one-shot command. Setups without
// Tailscale would need to plug in their own CA — secure-context-only
// browser APIs (mic, screenshare, clipboard, push) require HTTPS too,
// so this is a hard prerequisite for those features.
export const TlsConfigSchema = z
  .object({
    /** Path to TLS certificate file (PEM). When set together with `key`,
     *  the server listens on HTTP/2-over-TLS instead of plain HTTP. `~`
     *  expands to $HOME. */
    cert: z.string().min(1),
    /** Path to TLS private key file (PEM). `~` expands to $HOME. */
    key: z.string().min(1),
    /** External hostname clients should use to reach the server — must
     *  match the cert's CN/SAN, otherwise strict TLS verification will
     *  reject the connection. Used by the MCP-child fallback caller in
     *  src/tools/agents/spawn.ts (which switches from plain-HTTP
     *  loopback to HTTPS once TLS is on) and surfaced in client docs.
     *  Example: `<your-host>.<your-tailnet>.ts.net`. */
    publicHost: z.string().min(1),
  })
  .optional();
export type TlsConfig = z.infer<typeof TlsConfigSchema>;

// Attachments — caps + per-turn count for user-uploaded files (Y.B).
// Defaults pick the LOWEST-COMMON-DENOMINATOR across all engines:
//   image: 5 MB (Anthropic ceiling)
//   pdf:   32 MB (Anthropic ceiling)
//   text:  1 MB (file_read fallback ceiling)
// Operators with a fleet that can handle bigger files raise these
// in config; nobody who runs against Anthropic ever has to lower
// them. maxPerTurn is a UX-sanity cap well under any engine's
// hard limit (Anthropic 100, OpenAI ~50, codex/omlx undocumented).
export const AttachmentsConfigSchema = z
  .object({
    maxImageBytes: z.number().int().positive().default(5 * 1024 * 1024),
    maxPdfBytes: z.number().int().positive().default(32 * 1024 * 1024),
    maxTextBytes: z.number().int().positive().default(1 * 1024 * 1024),
    maxPerTurn: z.number().int().positive().default(10),
  })
  .default({
    maxImageBytes: 5 * 1024 * 1024,
    maxPdfBytes: 32 * 1024 * 1024,
    maxTextBytes: 1 * 1024 * 1024,
    maxPerTurn: 10,
  });
export type AttachmentsConfig = z.infer<typeof AttachmentsConfigSchema>;

export const ConfigSchema = z.object({
  server: z
    .object({
      port: z.number().int().positive().default(18737),
      tls: TlsConfigSchema,
    })
    .default({ port: 18737 }),
  providers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), ProviderSchema),
  compaction: CompactionConfigSchema,
  memory: MemoryConfigSchema,
  rem: RemGlobalConfigSchema,
  agentLoop: AgentLoopConfigSchema,
  engineWatchdog: EngineWatchdogConfigSchema,
  sse: SseConfigSchema,
  claudeCli: ClaudeCliConfigSchema,
  codexCli: CodexCliConfigSchema,
  tui: TuiConfigSchema,
  mobile: MobileConfigSchema,
  web: WebConfigSchema,
  workspace: WorkspaceConfigSchema,
  resources: ResourcesConfigSchema,
  skills: SkillsConfigSchema,
  vision: VisionConfigSchema,
  stt: SttConfigSchema,
  tts: TtsConfigSchema,
  projects: ProjectsConfigSchema,
  sentinel: SentinelConfigSchema,
  obsidian: ObsidianConfigSchema,
  wiki: WikiConfigSchema,
  attachments: AttachmentsConfigSchema,
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
