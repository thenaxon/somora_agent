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

/**
 * Per-model reasoning vocabulary for the `openai-compatible` engine.
 * Real models disagree on the words (OpenAI none…xhigh, Qwen only
 * xhigh|medium|low, DeepSeek low|high|max) and some reject unknown
 * values with HTTP 400 instead of ignoring them. This block maps
 * somora's neutral levels onto what the model actually accepts, and
 * says where the value goes in the request body. Unset = legacy
 * behaviour (`off` omits the param, the other levels go verbatim as
 * `reasoning_effort`). See docs/thinking.md → Per-model vocabulary.
 */
export const ModelReasoningSchema = z.object({
  /** Body shape. `reasoning_effort` (top-level, default), `reasoning`
   *  (OpenRouter's nested `{ reasoning: { effort } }`), or
   *  `chat_template_kwargs` (vLLM templates that only read kwargs). */
  param: z.enum(['reasoning_effort', 'reasoning', 'chat_template_kwargs']).optional(),
  /** somora level → model value. A string is sent as-is; `null` omits
   *  the param for that level (model default). Missing levels keep the
   *  legacy mapping. */
  levels: z
    .object({
      off: z.string().min(1).nullable().optional(),
      low: z.string().min(1).nullable().optional(),
      medium: z.string().min(1).nullable().optional(),
      high: z.string().min(1).nullable().optional(),
    })
    .optional(),
});
export type ModelReasoningConfig = z.infer<typeof ModelReasoningSchema>;

/**
 * Sampling parameters for the `openai-compatible` engine. Set as a model
 * default here, as an agent default in agent.yaml (`sampling:`), or per
 * session via `/sampling` / `/temp`; later layers win per key. Every key
 * goes on the wire under its own name — a backend that rejects one
 * answers 400 and the engine retries once without sampling. See
 * docs/sampling.md.
 */
export const SamplingSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().min(1).optional(),
    min_p: z.number().min(0).max(1).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    repetition_penalty: z.number().positive().optional(),
    seed: z.number().int().optional(),
    stop: z.union([z.string().min(1), z.array(z.string().min(1)).max(4)]).optional(),
  })
  .strict();
export type SamplingConfig = z.infer<typeof SamplingSchema>;

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
  /**
   * Output cap sent as `max_tokens` (openai-compatible only). Unset =
   * not sent, the backend decides (vLLM: the rest of the context). Worth
   * setting on reasoning models, where thinking and answer share one
   * budget and nothing else stops a runaway thinking phase. Not to be
   * confused with `memory.autoInject.maxTokens` (input-side cap on the
   * injected memory block).
   */
  maxTokens: z.number().int().positive().optional(),
  /** Reasoning vocabulary + wire shape for this model (openai-compatible only). */
  reasoning: ModelReasoningSchema.optional(),
  /** Vendor-recommended sampling defaults for this model (openai-compatible
   *  only). agent.yaml `sampling:` and the session override win per key. */
  sampling: SamplingSchema.optional(),
  /**
   * Only read by the `openai-compatible` engine. When unset (the common
   * case), that engine sends `parallel_tool_calls: false` so the model
   * emits ONE tool call per round — smaller/local models (deepseek, kimi)
   * otherwise fan out into large parallel batches and lose track of what
   * they've already run, which fuels runaway loops. Set `true` on a model
   * you trust to parallelise (a strong local model doing independent
   * reads) to restore the provider's default parallel behaviour. No effect
   * on claude-cli / codex-cli. See docs/setup.md → Local OpenAI-compatible.
   */
  parallelToolCalls: z.boolean().optional(),
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

