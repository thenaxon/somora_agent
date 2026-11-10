// A model's `builder:` block applies to builders only, merged per key.
import assert from 'node:assert/strict';
import { ModelSchema, modelForKind, type ResolvedModel } from './types.ts';

const model = ModelSchema.parse({
  id: 'm',
  alias: 'mm',
  contextWindow: 100_000,
  maxTokens: 16_384,
  sampling: { temperature: 1.0, top_p: 0.95 },
  reasoning: { levels: { low: 'low', medium: 'high', high: 'max' } },
  builder: { maxTokens: 65_536, thinking: 'medium' },
});
const resolved = { providerName: 'p', provider: {} as never, modelId: 'm', model } as ResolvedModel;

// a chat agent sees the model as configured
assert.equal(modelForKind(resolved, 'chat'), resolved);
assert.equal(modelForKind(resolved, undefined), resolved);

// a builder gets the builder values over the model's own; levels stay
const b = modelForKind(resolved, 'builder').model;
assert.equal(b.maxTokens, 65_536);
assert.equal(b.reasoning?.default, 'medium');
assert.deepEqual(b.reasoning?.levels, { low: 'low', medium: 'high', high: 'max' }, 'levels kept');
assert.deepEqual(b.sampling, { temperature: 1.0, top_p: 0.95 }, 'sampling untouched');
assert.equal(model.maxTokens, 16_384, 'the configured model is not changed');

// a model without the block is the same for both
const plain = { ...resolved, model: ModelSchema.parse({ id: 'x', contextWindow: 1000, maxTokens: 10 }) };
assert.equal(modelForKind(plain, 'builder'), plain);

// unknown keys in the block are a config error, not silently ignored
assert.throws(() => ModelSchema.parse({ id: 'y', contextWindow: 1000, builder: { maxToken: 5 } }));

console.log('model-for-kind.test: ok');
