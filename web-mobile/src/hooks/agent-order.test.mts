// The agent tiles' order: saved names first, the rest by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAgentOrder, moveItem } from './agent-order.ts';

const a = (name: string) => ({ name });
const names = (l: Array<{ name: string }>) => l.map((x) => x.name);

test('saved order first, then the rest by name; unknown saved names are skipped', () => {
  const agents = ['delta', 'alpha', 'echo', 'bravo', 'charlie'].map(a);
  assert.deepEqual(names(applyAgentOrder(agents, ['echo', 'gone', 'bravo'])), ['echo', 'bravo', 'alpha', 'charlie', 'delta']);
  assert.deepEqual(names(applyAgentOrder(agents, [])), ['alpha', 'bravo', 'charlie', 'delta', 'echo'], 'no order: by name, as before');
});

test('moving an item', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b'], 1, 9), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 5, 0), ['a', 'b']);
});
