// The /mobile tile order: what the server accepts and keeps.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { agentOrderPath, parseAgentOrder, readAgentOrder, writeAgentOrder } from './agent-order.ts';

test('only a list of agent names, each once', () => {
  assert.deepEqual(parseAgentOrder({ order: ['ada', 'bea'] }), { ok: true, order: ['ada', 'bea'] });
  assert.equal(parseAgentOrder({ order: 'ada' }).ok, false);
  assert.equal(parseAgentOrder(null).ok, false);
  assert.match((parseAgentOrder({ order: ['ada', 'ada'] }) as { error: string }).error, /twice/);
  assert.match((parseAgentOrder({ order: ['../etc'] }) as { error: string }).error, /not an agent name/);
  assert.match((parseAgentOrder({ order: [3] }) as { error: string }).error, /not an agent name/);
});

test('saved and read back; nothing saved reads as an empty list', async () => {
  assert.deepEqual(await readAgentOrder(), []);
  await writeAgentOrder(['bea', 'ada']);
  assert.deepEqual(await readAgentOrder(), ['bea', 'ada']);
  assert.deepEqual(JSON.parse(readFileSync(agentOrderPath(), 'utf8')), { order: ['bea', 'ada'] });
});

test('saves at the same moment: one wins whole, no temp file left (review 2026-10-26)', async () => {
  const a = Array.from({ length: 200 }, (_, i) => `agent-a-${i}`);
  const b = ['zed', 'amy'];
  await Promise.all([writeAgentOrder(a), writeAgentOrder(b), writeAgentOrder(a), writeAgentOrder(b)]);
  const saved = JSON.parse(readFileSync(agentOrderPath(), 'utf8')) as { order: string[] };
  assert.deepEqual(saved.order, b, 'the last save, whole');
  assert.deepEqual(readdirSync(dirname(agentOrderPath())).filter((f) => f.includes('.tmp.')), []);
});
