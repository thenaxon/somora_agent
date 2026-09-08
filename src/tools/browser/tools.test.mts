// The MCP tool child registers tools from `inputSchema.shape` — a plain
// ZodObject. hans's first live call (2026-09-08) reached the tool with
// `op` stripped because the schema was a discriminated union. Pin it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTool } from './tools.ts';

test('browser tool input schema is a plain ZodObject with an `op` shape entry', () => {
  const shape = (browserTool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  assert.ok(shape && typeof shape === 'object', 'inputSchema.shape exists');
  assert.ok('op' in shape!, 'shape has op');
  const parsed = browserTool.inputSchema.safeParse({ op: 'open', url: 'https://example.com/' });
  assert.equal(parsed.success, true);
  assert.equal(browserTool.inputSchema.safeParse({ op: 'nope' }).success, false);
});

test('per-op requirements are refused before any browser work', async () => {
  const ctx = { agent: 'x', config: { browser: { enabled: true } } } as never;
  const r1 = await browserTool.handler({ op: 'open' } as never, ctx);
  assert.equal(r1.ok, false);
  assert.match(r1.error ?? '', /open needs url/);
  const r2 = await browserTool.handler({ op: 'act', tab: 't1' } as never, ctx);
  assert.match(r2.error ?? '', /act needs action/);
  const r3 = await browserTool.handler({ op: 'snapshot' } as never, ctx);
  assert.match(r3.error ?? '', /snapshot needs tab/);
});
