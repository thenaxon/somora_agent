// The tool catalog: one list of always-visible tools for claude-cli and
// codex-cli, always cut to what the turn offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alwaysVisibleTools, DEFAULT_ALWAYS_VISIBLE, REVIEW_LOOP_TOOLS } from './catalog.ts';
import { turnAlwaysVisible } from '../server/turn-tool-catalog.ts';
import { ToolCatalogConfigSchema, type ResolvedModel } from '../config/types.ts';

const OFFERED = ['exec', 'process', 'file_read', 'sentinel', 'browser', 'memory_edit', 'somora_docs_list', 'skill', 'dream_get', 'wiki_edit', 'dream_run'];

test('the default list, cut to what the turn offers, in offered order', () => {
  assert.deepEqual(alwaysVisibleTools(OFFERED), ['exec', 'process', 'file_read', 'skill']);
  assert.ok(!DEFAULT_ALWAYS_VISIBLE.includes('memory_edit') && !DEFAULT_ALWAYS_VISIBLE.includes('somora_docs_list'));
});

test('a gated tool never appears, whatever the list says', () => {
  const catalog = { alwaysVisible: ['exec', 'ask_user', 'sentinel'] };
  assert.deepEqual(alwaysVisibleTools(['exec'], { catalog }), ['exec']);
  assert.deepEqual(alwaysVisibleTools(['exec', 'ask_user'], { catalog }), ['exec', 'ask_user'], 'ask_user only when offered');
});

test('review loop: dream and wiki review tools join, dream_run does not', () => {
  const r = alwaysVisibleTools(OFFERED, { inReviewLoop: true });
  assert.ok(r.includes('dream_get') && r.includes('wiki_edit'));
  assert.ok(!r.includes('dream_run'));
  assert.ok(!alwaysVisibleTools(OFFERED).includes('dream_get'), 'outside the loop they stay deferred');
  assert.ok(REVIEW_LOOP_TOOLS.every((n) => n.startsWith('dream_') || n === 'wiki_edit'));
});

test('a builder: everything it is offered', () => {
  assert.deepEqual(alwaysVisibleTools(OFFERED, { kind: 'builder' }), OFFERED);
});

test('per-engine and per-model patches', () => {
  const catalog = {
    alwaysVisible: ['exec'],
    engines: { 'codex-cli': { add: ['sentinel'] } },
    models: { weak: { add: ['browser'] }, 'p/big': { remove: ['exec'] } },
  };
  assert.deepEqual(alwaysVisibleTools(OFFERED, { catalog, engine: 'codex-cli' }), ['exec', 'sentinel']);
  assert.deepEqual(alwaysVisibleTools(OFFERED, { catalog, engine: 'claude-cli' }), ['exec']);
  assert.deepEqual(alwaysVisibleTools(OFFERED, { catalog, modelRefs: ['p/small', 'weak'] }), ['exec', 'browser']);
  assert.deepEqual(alwaysVisibleTools(OFFERED, { catalog, modelRefs: ['p/big'] }), []);
});

test('legacy codexCli.directTools replaces the base list for codex-cli only', () => {
  const legacy = ['sentinel', 'memory_edit'];
  assert.deepEqual(alwaysVisibleTools(OFFERED, { engine: 'codex-cli', legacyCodexDirect: legacy }), ['sentinel', 'memory_edit']);
  assert.deepEqual(alwaysVisibleTools(OFFERED, { engine: 'claude-cli', legacyCodexDirect: legacy }), ['exec', 'process', 'file_read', 'skill']);
});

test('config: defaults to the catalog; turnAlwaysVisible follows the answering model', () => {
  const parsed = ToolCatalogConfigSchema.parse(undefined);
  assert.deepEqual(parsed.alwaysVisible, [...DEFAULT_ALWAYS_VISIBLE]);
  const config = {
    toolCatalog: { ...parsed, engines: { 'codex-cli': { add: ['browser'] } }, models: { tiny: { add: ['sentinel'] } } },
    codexCli: { toolTimeoutSec: 1800, shellEnvironmentPolicy: 'inherit-all' as const },
  };
  const pick = turnAlwaysVisible({ config: config as never, agent: 'nobody', kind: 'chat', offered: OFFERED });
  const model = (engine: string, alias?: string): ResolvedModel =>
    ({ providerName: 'p', modelId: 'm', provider: { engine }, model: { id: 'm', ...(alias ? { alias } : {}) } }) as unknown as ResolvedModel;
  assert.ok(pick(model('codex-cli')).includes('browser'));
  assert.ok(!pick(model('claude-cli')).includes('browser'), 'a fallback on another engine gets that engine\'s list');
  assert.ok(pick(model('openai-compatible', 'tiny')).includes('sentinel'));
});
