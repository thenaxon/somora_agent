// Run: npx tsx src/engine/codex-dynamic-tools.test.mts
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  buildCodexToolCatalog,
  codexToolGuidance,
  toolResultToCodexResponse,
  CODEX_NS,
  CODEX_DIRECT_NS,
} from './codex-dynamic-tools.ts';
import type { ToolDefinition } from '../tools/types.ts';

const def = (name: string, toolset = 'memory'): ToolDefinition =>
  ({
    name,
    description: `${name} desc`,
    inputSchema: z.object({}),
    jsonSchema: { type: 'object', properties: {} },
    toolset: toolset as ToolDefinition['toolset'],
    async handler() {
      return {};
    },
  }) as unknown as ToolDefinition;

const cat = buildCodexToolCatalog(
  [def('time_now'), def('exec', 'exec'), def('dream_list'), def('file_read', 'file'), def('mcp__github__create_issue'), def('bad name!')],
  ['time_now', 'exec'],
);
const ns = Object.fromEntries(cat.specs.map((s) => [s.name, s]));
assert.ok(ns[CODEX_NS] && ns[CODEX_NS].type === 'namespace');
const somoraTools = (ns[CODEX_NS] as { tools: Array<{ name: string; deferLoading?: boolean }> }).tools;
assert.deepEqual(
  somoraTools.map((t) => [t.name, t.deferLoading ?? false]),
  [
    ['time_now', false],
    ['exec', false],
    ['dream_list', true],
  ],
);
assert.ok(ns[CODEX_DIRECT_NS], 'file_read lands in the direct-only namespace');
assert.deepEqual(cat.directOnlyNamespaces, [CODEX_DIRECT_NS]);
assert.ok(ns['somora_mcp_github'], 'hub tools get a per-server namespace');
assert.equal((ns['somora_mcp_github'] as { tools: Array<{ name: string }> }).tools[0]!.name, 'create_issue');
assert.equal(cat.resolve('somora_mcp_github', 'create_issue'), 'mcp__github__create_issue');
assert.equal(cat.resolve(CODEX_NS, 'exec'), 'exec');
assert.equal(cat.resolve(null, 'time_now'), 'time_now');
assert.equal(cat.resolve(CODEX_DIRECT_NS, 'file_read'), 'file_read');
assert.equal(cat.resolve(null, 'nope'), undefined);
assert.deepEqual(cat.deferredNames, ['dream_list', 'mcp__github__create_issue']);
assert.deepEqual(cat.skipped.map((s) => s.name), ['bad name!']);
assert.match(codexToolGuidance(cat), /dream_list/);
assert.deepEqual(toolResultToCodexResponse({ ok: true, data: { a: 1 } }), {
  contentItems: [{ type: 'inputText', text: '{"a":1}' }],
  success: true,
});
assert.equal(toolResultToCodexResponse({ ok: false, error: 'boom' }).success, false);
const img = toolResultToCodexResponse({
  ok: true,
  contentBlocks: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }],
});
assert.equal(img.contentItems[0]!.type, 'inputImage');
console.log('codex-dynamic-tools: all tests passed');