// grok-cli: xAI's Grok Build CLI driven over ACP (Agent Client
// Protocol, JSON-RPC on stdio) via `grok agent stdio`. Auth is handled
// by the binary itself — `grok login` writes a session to
// ~/.grok/auth.json and the ACP handshake reports it as the
// `cached_token` auth method. That session carries a SuperGrok/Premium
// subscription, so no baseUrl / apiKey belong here; passing an
// XAI_API_KEY env var instead switches the binary to pay-per-token API
// billing (see docs/setup.md).
//
// Binary path override: SOMORA_GROK_BIN (default ~/.local/bin/grok),
// mirroring SOMORA_CODEX_BIN / SOMORA_CLAUDE_BIN.
export const GrokCliProviderSchema = z.object({
  engine: z.literal('grok-cli'),
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

/** The one provider variant that carries baseUrl + apiKey. Named so
 *  service surfaces (stt, tts, imagegen) can require it in a signature
 *  instead of re-narrowing the union at every call site. */
export type OpenAiCompatibleProvider = z.infer<typeof OpenAiCompatibleProviderSchema>;

export const ProviderSchema = z.discriminatedUnion('engine', [
  ClaudeCliProviderSchema,
  CodexCliProviderSchema,
  GrokCliProviderSchema,
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
// Threshold semantics: COSINE similarity of the finding's embedding to
// the best existing chunk, in [0,1] (memory/retrieval.ts
// cosineFromVecScore). Not the fused hybrid `score` — that is a rank
// within one query's candidates (the top hit is always 1.0 before
// source boosts), which is why the old 0.8 flagged ~70 % of findings
// against unrelated pages (2026-08-26). Default 0.85, measured on real
// notes with the bundled embedding model (2026-08-31): verbatim 1.00,
// paraphrase of the same fact 0.85-0.90, same topic but a different or
// contradicting fact 0.73-0.84, unrelated 0.3-0.5. A long German note
// vs a one-line paraphrase can drop to ~0.6 — that finding then simply
// shows up unmarked, the conservative failure. Tune down if repeats
// still get through, up if contradicting facts get flagged.
export const RemDedupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  similarityThreshold: z.number().min(0).max(1).default(0.85),
}).default({ enabled: true, similarityThreshold: 0.85 });

export type RemDedupConfig = z.infer<typeof RemDedupConfigSchema>;

export const RemGlobalConfigSchema = z.object({
  dedup: RemDedupConfigSchema,
}).default({ dedup: { enabled: true, similarityThreshold: 0.85 } });
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
  grokCliIdleMs: z.number().int().positive().default(300_000),
  openaiCompatibleIdleMs: z.number().int().positive().default(1_200_000),
}).default({
  claudeCliIdleMs: 300_000,
  codexCliIdleMs: 300_000,
  grokCliIdleMs: 300_000,
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
  /** Server → client heartbeat interval on /chat/stream and
   *  /activity/stream. Clients treat a gap of > ~2 intervals as a lost
   *  link (docs/mobile.md). */
  heartbeatMs: z.number().int().positive().default(20_000),
  /** A heartbeat write that has not completed after this long marks
   *  the stream dead: it is torn down and its socket destroyed. */
  deadAfterMs: z.number().int().positive().default(60_000),
  /** HTTP/2 PING per client session (TLS listener only). A session
   *  that does not ACK within h2PingTimeoutMs is destroyed — the way
   *  a silently vanished tab (WLAN drop, sleep) is detected in about
   *  a minute instead of never. */
  h2PingIntervalMs: z.number().int().positive().default(30_000),
  h2PingTimeoutMs: z.number().int().positive().default(30_000),
  /** TCP keepalive delay set on every accepted socket. Kernel probe
   *  interval/count still apply on top (Linux default 75 s × 9). */
  keepAliveDelayMs: z.number().int().positive().default(30_000),
}).default({
  publishTimeoutMs: 10_000,
  publishParallel: true,
  heartbeatMs: 20_000,
  deadAfterMs: 60_000,
  h2PingIntervalMs: 30_000,
  h2PingTimeoutMs: 30_000,
  keepAliveDelayMs: 30_000,
});
export type SseConfig = z.infer<typeof SseConfigSchema>;

// tmux attention watcher — server-side polling of somora-created tmux
// sessions with a known coding-CLI kind (claude-code / codex). Detects
// the running→ready transition ("finished or waiting for input") and,
// when the originating agent missed it, dispatches a wake turn so the
// agent reads the output and continues. Design:
// private/tmux-hooks-design.md (Phase 1, watcher-first — no CLI hooks).
export const TmuxAttentionConfigSchema = z
  .object({
    /** Master switch for the watcher + attention metadata in tmux
     *  tool responses / web badge. Off = zero polling, zero traces. */
    enabled: z.boolean().default(true),
    /** Agent-wakeup stage. Off = events only (needs_attention flag +
     *  badge), no dispatched turns. */
    wake: z.boolean().default(true),
    /** Watcher poll interval. Also bounds how quickly a missed
     *  completion turns into a wake (one extra tick worst-case). */
    pollMs: z.number().int().min(500).default(3_000),
    /** Minimum seconds between two wakes for the same tmux session —
     *  flap protection for fast running/ready cycles. */
    cooldownS: z.number().int().min(0).default(60),
    /** Hard daily ceiling per tmux session (UTC day). Past the cap
     *  only the needs_attention flag is set, no more turns. */
    dailyCapPerSession: z.number().int().min(1).default(40),
  })
  .default({
    enabled: true,
    wake: true,
    pollMs: 3_000,
    cooldownS: 60,
    dailyCapPerSession: 40,
  });
