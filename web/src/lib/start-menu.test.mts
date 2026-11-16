// Run: cd web && npx tsx src/lib/start-menu.test.mts
import assert from 'node:assert/strict';
import { readHidden, searchEntries, toggled, writeHidden } from './start-menu';

let ok = 0;
const t = (name: string, fn: () => void) => {
  fn();
  ok++;
  console.log('  ok  ', name);
};

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

t('nothing stored: everything on the desktop', () => assert.equal(readHidden().size, 0));
t('a toggle is stored and read back', () => {
  writeHidden(toggled(new Set(), 'app:log'));
  assert.deepEqual([...readHidden()], ['app:log']);
  writeHidden(toggled(readHidden(), 'app:log'));
  assert.equal(readHidden().size, 0);
});
t('corrupt or blocked storage: everything on the desktop', () => {
  store.set('somora-desktop-hidden', '{nope');
  assert.equal(readHidden().size, 0);
  store.set('somora-desktop-hidden', JSON.stringify(['agent:ada', 3]));
  assert.deepEqual([...readHidden()], ['agent:ada']);
  (globalThis as Record<string, unknown>).localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readHidden().size, 0);
  writeHidden(new Set(['x'])); // does not throw
});

const entries = [
  { id: 'agent:zed', name: 'zed', extra: 'Researcher' },
  { id: 'agent:lisbeth', name: 'lisbeth', extra: 'Writer' },
  { id: 'agent:ada', name: 'ada', extra: 'list keeper' },
  { id: 'app:sessions', name: 'sessions' },
  { id: 'app:log', name: 'log' },
];
t('empty query keeps all, in order', () => assert.deepEqual(searchEntries(entries, '  ').map((e) => e.id), entries.map((e) => e.id)));
t('name prefix first, then name contains, then role', () =>
  assert.deepEqual(searchEntries(entries, 'lis').map((e) => e.id), ['agent:lisbeth', 'agent:ada']));
t('case does not matter', () => assert.deepEqual(searchEntries(entries, 'SES').map((e) => e.id), ['app:sessions']));
t('no match: empty', () => assert.equal(searchEntries(entries, 'qqq').length, 0));
t('prefix matches keep their order, a role match comes last', () =>
  assert.deepEqual(searchEntries(entries, 'l').map((e) => e.id), ['agent:lisbeth', 'app:log', 'agent:ada']));
t('a role alone finds the agent', () => assert.deepEqual(searchEntries(entries, 'writ').map((e) => e.id), ['agent:lisbeth']));
console.log(`\n${ok} passed`);
