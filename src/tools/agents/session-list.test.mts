// session_list: shaping of the server rows.
// Run: npx tsx src/tools/agents/session-list.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-session-list-'));
const { shapeSessionList, sessionList } = await import('./session-list.ts');

const rows = [
  { agent: 'hans', sessionId: 'main', slug: 'main', isMain: true, isArchived: false, lastActivity: '2026-09-21T10:00:00Z', messageCount: 40, busy: false, queueLength: 0 },
  { agent: 'hans', sessionId: '20260920-100000_kizilla', slug: 'kizilla', isMain: false, isArchived: false, lastActivity: '2026-09-20T10:00:00Z', messageCount: 12, busy: true, queueLength: 2, projectSlug: 'kizilla', engine: 'claude-cli' },
  { agent: 'hans', sessionId: '20260901-100000_alt', slug: 'alt', isMain: false, isArchived: true, lastActivity: '2026-09-01T10:00:00Z', messageCount: 3, busy: false, queueLength: 0 },
  { agent: 'naxon', sessionId: 'main', slug: 'main', isMain: true, isArchived: false, lastActivity: '2026-09-21T11:00:00Z', messageCount: 99, busy: false, queueLength: 0 },
];

{
  const r = shapeSessionList(rows, { self: 'hans', currentSession: '20260920-100000_kizilla' });
  assert.equal(r.count, 3);
  assert.ok(r.sessions.every((s) => s.agent === 'hans'), 'own sessions by default');
  assert.equal(r.sessions[0]!.session, 'kizilla', 'a running session comes first');
  assert.deepEqual(
    { running: r.sessions[0]!.running, queued: r.sessions[0]!.queued, project: r.sessions[0]!.project, is_current: r.sessions[0]!.is_current },
    { running: true, queued: 2, project: 'kizilla', is_current: true },
  );
  assert.equal(r.sessions[1]!.session, 'main');
  assert.equal(r.sessions[1]!.is_current, undefined);
  assert.equal(r.sessions[2]!.archived, true);
}
{
  const r = shapeSessionList(rows, { self: 'hans', agent: 'naxon', currentSession: 'main' });
  assert.equal(r.count, 1);
  assert.equal(r.sessions[0]!.agent, 'naxon');
  assert.equal(r.sessions[0]!.is_current, undefined, "another agent's main is not MY current session");
}
{
  const r = shapeSessionList(rows, { self: 'hans', agent: '*', limit: 2 });
  assert.equal(r.count, 2);
  assert.equal(r.total, 4);
  assert.match(r.hint ?? '', /2 more not shown/);
}
{
  const r = shapeSessionList(rows, { self: 'hans', agent: 'gibtsnicht' });
  assert.equal(r.count, 0);
  assert.match(r.hint ?? '', /Agents with sessions: hans, naxon/);
}
// Zod input and the hand-written JSON schema describe the same fields.
{
  const zodKeys = Object.keys((sessionList.inputSchema as unknown as { shape: Record<string, unknown> }).shape).sort();
  const jsonKeys = Object.keys((sessionList.jsonSchema as { properties: Record<string, unknown> }).properties).sort();
  assert.deepEqual(zodKeys, jsonKeys);
  assert.throws(() => sessionList.inputSchema.parse({ agnet: 'x' }), 'unknown keys are rejected');
}
console.log('session-list: all passed');
