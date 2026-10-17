// While an agent is renamed, its write routes answer 409; reads and
// other agents go through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { renameGuard } from './rename-guard.ts';
import { holdForRename } from '../persona/rename-lock.ts';

test('writes to an agent being renamed are refused, reads are not', async () => {
  const app = new Hono();
  app.use('/agents/:agent/*', renameGuard);
  app.put('/agents/:agent/persona/:file', (c) => c.json({ ok: true }));
  app.get('/agents/:agent/persona/:file', (c) => c.json({ ok: true }));
  const release = holdForRename(['ada', 'bea']);
  try {
    assert.equal((await app.request('/agents/ada/persona/AGENTS.md', { method: 'PUT' })).status, 409);
    assert.equal((await app.request('/agents/bea/persona/AGENTS.md', { method: 'PUT' })).status, 409, 'the new name too');
    assert.equal((await app.request('/agents/ada/persona/AGENTS.md')).status, 200);
    assert.equal((await app.request('/agents/cid/persona/AGENTS.md', { method: 'PUT' })).status, 200);
  } finally {
    release();
  }
  assert.equal((await app.request('/agents/ada/persona/AGENTS.md', { method: 'PUT' })).status, 200);
});
