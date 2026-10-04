import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SOMORA_HOME ??= `/tmp/somora-override-model-${process.pid}`;
const { findOverrideModel } = await import('./summarize.ts');

const m = (providerName: string, modelId: string, alias?: string) =>
  ({ providerName, modelId, provider: { engine: 'openai-compatible', models: [] }, model: { id: modelId, ...(alias ? { alias } : {}), contextWindow: 1, capabilities: ['text'] } }) as never;
const models = [m('fake', 'alpha-1', 'alpha'), m('fake', 'beta-1'), m('other', 'beta-1', 'ob')];

test('compaction.modelOverride: alias, bare model id and provider/modelId all name a model', () => {
  assert.equal((findOverrideModel(models, 'alpha') as { modelId: string }).modelId, 'alpha-1');
  assert.equal((findOverrideModel(models, 'alpha-1') as { modelId: string }).modelId, 'alpha-1');
  assert.equal((findOverrideModel(models, 'fake/alpha-1') as { modelId: string }).modelId, 'alpha-1');
});

test('provider/modelId picks the right provider when two carry the same model id', () => {
  assert.equal((findOverrideModel(models, 'other/beta-1') as { providerName: string }).providerName, 'other');
  assert.equal((findOverrideModel(models, 'fake/beta-1') as { providerName: string }).providerName, 'fake');
});

test('a name that matches nothing stays unresolved', () => {
  assert.equal(findOverrideModel(models, 'nope'), undefined);
  assert.equal(findOverrideModel(models, 'nope/alpha-1'), undefined);
});
