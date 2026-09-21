// A nested object sent as its JSON text is read — only when the input
// would be rejected anyway.
// Run: npx tsx src/tools/registry-unstringify.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-unstringify-'));
const { ToolRegistry } = await import('./registry.ts');

const seen: unknown[] = [];
const reg = new ToolRegistry();
reg.register({
  name: 'demo',
  toolset: 'demo',
  description: 'x',
  inputSchema: z.object({
    action: z.string(),
    dispatch: z.object({ agent: z.string(), prompt: z.string() }).optional(),
    tags: z.array(z.string()).optional(),
    note: z.string().optional(),
  }).strict(),
  jsonSchema: { type: 'object' },
  async handler(input: unknown) {
    seen.push(input);
    return { ok: true };
  },
} as never);
const ctx = { agent: 'a', config: {} } as never;

// The live shape (loki / Qwen, 2026-09-21).
let r = await reg.invoke('demo', { action: 'create', dispatch: '{"agent": "loki", "prompt": "test"}', tags: '["x","y"]' }, ctx);
assert.equal(r.ok, true, JSON.stringify(r));
assert.deepEqual(seen.pop(), { action: 'create', dispatch: { agent: 'loki', prompt: 'test' }, tags: ['x', 'y'] });

// Valid input is passed through untouched — including a STRING field that happens to hold JSON.
r = await reg.invoke('demo', { action: 'create', note: '{"this":"is a string field"}' }, ctx);
assert.equal(r.ok, true);
assert.deepEqual(seen.pop(), { action: 'create', note: '{"this":"is a string field"}' });

// Text that is not JSON: the original error stands.
r = await reg.invoke('demo', { action: 'create', dispatch: 'loki please' }, ctx);
assert.equal(r.ok, false);
assert.match((r as { error: string }).error, /dispatch/);

// JSON text whose content is still wrong: rejected, with the real reason.
r = await reg.invoke('demo', { action: 'create', dispatch: '{"agent": 5}' }, ctx);
assert.equal(r.ok, false);
assert.match((r as { error: string }).error, /dispatch\.agent/, 'the error points inside the object');

// Unknown keys stay rejected.
r = await reg.invoke('demo', { action: 'create', 'dispatch.agent': 'loki' }, ctx);
assert.equal(r.ok, false);
console.log('registry-unstringify: all passed');
