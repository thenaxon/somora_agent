// "Unarchive" must work for every archived session, including the ones
// /reset leaves behind (archived by their id, `…-archive`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = join(tmpdir(), `somora-restore-${process.pid}`);
mkdirSync(home, { recursive: true });
process.env.SOMORA_HOME = home;
const s = await import('./sessions.ts');
const agent = 'ada';
const say = (session: string, text: string) =>
  s.appendEvent(agent, session, { kind: 'user_message', ts: Date.now(), engine: 'openai-compatible', text } as never);

test('a reset archive of main comes back as a normal session with the name its id shows', async () => {
  await say('main', 'context worth keeping');
  const r = await s.resetSession(agent, 'main');
  assert.ok(r);
  const archiveId = r!.archivedId;
  assert.match(archiveId, /_main-archive$/);
  let list = await s.listSessions(agent, { includeArchived: true });
  assert.equal(list.find((x) => x.id === archiveId)?.isArchived, true);

  const after = await s.unarchiveSession(agent, archiveId);
  assert.deepEqual(after, { slug: 'main-archive', isArchived: false });
  list = await s.listSessions(agent);
  const row = list.find((x) => x.id === archiveId);
  assert.ok(row, 'listed without include_archived');
  assert.equal(row!.isArchived, false);
  assert.equal(row!.slug, 'main-archive');
  assert.equal(await s.resolveSessionId(agent, 'main-archive'), archiveId, 'reachable by its name');
  assert.equal(await s.resolveSessionId(agent, 'main'), 'main', 'main is still the fresh session');
  const meta = await s.sessionMetaStore.get(agent, archiveId);
  assert.equal(meta.archived, false);
  assert.equal(meta.slug, 'main-archive');
  assert.equal((await s.getHistory(agent, archiveId))[0]?.kind, 'user_message', 'history intact');
});

test('a reset archive of a named session does not take the fresh session\'s name', async () => {
  const id = await s.createSession(agent, 'trip');
  await say(id, 'packing list');
  const r = await s.resetSession(agent, id);
  await s.unarchiveSession(agent, r!.archivedId);
  assert.deepEqual(await s.findLiveSessionsBySlug(agent, 'trip'), [id], 'the name trip still means the fresh session');
  assert.equal(await s.resolveSessionId(agent, 'trip-archive'), r!.archivedId);
});

test('archiving a restored session works again; a flag-archived session restores as before', async () => {
  const list = await s.listSessions(agent);
  const restored = list.find((x) => x.slug === 'main-archive')!;
  await s.archiveSession(agent, restored.id);
  assert.equal((await s.listSessions(agent, { includeArchived: true })).find((x) => x.id === restored.id)?.isArchived, true);
  assert.equal((await s.unarchiveSession(agent, restored.id)).isArchived, false);

  const plain = await s.createSession(agent, 'notes');
  await s.archiveSession(agent, plain);
  assert.deepEqual(await s.unarchiveSession(agent, plain), { slug: 'notes', isArchived: false });
  const meta = await s.sessionMetaStore.get(agent, plain);
  assert.equal('archived' in meta, false, 'flag removed, no override written');
});

test('the id rule also covers -archive-N ids from two resets in one second', () => {
  assert.equal(s.isSessionArchived('20261006-120000_main-archive-2', {}), true);
  assert.equal(s.isSessionArchived('20261006-120000_main-archive-2', { archived: false } as never), false);
  assert.equal(s.isSessionArchived('20261006-120000_my-archive-notes', {}), false);
});
