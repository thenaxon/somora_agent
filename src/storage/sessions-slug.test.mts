// One live session per slug. Run: npm test src/storage/sessions-slug.test.mts
import assert from 'node:assert/strict';
import { createSession, findLiveSessionsBySlug, SessionSlugTakenError, sessionMetaStore } from './sessions.ts';

const agent = 'slug-test-agent';
const id = await createSession(agent, 'projekt');
assert.match(id, /_projekt$/);
await assert.rejects(createSession(agent, 'projekt'), (e: unknown) => e instanceof SessionSlugTakenError && e.existingId === id);
assert.deepEqual(await findLiveSessionsBySlug(agent, 'projekt'), [id]);
assert.deepEqual(await findLiveSessionsBySlug(agent, 'projek'), [], 'a prefix is not the slug');
// archived → the name is free again
await sessionMetaStore.update(agent, id, (m) => ({ ...m, archived: true }) as never);
const id2 = await createSession(agent, 'projekt');
assert.notEqual(id2, id);
console.log('sessions-slug.test: ok');
