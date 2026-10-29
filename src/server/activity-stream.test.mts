// The unread mark: an answer in a session marks it unread for the
// person; a sub-agent's session never does (its answer reaches the
// person through the asking agent's conversation), and an older mark
// on such a session is ignored in the session list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionMetaStore, createSession, listSessions } from '../storage/sessions.ts';
import { listStreaming, subscribeActivity, tapPublish } from './activity-stream.ts';

const final = { event: 'chat', data: { state: 'final', text: 'done' } } as never;

test('an answer marks the session unread and tells the clients', async () => {
  const id = await createSession('ada', 'work');
  const seen: unknown[] = [];
  const off = subscribeActivity(async (ev) => {
    seen.push(ev);
  });
  await tapPublish('ada', id, final);
  off();
  assert.equal(typeof (await sessionMetaStore.get('ada', id)).unreadAt, 'string');
  assert.ok(seen.some((e) => (e as { event: string }).event === 'turn'));
  const row = (await listSessions('ada')).find((s) => s.id === id)!;
  assert.equal(typeof row.unreadAt, 'string');
});

test('a sub-agent session is never unread: no mark, no signal, old marks ignored', async () => {
  for (const kind of ['sub', 'self-sub']) {
    const id = await createSession('ada', `sub-x-${kind}`);
    await sessionMetaStore.update('ada', id, (m) => ({ ...m, spawn: { kind, parent_agent: 'bob' } }));
    const seen: unknown[] = [];
    const off = subscribeActivity(async (ev) => {
      seen.push(ev);
    });
    await tapPublish('ada', id, final);
    off();
    assert.equal((await sessionMetaStore.get('ada', id)).unreadAt, undefined, kind);
    assert.equal(seen.length, 0, kind);
    // A mark from before the rule existed:
    await sessionMetaStore.update('ada', id, (m) => ({ ...m, unreadAt: '2026-10-13T12:00:00.000Z' }));
    const row = (await listSessions('ada')).find((s) => s.id === id)!;
    assert.equal(row.unreadAt, null, kind);
  }
});

test('a client that connects mid-turn learns which sessions are working', async () => {
  // The case of 2026-10-29: a builder had worked for two hours when the
  // phone opened, and its tile never pulsed — the start had gone by.
  const start = { event: 'agent', data: { phase: 'start' } } as never;
  const end = { event: 'agent', data: { phase: 'end' } } as never;
  await tapPublish('ada', 'long', start);
  await tapPublish('ada', 'short', start);
  await tapPublish('ada', 'short', end);
  assert.deepEqual(listStreaming(), [{ agent: 'ada', session: 'long' }]);
  await tapPublish('ada', 'long', end);
  assert.deepEqual(listStreaming(), []);
});
