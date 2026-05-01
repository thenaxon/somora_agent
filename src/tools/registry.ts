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

import { logger } from '../server/logger.ts';
import type { ToolContext, ToolDefinition, ToolResult } from './types.ts';

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

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /**
   * Validate input against the tool's Zod schema, run the handler, and
   * wrap the result in a ToolResult. Catches handler errors so callers
   * (MCP, agent-loop, HTTP) get a uniform shape.
   */
  async invoke(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `unknown tool '${name}'` };
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
      logger.info({
        msg: 'tool.invoked',
        name,
        agent: ctx.agent,
        ms: Date.now() - start,
      });
      return { ok: true, data };
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
