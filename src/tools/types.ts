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
import type { MemoryManager } from '../memory/manager.ts';

export interface ToolContext {
  /** Agent name owning this invocation. Memory tools scope by this. */
  agent: string;
  /**
   * Lazy accessor — only initialized if the tool actually needs the manager,
   * so tools that don't touch memory (later workspace_*, etc.) don't pay
   * the embedder warmup cost.
   */
  getMemoryManager: () => Promise<MemoryManager>;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  /** Present when ok=true. */
  data?: T;
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
 * Add new tags here when introducing a new tool family; document the
 * rationale in docs/research/tool-architecture.md.
 */
export type Toolset =
  | 'memory'
  | 'dream'
  | 'web'
  | 'obsidian'
  | 'file'
  | 'exec'
  | 'time';

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
