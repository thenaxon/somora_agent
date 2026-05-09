// Tool-System (DECISIONS #23, #31). Engine-agnostic tool definitions plus
// a small registry that the MCP server (claude-cli/codex-cli hookup) and
// the future agent-loop (openai-compatible, Phase 2-Stufe-C) both consume.
//
// Each tool defines:
//   - name           — globally unique, also the MCP method / OpenAI fn name
//   - description    — what the LLM sees in the tool list. Be explicit about
//                      scope, what's allowed, what isn't. Small models
//                      (gemma) need clear boundaries.
//   - inputSchema    — Zod schema for runtime validation
//   - jsonSchema     — JSON-Schema for MCP / OpenAI tool definitions
//                      (we hand-write it, tighter than zod-to-json-schema
//                      auto-conversion would give us)
//   - handler        — receives validated input + context, throws on errors;
//                      registry catches and converts to ToolResult.

import type { z } from 'zod';
import type { Config, ResolvedModel } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { ContentBlock } from '../multimodal/blocks.ts';

export interface ToolContext {
  /** Agent name owning this invocation. Memory tools scope by this. */
  agent: string;
  /**
   * Session id this tool is being invoked from. Used by spawn_subagent
   * and similar A2A tools to record `parent_session` in the sub's
   * spawn-meta for traceability.
   *
   * In-process calls (openai-compatible agent-loop) always have this.
   * MCP-served calls (claude-cli/codex-cli) read it from
   * SOMORA_SESSION env set by the engine launcher per turn.
   */
  session?: string;
  /**
   * Nesting depth of the current turn. 0 = top-level user turn.
   * Increments when spawn_subagent kicks off a sub. Used for the
   * recursion cap (default 3) and to skip self-pointer rewrites
   * inside subs.
   */
  subagentDepth?: number;
  /**
   * Lazy accessor — only initialized if the tool actually needs the manager,
   * so tools that don't touch memory (later workspace_*, etc.) don't pay
   * the embedder warmup cost.
   */
  getMemoryManager: () => Promise<MemoryManager>;
  /**
   * Read-only access to the server config. Tools pluck only the slice
   * they need (web tools read `config.web.brave.apiKey`, etc.). Never
   * mutate from a tool handler.
   */
  config: Config;
  /**
   * The model the active turn is running against. Used by capability-
   * gated tools (e.g., file_read polymorph checks for `image`/`pdf`
   * before returning a multimodal result). Populated by run-turn.ts
   * for in-process engines and by the MCP child via the
   * SOMORA_ACTIVE_MODEL env var. Optional because some legacy contexts
   * (tests, debug HTTP `/tools` invokes) don't have a turn.
   */
  activeModel?: ResolvedModel;
}

/**
 * Special handler return shape for tools that produce native content
 * blocks (image, document, mixed) instead of a plain JSON-able object.
 * Detected by the registry's `invoke()` and forwarded as content
 * blocks through MCP / openai-compatible adapter without going through
 * `JSON.stringify` — image bytes would be unusable otherwise.
 *
 * The `_somoraMultimodal` brand is the discriminator; tools opt-in by
 * returning this shape. Existing tools continue returning regular
 * objects (passing through the legacy `data` path).
 */
export interface MultimodalToolResult {
  _somoraMultimodal: true;
  contentBlocks: ContentBlock[];
}

export function isMultimodalToolResult(v: unknown): v is MultimodalToolResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    '_somoraMultimodal' in v &&
    (v as { _somoraMultimodal?: unknown })._somoraMultimodal === true
  );
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  /** Present when ok=true and the tool returned a regular JSON-able
   *  payload. Mutually exclusive with `contentBlocks`. */
  data?: T;
  /** Present when ok=true and the tool returned multimodal content
   *  (image/document/mixed). Forwarded as MCP image content blocks for
   *  claude-cli/codex-cli, and as OpenAI-style image content for the
   *  in-process openai-compatible engine. */
  contentBlocks?: ContentBlock[];
  /** Present when ok=false. Human-readable, also goes to the LLM as
   *  tool_result error text. */
  error?: string;
}

/**
 * Default cap for stringified tool results — `maxResultSizeChars` falls
 * back to this when a tool doesn't set its own. ~100k chars ≈ 25-35k
 * tokens (4 chars/token heuristic); fits comfortably in any current
 * model context without dominating it. Tools that legitimately produce
 * larger outputs (file_read paged, web_fetch with explicit maxChars)
 * should override on their definition.
 */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 100_000;

/**
 * Toolset tag — groups tools for log filtering and future allow/deny
 * lists (e.g. `tools.profile: minimal` would expose only memory + dream).
 * Add new tags here when introducing a new tool family.
 */
export type Toolset =
  | 'memory'
  | 'dream'
  | 'wiki'
  | 'web'
  | 'file'
  | 'exec'
  | 'time'
  | 'agents'
  | 'skills';

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly jsonSchema: Record<string, unknown>;
  /**
   * Grouping tag for logging / future allow-deny lists. Required so new
   * tools always declare their family.
   */
  readonly toolset: Toolset;
  /**
   * Cap on the JSON-stringified result. Registry truncates and replaces
   * the payload with a `{ truncated: true, ... }` marker if the handler
   * returns more. Default: DEFAULT_MAX_RESULT_SIZE_CHARS.
   */
  readonly maxResultSizeChars?: number;
  /**
   * Runtime availability probe. When false, the tool is hidden from
   * `list()` (so the model never sees a tool it can't actually run —
   * missing API key, unconfigured vault, etc.) and `invoke()` returns
   * an error if called anyway. Cheap to call (typically a config read);
   * registry queries it per turn, no caching.
   */
  available?: (ctx: ToolContext) => boolean | Promise<boolean>;
  /**
   * Static per-tool timeout override for the engine-level race. When unset,
   * the engine falls back to `agentLoop.toolCallTimeoutMs` (default 30s).
   * Use for tools whose worst-case is reliably longer than 30s independent
   * of input (rare — most variability is input-driven, see timeoutFromInput).
   */
  readonly defaultTimeoutMs?: number;
  /**
   * Dynamic per-call timeout. Receives the validated input, returns the
   * timeout to apply for *this* invocation, or undefined to fall through
   * to defaultTimeoutMs / global. Use for tools where the caller
   * communicates how long they're willing to wait — subagent_result with
   * wait_until_done, agent_ask, exec, tmux_capture-with-pattern.
   *
   * The OpenClaw pattern: caller declares timeoutMs, the gateway/engine
   * waits exactly that long, plus a small (~2s) buffer to round-trip the
   * "still running" reply.
   */
  readonly timeoutFromInput?: (input: TInput) => number | undefined;
  /**
   * Hard ceiling for both static and dynamic timeouts. Prevents the model
   * from sending a malformed timeout_ms value that pins a slot for hours.
   * Defaults to no cap when unset.
   */
  readonly maxTimeoutMs?: number;
  handler: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
}

/**
 * Engine-facing slice of the tool registry — list of available tools plus
 * a context-bound invoke. Server constructs this per turn (binds the
 * agent + memory manager into a closure) and hands it to engines that
 * run their own agent-loop (currently only openai-compatible).
 *
 * Engines that delegate tool dispatch to a CLI subprocess (claude-cli,
 * codex-cli) ignore this — they configure the somora-memory MCP server
 * separately, and the CLI handles list+invoke internally.
 */
export interface ToolInvoker {
  list(): ToolDefinition[];
  invoke(name: string, input: unknown): Promise<ToolResult>;
}