export type TmuxAttentionConfig = z.infer<typeof TmuxAttentionConfigSchema>;

export const TmuxConfigSchema = z
  .object({
    attention: TmuxAttentionConfigSchema,
  })
  .default({
    attention: {
      enabled: true,
      wake: true,
      pollMs: 3_000,
      cooldownS: 60,
      dailyCapPerSession: 40,
    },
  });
export type TmuxConfig = z.infer<typeof TmuxConfigSchema>;

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
   * Hard ceiling on the TOTAL number of tool calls executed in one turn,
   * across all rounds. `maxRounds` counts rounds (model turns); it does
   * NOT bound how many tool calls a single round contains. Weak/local
   * models — deepseek via OpenRouter, which ignores `parallel_tool_calls`
   * — fan out dozens of tool calls in ONE round (77 and 116 identical
   * calls observed 2026-07-23), never touching the round cap. This budget
   * catches that: once a turn has executed this many tool calls, somora
   * stops and forces a final answer. Openai-compatible engine only.
   * Well-behaved turns finish in a handful; 30 leaves generous headroom.
   */
  maxToolCallsPerTurn: z.number().int().positive().max(500).default(30),
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
  maxToolCallsPerTurn: 30,
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
     * Maps to `mcp_servers.somora.tool_timeout_sec` in codex's
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
    /** Model thinking text above each reply (engines that surface it). */
    thinking: z.boolean().default(false),
  }).default({ tools: false, memory: false, system: false, thinking: false }),
}).default({
  show: { memory: true, tools: true },
  verbose: { tools: false, memory: false, system: false, thinking: false },
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
/**
 * One worker, or an ordered list of them. A list is tried front to
 * back and the first one that answers wins.
 *
 * Why a list at all: a locally hosted worker is the cheap and private
 * choice, but a GPU box runs one profile at a time — switch the profile
 * and that model is simply not loaded any more. With a single value,
 * `analyze_file` is then broken for every agent at once, and quietly:
 * the agent finds out by failing. The last entry is meant to be
 * something externally hosted that is always there.
 *
 * A plain string stays valid and means a one-element list.
 */
const WorkerRefSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

export const VisionConfigSchema = z
  .object({
    /** Worker(s) for image + PDF analysis, `<provider>/<modelId>` each.
     *  A worker MUST have `image` capability; PDF use also requires
     *  `pdf` (or set `pdfWorker` to a model that has it). Entries that
     *  lack the needed capability are skipped, not fatal — the point of
     *  a chain is that it survives one entry being unusable. */
    worker: WorkerRefSchema.optional(),
    /** Override for PDF dispatch only. When unset, PDF uses `worker`.
     *  Use case: a cheap image-only worker plus a separate PDF-capable
     *  one for cost control. */
    pdfWorker: WorkerRefSchema.optional(),
    /** Per-attempt budget. A worker that hasn't answered by then counts
     *  as down and the chain moves on. Generous by default because a
     *  local vision model describing a large image legitimately takes
     *  tens of seconds. */
    timeoutMs: z.number().int().positive().default(60_000),
    /** How long a failed worker is skipped before being tried again.
     *  Without this, every single call pays the full timeout of a
     *  worker that is down for the rest of the afternoon. 0 disables
     *  the memory. */
    healthCacheMs: z.number().int().min(0).default(60_000),
  })
  .default({ timeoutMs: 60_000, healthCacheMs: 60_000 });

/** Normalise either accepted shape into the list the runtime walks. */
export function workerChain(ref: string | string[] | undefined): string[] {
  if (!ref) return [];
  return Array.isArray(ref) ? ref : [ref];
}
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

// Image generation. Same standalone shape as stt/tts and for the same
// reason: an image model is a separate service surface, not "another
// chat model to pick". Listing them in providers.X.models would leak
// them into model pickers, persona validation and /v1/models, where
// they'd be selectable as a conversation model and fail on the first
// turn.
//
// Wire target is the OpenAI-shaped image endpoint (`POST <baseUrl>/images`
// — OpenRouter's /api/v1/images, OpenAI's /v1/images/generations). The
// chat.completions + `modalities: ["image"]` route is deliberately NOT
// supported: it has no structured spec fields, so aspect ratio and
// resolution would degrade to prose inside the prompt.
//
// Spec validation is capability-driven, not hardcoded — see
// src/imagegen/capabilities.ts. Allowed values differ per model (grok
// renders 1K/2K only, others do 512/4K), so the truth comes from the
// provider's model catalog at runtime, with `allow` below as the
// offline override.
export const ImageSpecDefaultsSchema = z
  .object({
    resolution: z.string().min(1).optional(),
    aspect_ratio: z.string().min(1).optional(),
    /** Explicit pixels (`1024x1024`). Some endpoints size images this
     *  way and have no `resolution` tier at all, so it has to be
     *  settable as a default like any other spec. */
    size: z.string().min(1).optional(),
    /** Sampling knobs, for backends that expose them. Defaults belong
     *  to the model, so setting one here is for the rare case where an
     *  operator wants a different house style than the model ships. */
    steps: z.number().int().positive().optional(),
    cfg: z.number().optional(),
    guidance: z.number().optional(),
    quality: z.string().min(1).optional(),
    output_format: z.string().min(1).optional(),
    background: z.string().min(1).optional(),
  })
  .strict()
  .default({});
export type ImageSpecDefaults = z.infer<typeof ImageSpecDefaultsSchema>;

export const ImageModelSchema = z.object({
  /** Short handle used by the tool's `model` arg and the UI picker.
   *  Deliberately NOT the wire id — agents and humans shouldn't have to
   *  type `x-ai/grok-imagine-image-2.0` to pick a model. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'image model name must match [A-Za-z0-9_-]+'),
  /** Name of an existing entry in `providers`. Reuses its baseUrl +
   *  apiKey. Provider engine must be `openai-compatible`. */
  provider: z.string().min(1),
  /** Model id sent in the request's `model` field. */
  model: z.string().min(1),
  /** Human-readable label for the UI picker. Falls back to `name`. */
  label: z.string().min(1).optional(),
  /** Path appended to the provider's baseUrl. Defaults to `/images`
   *  (OpenRouter). OpenAI direct wants `/images/generations`, and a
   *  local server may sit anywhere — hence configurable rather than
   *  guessed from the hostname. */
  endpoint: z.string().min(1).default('/images'),
  /**
   * Which request dialect this endpoint speaks. Only matters once
   * reference images are involved — plain generation is the same JSON
   * POST everywhere:
   *
   *   openrouter — references ride as base64 in an `input_references`
   *                array on the same JSON body.
   *   openai     — references make it a DIFFERENT request: multipart
   *                to the edit endpoint, one `image[]` part per file.
   *                This is what OpenAI itself accepts and what LiteLLM
   *                passes through to a local image backend.
   *
   * There is no autodetection. A wrong guess here fails at the worst
   * possible moment (after the user waited for a render), and the
   * operator configuring the model knows the answer.
   */
  wire: z.enum(['openrouter', 'openai']).default('openrouter'),
  /** Path for the reference-image (edit) request, appended to baseUrl.
   *  `wire: openai` only. Defaults to the OpenAI/LiteLLM path. */
  editEndpoint: z.string().min(1).default('/images/edits'),
  /**
   * Handle of another image model to try when this one is UNAVAILABLE.
   * Chains: the fallback may name a fallback of its own.
   *
   * Availability only — a rejected spec value or an empty prompt is the
   * caller's mistake and the next model would reject it too (or worse,
   * quietly accept and ignore it). Only an unreachable, timing-out or
   * server-erroring endpoint moves the request along.
   *
   * The case this exists for: image models live on a GPU box that runs
   * one profile at a time, so "the model is configured" and "the model
   * is loaded right now" are different questions, and the endpoint
   * answers the second one with a 503.
   */
  fallback: z.string().min(1).optional(),
  /** Path for the model-capability catalog, appended to baseUrl.
   *  Defaults to `/images/models` (OpenRouter). Set to null when the
   *  provider has none — validation then falls back to `allow`, or to
   *  permissive if that's unset too. */
  capabilitiesEndpoint: z.string().min(1).nullable().default('/images/models'),
  /** Specs applied when the caller omits them. Validated against the
   *  model's real capabilities like any other spec — a stale default
   *  surfaces as a startup-time warning, not a runtime surprise. */
  defaults: ImageSpecDefaultsSchema,
  /** Offline capability override. Set this when the provider has no
   *  discoverable model catalog (a local image server) or when its
   *  catalog is wrong. Takes precedence over discovery. */
  allow: z
    .object({
      // One entry per ENUMERABLE_SPEC_FIELDS (src/imagegen/types.ts).
      // The two lists have to be kept in step by hand; `background`
      // was missing here and silently ignored, which is the whole
      // reason this block is `.strict()` below.
      resolution: z.array(z.string().min(1)).optional(),
      aspect_ratio: z.array(z.string().min(1)).optional(),
      size: z.array(z.string().min(1)).optional(),
      quality: z.array(z.string().min(1)).optional(),
      output_format: z.array(z.string().min(1)).optional(),
      background: z.array(z.string().min(1)).optional(),
      /**
       * The complete set of parameter names this model accepts. Same
       * meaning as a catalog's published list: present ⇒ authoritative,
       * and a field missing from it is rejected before a request goes
       * out. Absent ⇒ unknown, and everything is let through.
       *
       * This is the only way to get that guarantee out of a provider
       * with no model catalog. Without it, a field the endpoint doesn't
       * read is simply ignored on the far side and the caller gets an
       * image that quietly disregards what was asked for.
       */
      supported: z.array(z.string().min(1)).min(1).optional(),
      maxN: z.number().int().min(1).max(10).optional(),
      maxReferences: z.number().int().min(0).max(16).optional(),
    })
    // Strict on purpose: a stray or misspelled key here would be
    // dropped without a word, and the operator would be looking at a
    // restriction that does nothing.
    .strict()
    .optional(),
});
export type ImageModel = z.infer<typeof ImageModelSchema>;

export const ImageGenConfigSchema = z
  .object({
    /** Master toggle. When false (or block omitted), the image tools
     *  stay unavailable, /images/* returns 503 and the desktop tile
     *  auto-hides — same gate shape as wiki/tts. */
    enabled: z.boolean().default(false),
    /** Canonical destination for EVERY generated image, regardless of
     *  which agent triggered it. Deliberately absolute rather than
     *  workspace-relative: the gallery and the file-serving route index
     *  one directory, and a per-agent workspace would scatter images
     *  across several. A caller-supplied destination gets a hardlink on
     *  top (see src/imagegen/store.ts), not a second copy. */
    outputDir: z.string().min(1).default('~/somoraworkspace/images'),
    /** Bucket files into `<outputDir>/YYYY-MM/`. Off by default —
     *  nesting only starts paying off in the hundreds, and filenames
     *  already sort chronologically. */
    monthlyFolders: z.boolean().default(false),
    /** Cost brake. Counts images (not calls) generated within one turn;
     *  the tool refuses past this and tells the agent to ask its human.
     *  Without it, an agent with imageReview: always that keeps
     *  "improving" the result bills real money in a loop. */
    maxImagesPerTurn: z.number().int().min(1).max(100).default(5),
    /** Wall-clock cap for one upstream request. Image models are slow —
     *  a 4K render legitimately takes minutes, so this sits far above
     *  the usual HTTP timeouts. */
    timeoutMs: z.number().int().min(5_000).max(1_800_000).default(300_000),
    /** Configured image models. First entry is the default when a
     *  caller omits `model`. */
    models: z.array(ImageModelSchema).min(1),
  })
  .optional();
export type ImageGenConfig = z.infer<typeof ImageGenConfigSchema>;

// Video generation. Same standalone shape as imageGen and for the same
// reason, plus one that is specific to video: a render takes minutes on
// a GPU, so these models must never be reachable as a conversation
// model by accident.
//
// The lifecycle is what separates video from images: create a job, poll
// it, then download the result. That is three requests instead of one,
// and every provider spells them differently — hence `wire`.
export const VideoWireSchema = z.enum(['openai', 'passthrough', 'veo']);
export type VideoWire = z.infer<typeof VideoWireSchema>;

export const VideoModelSchema = z.object({
  /** Short handle used by the tool's `model` arg and the UI picker. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, 'video model name must match [A-Za-z0-9_-]+'),
  /** Name of an existing entry in `providers`. Reuses its baseUrl +
   *  apiKey. Provider engine must be `openai-compatible`. */
  provider: z.string().min(1),
  /** Model id sent in the request's `model` field. */
  model: z.string().min(1),
  label: z.string().min(1).optional(),
  /**
   * Which lifecycle dialect this endpoint speaks. All three do the same
   * three things; they differ in where the job id lives and what the
   * status field is called.
   *
   *   openai      — POST /videos, GET /videos/{id},
   *                 GET /videos/{id}/content?variant=…   (id in the PATH)
   *   passthrough — POST /vid/create, GET /vid/status?id=,
   *                 GET /vid/content?id=&variant=…       (id in the QUERY)
   *                 The shape a proxy can forward without rewriting
   *                 paths, which is why a router in front of a local
   *                 backend ends up here.
   *   veo         — Google Vertex AI: predictLongRunning returns an
   *                 OPERATION NAME rather than a job id, polling asks
   *                 whether the operation is `done`, and the result
   *                 arrives as a GCS URI or inline bytes rather than
   *                 from a content endpoint.
   *
   * NOTE ON `veo`: implemented against Google's published shape but NOT
   * yet verified against a live endpoint — somora has had no Vertex
   * access to test with. Treat it as a prepared seam: the structure is
   * here so adding Veo is a config entry rather than a refactor, but do
   * not assume it works until someone has run it once. Every other
   * dialect in this file was measured against a real endpoint before
   * being called done.
   */
  wire: VideoWireSchema.default('openai'),
  /** Path that creates a job, appended to the provider's baseUrl. */
  createEndpoint: z.string().min(1).optional(),
  /** Path that reports job state. */
  statusEndpoint: z.string().min(1).optional(),
  /** Path that yields the finished bytes. */
  contentEndpoint: z.string().min(1).optional(),
  /** Model catalog, appended to baseUrl. Null when the provider has
   *  none — OpenAI publishes no video catalog, so `allow` is the truth
   *  there. */
  capabilitiesEndpoint: z.string().min(1).nullable().default(null),
  /** Specs applied when the caller omits them. */
  defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Offline capability override — same meaning as imageGen's. */
  allow: z
    .object({
      supported: z.array(z.string().min(1)).min(1).optional(),
      /** Content variants this provider serves. `thumbnail` is what
       *  lets a gallery show a frame and an agent judge its own output
       *  through analyze_file. */
      variants: z.array(z.string().min(1)).min(1).optional(),
      aspect_ratio: z.array(z.string().min(1)).optional(),
      size: z.array(z.string().min(1)).optional(),
      maxSeconds: z.number().positive().optional(),
      maxReferences: z.number().int().min(0).max(4).optional(),
    })
    .strict()
    .optional(),
  /** Handle of another video model to try when this one is unavailable.
   *  Availability only, exactly as for images. */
  fallback: z.string().min(1).optional(),
});
export type VideoModel = z.infer<typeof VideoModelSchema>;

export const VideoGenConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    outputDir: z.string().min(1).default('~/somoraworkspace/videos'),
    monthlyFolders: z.boolean().default(false),
    /**
     * How many renders somora keeps in flight across ALL agents.
     * Global on purpose: a GPU is a shared resource and a per-agent
     * budget would let four agents occupy twelve slots. When the cap is
     * reached the next caller is turned away with a clear message
     * rather than queued — waiting silently for an unknown number of
     * minutes is worse than being told to come back.
     */
    maxConcurrent: z.number().int().min(1).max(32).default(4),
    /** How often a running job is polled. */
    pollIntervalMs: z.number().int().min(1000).default(8000),
    /** A job that hasn't finished by then is given up on. Renders run
     *  minutes, and a stuck job would otherwise hold a slot forever. */
    jobTimeoutMs: z.number().int().positive().default(45 * 60_000),
    /** Per-request budget for create/status/content calls themselves —
     *  not for the render, which is what the job timeout covers. */
    requestTimeoutMs: z.number().int().positive().default(120_000),
    models: z.array(VideoModelSchema).min(1),
  })
  .optional();
