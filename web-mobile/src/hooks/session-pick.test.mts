import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAIN_SESSION,
  isActiveModel,
  isPersonaDefault,
  labelForRef,
  modelLabel,
  orderSessions,
  readLastSession,
  relativeTime,
  visibleSessions,
  writeLastSession,
} from './session-pick.ts';

function memStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

test('last session: per agent, main when nothing or garbage is stored', () => {
  const s = memStore();
  assert.deepEqual(readLastSession(s, 'ada'), MAIN_SESSION);
  writeLastSession(s, 'ada', { id: '20261004-1_trip', slug: 'trip' });
  assert.deepEqual(readLastSession(s, 'ada'), { id: '20261004-1_trip', slug: 'trip' });
  assert.deepEqual(readLastSession(s, 'bea'), MAIN_SESSION);
  s.m.set('somora.mobile.lastSession.bea', '{not json');
  assert.deepEqual(readLastSession(s, 'bea'), MAIN_SESSION);
  s.m.set('somora.mobile.lastSession.bea', '{"id":"","slug":"x"}');
  assert.deepEqual(readLastSession(s, 'bea'), MAIN_SESSION);
  assert.deepEqual(readLastSession(null, 'ada'), MAIN_SESSION);
});

test('last session: going back to main forgets the entry; a throwing store is survived', () => {
  const s = memStore();
  writeLastSession(s, 'ada', { id: 'x', slug: 'x' });
  writeLastSession(s, 'ada', MAIN_SESSION);
  assert.equal(s.m.size, 0);
  const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
  assert.deepEqual(readLastSession(broken, 'ada'), MAIN_SESSION);
  writeLastSession(broken, 'ada', { id: 'x', slug: 'x' });
});

const rows = [
  { id: 'a', isMain: false, lastActivity: '2026-10-01T10:00:00Z' },
  { id: 'main', isMain: true, lastActivity: '2026-09-01T10:00:00Z' },
  { id: 'b', isMain: false, lastActivity: '2026-10-03T10:00:00Z' },
  { id: 'c', isMain: false, lastActivity: '2026-10-02T10:00:00Z' },
];

test('order: main first, then newest', () => {
  assert.deepEqual(orderSessions(rows).map((r) => r.id), ['main', 'b', 'c', 'a']);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'main', 'b', 'c'], 'input untouched');
});

test('order: a session without activity sorts by when it was created', () => {
  const o = orderSessions([
    { id: 'old', isMain: false, lastActivity: '2026-10-01T10:00:00Z', createdAt: '2026-09-01T10:00:00Z' },
    { id: 'fresh', isMain: false, lastActivity: null, createdAt: '2026-10-04T10:00:00Z' },
    { id: 'main', isMain: true, lastActivity: null, createdAt: null },
    { id: 'bare', isMain: false, lastActivity: null },
  ]);
  assert.deepEqual(o.map((r) => r.id), ['main', 'fresh', 'old', 'bare']);
});

test('visible rows: limit, but the open session is never hidden', () => {
  const o = orderSessions(rows);
  assert.deepEqual(visibleSessions(o, 'main', 2, false).map((r) => r.id), ['main', 'b']);
  assert.deepEqual(visibleSessions(o, 'a', 2, false).map((r) => r.id), ['main', 'a']);
  assert.deepEqual(visibleSessions(o, 'a', 2, true).map((r) => r.id), ['main', 'b', 'c', 'a']);
  assert.deepEqual(visibleSessions(o, 'gone', 2, false).map((r) => r.id), ['main', 'b']);
  assert.deepEqual(visibleSessions(o, 'a', 10, false).length, 4);
});

const info = { provider: 'p', modelId: 'big-1', alias: 'big', engine: 'e', contextWindow: 1, source: 'persona-default' as const, override: null, personaDefault: 'big' };

test('model rows: active by provider+id, default by alias, ref or provider/id', () => {
  assert.equal(isActiveModel(info, { provider: 'p', id: 'big-1' }), true);
  assert.equal(isActiveModel(info, { provider: 'q', id: 'big-1' }), false);
  assert.equal(isActiveModel(null, { provider: 'p', id: 'big-1' }), false);
  assert.equal(isPersonaDefault(info, { provider: 'p', id: 'big-1', alias: 'big', ref: 'big' }), true);
  assert.equal(isPersonaDefault({ ...info, personaDefault: 'p/big-1' }, { provider: 'p', id: 'big-1', alias: null, ref: 'p/big-1' }), true);
  assert.equal(isPersonaDefault({ ...info, personaDefault: 'p/big-1' }, { provider: 'p', id: 'big-1', alias: 'big', ref: 'big' }), true);
  assert.equal(isPersonaDefault(info, { provider: 'p', id: 'small-1', alias: 'small', ref: 'small' }), false);
  assert.equal(isPersonaDefault({ ...info, personaDefault: null }, { provider: 'p', id: 'big-1', alias: 'big', ref: 'big' }), false);
});

test('labels', () => {
  assert.equal(modelLabel(info), 'big');
  assert.equal(modelLabel({ alias: null, modelId: 'big-1' }), 'big-1');
  assert.equal(modelLabel(null), '');
  const models = [{ provider: 'p', id: 'big-1', alias: 'big' }, { provider: 'p', id: 'raw', alias: null }];
  assert.equal(labelForRef('p/big-1', models), 'big');
  assert.equal(labelForRef('p/raw', models), 'raw');
  assert.equal(labelForRef('x/unknown-model', models), 'unknown-model');
  assert.equal(labelForRef('bare', models), 'bare');
});

test('relative time', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(relativeTime('2026-10-04T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-10-04T11:55:00Z', now), '5 min');
  assert.equal(relativeTime('2026-10-04T09:00:00Z', now), '3 h');
  assert.equal(relativeTime('2026-10-02T12:00:00Z', now), '2 d');
  assert.equal(relativeTime('2026-09-01T12:00:00Z', now), '2026-09-01');
  assert.equal(relativeTime('2026-10-04T12:05:00Z', now), 'just now', 'clock skew');
  assert.equal(relativeTime('nonsense', now), '');
  assert.equal(relativeTime(null, now), '');
});
