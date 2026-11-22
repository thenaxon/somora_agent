// The pickers' loose match (2026-11-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looseScore, rankItems } from './picker.tsx';

test('letters in order match, missing ones do not', () => {
  assert.notEqual(looseScore('ada:main-notes', 'amn'), null);
  assert.equal(looseScore('ada', 'xyz'), null);
  assert.equal(looseScore('ada', 'daa'), null);
  assert.equal(looseScore('anything', ''), 0);
});

test('adjacent letters and word starts rank first', () => {
  const items = [
    { value: '1', label: 'xmxaxixn' },
    { value: '2', label: 'main' },
    { value: '3', label: 'domain' },
  ];
  assert.deepEqual(rankItems(items, 'main').map((i) => i.value), ['2', '3', '1']);
  assert.deepEqual(rankItems(items, '').map((i) => i.value), ['1', '2', '3']);
  assert.deepEqual(rankItems(items, 'zz'), []);
});

test('the hint counts too', () => {
  const items = [{ value: 'a', label: 'ada', hint: 'research helper' }, { value: 'b', label: 'bo', hint: 'builder' }];
  assert.deepEqual(rankItems(items, 'research').map((i) => i.value), ['a']);
});
