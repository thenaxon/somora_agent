// The /mobile tile order: what the server accepts and keeps.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentOrderPath, parseAgentOrder, readAgentOrder, writeAgentOrder } from './agent-order.ts';

test('only a list of agent names, each once', () => {
  assert.deepEqual(parseAgentOrder({ order: ['hans', 'lisa'] }), { ok: true, order: ['hans', 'lisa'] });
  assert.equal(parseAgentOrder({ order: 'hans' }).ok, false);
  assert.equal(parseAgentOrder(null).ok, false);
  assert.match((parseAgentOrder({ order: ['hans', 'hans'] }) as { error: string }).error, /twice/);
  assert.match((parseAgentOrder({ order: ['../etc'] }) as { error: string }).error, /not an agent name/);
  assert.match((parseAgentOrder({ order: [3] }) as { error: string }).error, /not an agent name/);
});

test('saved and read back; nothing saved reads as an empty list', async () => {
  assert.deepEqual(await readAgentOrder(), []);
  await writeAgentOrder(['lisa', 'hans']);
  assert.deepEqual(await readAgentOrder(), ['lisa', 'hans']);
  assert.deepEqual(JSON.parse(readFileSync(agentOrderPath(), 'utf8')), { order: ['lisa', 'hans'] });
});