export type VideoGenConfig = z.infer<typeof VideoGenConfigSchema>;

/** Resolve a video-model handle to its config entry + provider. */
export function resolveVideoModel(
  config: Config,
  name?: string,
): { entry: VideoModel; provider: Provider; providerName: string } | null {
  const models = config.videoGen?.models;
  if (!models || models.length === 0) return null;
  const entry = name ? models.find((m) => m.name === name) : models[0];
  if (!entry) return null;
  const provider = config.providers[entry.provider];
  if (!provider) return null;
  return { entry, provider, providerName: entry.provider };
}

/** Resolve an image-model handle to its config entry + provider.
 *  Returns null for unknown handles so callers can produce an error
 *  that lists what IS configured. */
export function resolveImageModel(
  config: Config,
  name?: string,
): { entry: ImageModel; provider: Provider; providerName: string } | null {
  const models = config.imageGen?.models;
  if (!models || models.length === 0) return null;
  const entry = name ? models.find((m) => m.name === name) : models[0];
  if (!entry) return null;
  const provider = config.providers[entry.provider];
  if (!provider) return null;
  return { entry, provider, providerName: entry.provider };
}

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
    /** Skill-scoped env injection for local exec. When true (default),
     *  env vars declared by ANY skill (`requires.env_vars`) are stripped
     *  from exec children and re-injected only into commands that invoke
     *  one of that skill's `requires.bins`. False restores the legacy
     *  behavior (full process-env inheritance incl. somora.env secrets
     *  in every exec child). See src/skills/env-scope.ts. */
    envScoping: z.boolean().default(true),
  })
  .default({
    maxSkillsInPrompt: 150,
    maxPromptChars: 18_000,
    maxSkillFileBytes: 256_000,
    // Keep in lockstep with the field defaults above — this literal is
    // what a config.yaml WITHOUT a `skills:` block gets.
    envScoping: true,
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
    /** Char budget for the wiki-overview block. It is snapshotted once
     *  per session into the system prompt (not re-injected per turn), so
     *  this is paid once inside the cached prefix — 4000 keeps page names
     *  visible for wikis up to roughly 120 pages before the overview
     *  degrades to section names + counts. Raise it to keep page names on
     *  a larger wiki; the cost is a bigger constant prefix. */
    overviewMaxChars: z.number().int().positive().default(4000),
    /** Cap on how many `## sections` survive in the last-resort overview
     *  (section names + page counts) when even the bare page list exceeds
     *  overviewMaxChars. The largest sections win. */
    overviewTopNSlugs: z.number().int().positive().default(30),
  })
  .default({
    boostWiki: 1.4,
    boostMemory: 0.85,
    boostVault: 0.65,
    overviewMaxChars: 4000,
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
      // Keep in lockstep with WikiSearchConfigSchema's defaults above —
      // this literal is what a config.yaml WITHOUT a `wiki:` block gets.
      // (1.0 here was a typo that silently weakened wiki ranking for
      // exactly those installs; found in the 2026-07-22 investigation.)
      boostWiki: 1.4,
      boostMemory: 0.85,
      boostVault: 0.65,
      overviewMaxChars: 4000,
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

// External MCP servers (design: private/mcp-hub-design.md). The main
// server is the single MCP client ("hub"); discovered tools are bridged
// into the ToolRegistry and proxied to claude-cli/codex-cli via the MCP
// child. Phase 1: remote HTTP servers, tools-only.
//
// Server-name charset deliberately EXCLUDES underscore: the
// `mcp__<server>__<tool>` convention parses/strips on `__`, and both
// somora's shortToolName regex and the reverse-parse in other clients
// break when the server segment itself contains `_`. Hyphens only.
// Auth for MCP servers whose credential is an OAuth login that expires
// and must be refreshed (design: private/mcp-hub-design.md §4.8). The
// credential is NOT in config.yaml — it lives in a JSON file written by
// an interactive login (e.g. Claude Code's `/design-login`), keyed by a
// top-level property. The hub reads the access token from there and
// refreshes it against `tokenEndpoint` when it nears expiry, writing the
// rotated token back. This is the generic mechanism; `preset` below
// fills it in for known services.
export const McpOAuthRefreshSchema = z.object({
  type: z.literal('oauth-refresh'),
  /** JSON file holding the credential. Default: somora's claude-home
   *  `.credentials.json` (where `/design-login` writes). `~` expands. */
  credentialFile: z.string().optional(),
  /**
   * Top-level key in that file, e.g. `designOauth`. An ordered LIST is
   * also accepted, and the first key actually present in the file wins.
   *
   * That exists because a provider can move the goalposts: Claude
   * Design authenticated off the ordinary login until Anthropic split
   * out a `user:design:*` scope, after which only the separate
   * `/design-login` credential works. A list survives the change in
   * either direction without an operator editing config — and without
   * somora pinning a constant that upstream then invalidates.
   */
  credentialKey: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  /** OAuth token endpoint for the refresh_token grant. */
  tokenEndpoint: z.string().url(),
  /** Whether the hub may refresh the token ITSELF — `true` for every
   *  key, `false` for none, or a LIST of the keys it owns. Set false /
   *  leave a key out when the credential is owned by another process
   *  that rotates it (the Claude CLI's own `claudeAiOauth` login): two
   *  refreshers racing on one rotating refresh-token chain invalidate
   *  each other. Read-only mode just re-reads the file on every connect
   *  and relies on the owner (plus somora's credential sync) to keep it
   *  fresh.
   *
   *  The list form is what the claude-design preset uses: `designOauth`
   *  is somora's to refresh (nothing else keeps it alive — it expired
   *  daily and needed a manual `/design-login`, 2026-08-31 report),
   *  `claudeAiOauth` stays the CLI's. */
  refresh: z.union([z.boolean(), z.array(z.string().min(1))]).default(true),
});
export type McpOAuthRefresh = z.infer<typeof McpOAuthRefreshSchema>;

export const McpServerConfigSchema = z.object({
  /** Known-service preset — fills url/auth/headers so the operator only
   *  writes `preset: claude-design`. Explicit fields still override. */
  preset: z.enum(['claude-design']).optional(),
  /** Phase 1 supports remote HTTP only (streamable-http with automatic
   *  SSE-legacy fallback). `stdio` is Phase 2. */
  transport: z.literal('http').default('http'),
  // Optional when a preset supplies it; validated as URL post-expansion.
  url: z.string().url().optional(),
  /** Refreshable-OAuth auth (see McpOAuthRefreshSchema). Omit for
   *  static-header / no-auth servers. */
  auth: McpOAuthRefreshSchema.optional(),
  /** Static request headers. Values support `${VAR}` / `${VAR:-default}`
   *  env expansion at connect time — `Authorization: "Bearer ${TOKEN}"`
   *  is the idiom for API-key auth. Missing vars fail the connect (state
   *  `failed`), never the config load. */
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  /** Which upstream tools to import. Empty include = all. Exclude wins. */
  tools: z
    .object({
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .default({ include: [], exclude: [] }),
  /** Per tools/call timeout. */
  timeoutMs: z.number().int().positive().default(60_000),
  connectTimeoutMs: z.number().int().positive().default(15_000),
  /** Registry-side cap on the stringified result (DEFAULT_MAX_RESULT_SIZE_CHARS). */
  maxResultChars: z.number().int().positive().optional(),
  /** Servers are called serially by default — many MCP servers mishandle
   *  concurrent requests. Opt in per server only when it's known-safe. */
  supportsParallelToolCalls: z.boolean().default(false),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z
  .object({
    servers: z
      .record(
        z
          .string()
          // Proxy children register as `somora-<name>`; somora's own
          // server is `somora`, so no external name can collide with it.
          .regex(
            /^[a-z0-9][a-z0-9-]{0,29}$/,
            'MCP server name must match [a-z0-9][a-z0-9-]{0,29} (no underscores)',
          ),
        McpServerConfigSchema,
      )
      .default({}),
  })
  .default({ servers: {} });
export type McpConfig = z.infer<typeof McpConfigSchema>;

/**
 * Thinking content — the model's reasoning text shown in the clients
 * (web bubble block, TUI `/verbose thinking`). `capture: false` drops
 * it at the server: no SSE event, no JSONL row, nothing for any client
 * to show. `maxChars` caps what is persisted per turn (a Qwen turn at
 * xhigh can think for tens of thousands of tokens). See docs/thinking.md.
 */
export const ThinkingContentSchema = z
  .object({
    capture: z.boolean().default(true),
    maxChars: z.number().int().positive().default(65_536),
  })
  .default({ capture: true, maxChars: 65_536 });

export const ConfigSchema = z.object({
  thinkingContent: ThinkingContentSchema,
  server: z
    .object({
      // Bind address. Default loopback (private, anti-footgun). Set
      // `0.0.0.0` to accept LAN/Tailscale clients — an explicit,
      // auditable opt-in that lives in config.yaml so it survives
      // `somora update` (unlike a SOMORA_HOST env var in the systemd
      // unit, which the update rebake drops). Env `SOMORA_HOST` still
      // overrides this at runtime if set.
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().positive().default(18737),
      tls: TlsConfigSchema,
    })
    .default({ host: '127.0.0.1', port: 18737 }),
  providers: z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), ProviderSchema),
  compaction: CompactionConfigSchema,
  memory: MemoryConfigSchema,
  rem: RemGlobalConfigSchema,
  agentLoop: AgentLoopConfigSchema,
  engineWatchdog: EngineWatchdogConfigSchema,
  sse: SseConfigSchema,
  tmux: TmuxConfigSchema,
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
  imageGen: ImageGenConfigSchema,
  videoGen: VideoGenConfigSchema,
  projects: ProjectsConfigSchema,
  sentinel: SentinelConfigSchema,
  obsidian: ObsidianConfigSchema,
  wiki: WikiConfigSchema,
  attachments: AttachmentsConfigSchema,
  mcp: McpConfigSchema,
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
 * Human-readable list of every model ref the config accepts — for error
 * messages when a ref doesn't resolve, so the caller (usually an agent
 * that guessed a name) can self-correct without reading config.yaml.
 * Format per model: `alias → provider/modelId` or bare `provider/modelId`.
 */
export function describeModelRefs(config: Config): string {
  const out: string[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      const ref = `${providerName}/${model.id}`;
      out.push(model.alias ? `${model.alias} → ${ref}` : ref);
    }
  }
  return out.join(', ');
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
