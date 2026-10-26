// One input schema for every engine. The MCP child (claude-cli,
// grok-cli) advertises each tool's jsonSchema, the same one codex-cli and
// openai-compatible get; zod validates the call. The two are written by
// hand, so this guard keeps them telling the same story: the same field
// names, the same required set, and a description on every field (a
// field without one is a guess for a weaker model).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerAllTools, ToolRegistry } from './index.ts';
import type { ToolDefinition } from './types.ts';

/** Fields zod accepts that the JSON schema leaves out on purpose. */
const ACCEPTED_NOT_ADVERTISED: Record<string, string[]> = {
  // Removed 2026-09-10; still accepted so an old call gets a clear refusal.
  image_generate: ['save_to'],
};

const reg = new ToolRegistry();
registerAllTools(reg);

function jsonOf(tool: ToolDefinition): Record<string, unknown> {
  return tool.jsonSchema;
}

function zodOf(tool: ToolDefinition): { properties?: Record<string, { description?: string }>; required?: string[] } {
  return z.toJSONSchema(tool.inputSchema as z.ZodType, { io: 'input', unrepresentable: 'any' }) as never;
}

test('every tool: zod and the JSON schema name the same fields and require the same ones', () => {
  const problems: string[] = [];
  for (const tool of reg.list()) {
    const zs = zodOf(tool);
    const js = jsonOf(tool) as { properties?: Record<string, unknown>; required?: string[] };
    const zp = Object.keys(zs.properties ?? {}).filter((k) => !(ACCEPTED_NOT_ADVERTISED[tool.name] ?? []).includes(k));
    const jp = Object.keys(js.properties ?? {});
    const onlyZod = zp.filter((k) => !jp.includes(k));
    const onlyJson = jp.filter((k) => !zp.includes(k));
    if (onlyZod.length) problems.push(`${tool.name}: zod only ${onlyZod.join(',')}`);
    if (onlyJson.length) problems.push(`${tool.name}: json only ${onlyJson.join(',')}`);
    const zr = [...(zs.required ?? [])].sort().join(',');
    const jr = [...(js.required ?? [])].sort().join(',');
    if (zr !== jr) problems.push(`${tool.name}: required zod [${zr}] json [${jr}]`);
  }
  assert.deepEqual(problems, []);
});

test('every field of every tool has a description', () => {
  const missing: string[] = [];
  for (const tool of reg.list()) {
    const props = (jsonOf(tool).properties ?? {}) as Record<string, { description?: string }>;
    for (const [k, v] of Object.entries(props)) if (!v.description) missing.push(`${tool.name}.${k}`);
  }
  assert.deepEqual(missing, []);
});

test('a zod field text never goes missing from the JSON schema', () => {
  const lost: string[] = [];
  for (const tool of reg.list()) {
    const zp = zodOf(tool).properties ?? {};
    const jp = (jsonOf(tool).properties ?? {}) as Record<string, { description?: string }>;
    for (const [k, v] of Object.entries(zp)) if (v.description && jp[k] && !jp[k]!.description) lost.push(`${tool.name}.${k}`);
  }
  assert.deepEqual(lost, []);
});
