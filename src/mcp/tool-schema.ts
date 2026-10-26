// Unknown keys on the MCP child (2026-09-25): the SDK once got
// only `schema.shape` and rebuilt a plain z.object() from it — which
// STRIPS unknown keys. `exec({resource: "gpu-box", command})` lost its
// `resource`, `target` defaulted to local, and a command meant for a
// remote host ran on the somora host. The child advertises each tool's
// JSON schema now and validates with registry.invoke; a key the tool
// does not know is refused before that, naming the key.
import { z } from 'zod';
import type { ToolDefinition } from '../tools/types.ts';

export function unknownInputKeys(tool: Pick<ToolDefinition, 'inputSchema' | 'toolset'>, args: unknown): string[] {
  // Bridged hub tools take whatever the model sends (validation is the
  // upstream server's job).
  if (tool.toolset === 'mcp') return [];
  const schema = tool.inputSchema as z.ZodType<unknown>;
  if (!(schema instanceof z.ZodObject)) return [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const shape = schema.shape as Record<string, unknown>;
  return Object.keys(args).filter((k) => !(k in shape));
}

/**
 * The schema the child advertises: the tool's own JSON schema — the one
 * codex-cli and openai-compatible get — without top-level oneOf / anyOf
 * / allOf. The Anthropic API refuses an input_schema that has one at the
 * top (browser spells its per-op variants that way for the other
 * engines); the flat properties stay, and the handler checks each op's
 * required fields anyway.
 */
export function mcpAdvertisedSchema(tool: Pick<ToolDefinition, 'jsonSchema'>): { type: 'object'; [k: string]: unknown } {
  const { oneOf: _o, anyOf: _a, allOf: _l, ...rest } = tool.jsonSchema as Record<string, unknown>;
  return { ...rest, type: 'object' };
}
