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

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly jsonSchema: Record<string, unknown>;
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
