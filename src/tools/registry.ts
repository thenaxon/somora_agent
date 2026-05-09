// Tool registry — central in-process catalog of available tools. Owned
// by the server, populated at startup, consumed by:
//   - the MCP server (Phase 2-Stufe-B Abschluss) — exposes the catalog
//     over stdio for claude-cli / codex-cli
//   - the agent-loop (Phase 2-Stufe-C) — feeds tool definitions to the
//     openai-compatible chat.completions API and dispatches tool_calls
//   - HTTP debug endpoints — let humans / external clients invoke tools
//     for testing without going through an LLM
//
// Tools are registered once at server boot. Registration is idempotent
// per name (re-register replaces — useful for dev:server hot reload).

import { isLoopHolder } from '../dream/loop-state.ts';
import { logger } from '../server/logger.ts';
import {
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  isMultimodalToolResult,
  type ToolContext,
  type ToolDefinition,
  type Toolset,
  type ToolResult,
} from './types.ts';

/**
 * Toolsets that get hidden from the agent that holds the active
 * dream_review wiki-loop. We want the holder focused on the wiki
 * conversation, not file-mucking, exec, parallel agents, or skill
 * detours. The loop's positive surface (`wiki_*`) is exposed via the
 * tools' own `available` hooks. memory_*, dream_*, time_*, web_*,
 * and somora_docs_* stay enabled (the agent still needs to think,
 * note things, fact-check, and end the loop).
 */
const LOOP_HIDDEN_TOOLSETS = new Set<Toolset>(['file', 'exec', 'agents', 'skills']);

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      logger.debug({ msg: 'tool.re_register', name: tool.name });
    }
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Full catalog — debug / HTTP /tools endpoint. Includes tools that
   *  may not be available in any given context. */
  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Tools whose `available(ctx)` returns truthy (or that don't define
   * one). Used by per-turn ToolInvoker construction so the model only
   * sees tools it can actually invoke right now (no API key → no
   * web_search exposed, no vault → no obsidian_* exposed, etc.).
   */
  async listAvailable(ctx: ToolContext): Promise<ToolDefinition[]> {
    // Loop-holder narrows the surface: file/exec/agents/skills get
    // hidden so the agent stays on the wiki conversation. tmux is
    // hidden too via the LOOP_HIDDEN_TOOLSETS set below — added at
    // import-time. Other agents (non-holders) see their normal
    // surface; they just don't get wiki_* (gated by the wiki tools'
    // own available()).
    const holdsLoop = isLoopHolder(ctx.agent);
    const out: ToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (holdsLoop && tool.toolset && LOOP_HIDDEN_TOOLSETS.has(tool.toolset)) {
        logger.debug({
          msg: 'tool.hidden_during_loop',
          name: tool.name,
          toolset: tool.toolset,
          agent: ctx.agent,
        });
        continue;
      }
      if (!tool.available) {
        out.push(tool);
        continue;
      }
      try {
        const ok = await tool.available(ctx);
        if (ok) out.push(tool);
        else logger.debug({ msg: 'tool.unavailable', name: tool.name, agent: ctx.agent });
      } catch (err) {
        logger.warn({
          msg: 'tool.available_threw',
          name: tool.name,
          agent: ctx.agent,
          err: (err as Error).message,
        });
        // Fail-closed: if the availability probe itself errored, hide
        // the tool. Better the model doesn't see it than that it tries
        // and gets an obscure error.
      }
    }
    return out;
  }

  /**
   * Validate input against the tool's Zod schema, run the handler, and
   * wrap the result in a ToolResult. Catches handler errors so callers
   * (MCP, agent-loop, HTTP) get a uniform shape.
   *
   * Also enforces `maxResultSizeChars` — if the JSON-stringified
   * payload exceeds the cap, the data is replaced with a truncation
   * marker. Keeps a runaway tool result from blowing the model's
   * context window.
   */
  async invoke(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `unknown tool '${name}'` };
    }
    if (tool.available) {
      try {
        const ok = await tool.available(ctx);
        if (!ok) {
          return { ok: false, error: `tool '${name}' is not available in this context` };
        }
      } catch (err) {
        return {
          ok: false,
          error: `availability check for '${name}' failed: ${(err as Error).message}`,
        };
      }
    }
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      logger.debug({
        msg: 'tool.input_invalid',
        name,
        agent: ctx.agent,
        issues,
      });
      return { ok: false, error: `invalid input for ${name}: ${issues}` };
    }
    const start = Date.now();
    try {
      const data = await tool.handler(parsed.data, ctx);
      // Multimodal results (image / document / mixed content blocks)
      // skip the JSON-stringify size cap — image bytes would explode it
      // unhelpfully. Per-modality byte caps are enforced upstream by
      // the loader (`src/multimodal/load.ts`).
      if (isMultimodalToolResult(data)) {
        logger.info({
          msg: 'tool.invoked',
          name,
          agent: ctx.agent,
          ms: Date.now() - start,
          multimodal: true,
          blocks: data.contentBlocks.length,
        });
        return { ok: true, contentBlocks: data.contentBlocks };
      }
      const cap = tool.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE_CHARS;
      const capped = enforceResultCap(data, cap);
      logger.info({
        msg: 'tool.invoked',
        name,
        agent: ctx.agent,
        ms: Date.now() - start,
        ...(capped.truncated
          ? { result_truncated: true, result_chars: capped.originalChars, cap_chars: cap }
          : {}),
      });
      return { ok: true, data: capped.value };
    } catch (err) {
      const message = (err as Error).message;
      logger.warn({
        msg: 'tool.invoke_failed',
        name,
        agent: ctx.agent,
        err: message,
        ms: Date.now() - start,
      });
      return { ok: false, error: message };
    }
  }
}

interface CapResult {
  value: unknown;
  truncated: boolean;
  originalChars: number;
}

/**
 * Measure the JSON-stringified size of a tool's data payload. When it
 * exceeds the per-tool cap, replace the payload with a marker object
 * the model will read as "this would have been too big". The preview is
 * the first cap-200 chars of the original JSON so the model still gets
 * a taste of what was returned.
 */
function enforceResultCap(value: unknown, cap: number): CapResult {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    // Non-serializable result (e.g. circular ref). Pass through —
    // downstream serialization will surface its own error.
    return { value, truncated: false, originalChars: 0 };
  }
  if (json.length <= cap) {
    return { value, truncated: false, originalChars: json.length };
  }
  const previewBudget = Math.max(0, cap - 200);
  return {
    value: {
      truncated: true,
      original_size_chars: json.length,
      cap_chars: cap,
      preview: json.slice(0, previewBudget) + '... [truncated]',
      hint: 'Result exceeded the tool\'s size cap. Re-run with a tighter query, lower limit, or paginated read.',
    },
    truncated: true,
    originalChars: json.length,
  };
}
