import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveThinking } from './thinking-resolve.ts';

const withDefault = { reasoning: { default: 'off' as const } };

test('order: session, then agent, then model default, then nothing', () => {
  assert.deepEqual(resolveThinking({ thinking: 'low' }, { thinkingOverride: 'high' }, withDefault), { level: 'high', source: 'session-override' });
  assert.deepEqual(resolveThinking({ thinking: 'low' }, {}, withDefault), { level: 'low', source: 'persona-default' });
  assert.deepEqual(resolveThinking({}, {}, withDefault), { level: 'off', source: 'model-default' });
  assert.deepEqual(resolveThinking({}, {}, {}), { level: undefined, source: 'engine-default' });
  assert.deepEqual(resolveThinking({}, {}), { level: undefined, source: 'engine-default' });
});

test('an invalid stored override is ignored', () => {
  assert.deepEqual(resolveThinking({}, { thinkingOverride: 'max' }, withDefault), { level: 'off', source: 'model-default' });
});
