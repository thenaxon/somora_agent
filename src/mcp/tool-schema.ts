// The input schema a somora tool is registered with on the MCP child
// server (hans, 2026-09-25): the SDK used to get only `schema.shape`
// and rebuilt a plain z.object() from it — which STRIPS unknown keys.
// `exec({resource: "cerebro", command})` lost its `resource`, `target`
// defaulted to local, and a command meant for a remote host ran on the
// somora host. The registry validates with the tool's own (strict)
// schema in-process and for codex; the MCP path now does the same:
// the full schema, made strict when it is an object, so an unknown
// key is refused with the SDK's "Input validation error" naming it.
import { z } from 'zod';
import type { ToolDefinition } from '../tools/types.ts';

export function mcpInputSchemaFor(tool: Pick<ToolDefinition, 'inputSchema' | 'toolset'>): z.ZodType<unknown> {
  const schema = tool.inputSchema as z.ZodType<unknown>;
  // Bridged hub tools take whatever the model sends (validation is the
  // upstream server's job) — leave their passthrough object alone.
  if (tool.toolset === 'mcp') return schema;
  if (schema instanceof z.ZodObject) return schema.strict() as z.ZodType<unknown>;
  return schema;
}
