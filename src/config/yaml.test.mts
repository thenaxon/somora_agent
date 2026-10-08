// somora's YAML reader keeps js-yaml 4's meaning across the js-yaml 5 upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from './yaml.ts';

test('merge keys still merge', () => {
  const doc = parseYaml('base: &b\n  model: opus\n  thinking: high\nagent:\n  <<: *b\n  thinking: low\n');
  assert.deepEqual((doc as { agent: unknown }).agent, { model: 'opus', thinking: 'low' });
});

test('a blank file reads as nothing instead of throwing', () => {
  assert.equal(parseYaml(''), undefined);
  assert.equal(parseYaml('  \n\n'), undefined);
  assert.equal(parseYaml('# only a comment\n  # another\n'), undefined);
  assert.deepEqual(parseYaml('# head\nkey: 1\n'), { key: 1 });
});

test("off and yes stay words, dates stay text", () => {
  assert.deepEqual(parseYaml('thinking: off\nconfirm: yes\nflag: true\nsince: 2026-10-08\n'), { thinking: 'off', confirm: 'yes', flag: true, since: '2026-10-08' });
});
