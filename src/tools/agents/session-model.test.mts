// session_model: which session is meant, and the schemas agree.
// Run: npx tsx src/tools/agents/session-model.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-session-model-'));
const { resolveSessionModelTarget, sessionModel } = await import('./session-model.ts');
const { resolveEngineMetaLabel, summariseEngineMeta } = await import('../../engine/engine-meta-labels.ts');

const me = { agent: 'naxon', session: '20260921-100000_planung' };
assert.deepEqual(resolveSessionModelTarget({}, me), { agent: 'naxon', session: me.session }, 'default: the session I am in');
assert.deepEqual(resolveSessionModelTarget({ session: 'main' }, me), { agent: 'naxon', session: 'main' });
assert.deepEqual(resolveSessionModelTarget({ agent: 'hans', session: 'kizilla' }, me), { agent: 'hans', session: 'kizilla' });
assert.throws(() => resolveSessionModelTarget({ agent: 'hans' }, me), /name the session of 'hans'/, "never guess another agent's session");
assert.throws(() => resolveSessionModelTarget({}, { agent: 'naxon' }), /not running inside a session/);

const ctx = { agent: 'naxon', session: me.session, config: {} } as never;
await assert.rejects(sessionModel.handler({} as never, ctx), /either `model` or `clear:true`/);
await assert.rejects(sessionModel.handler({ model: 'opus', clear: true } as never, ctx), /either `model` or `clear:true`/);

const zodKeys = Object.keys((sessionModel.inputSchema as unknown as { shape: Record<string, unknown> }).shape).sort();
const jsonKeys = Object.keys((sessionModel.jsonSchema as { properties: Record<string, unknown> }).properties).sort();
assert.deepEqual(zodKeys, jsonKeys);

assert.equal(resolveEngineMetaLabel('somora', 'session_model'), 'model switched');
assert.equal(summariseEngineMeta('somora', 'session_model', { text: 'agent naxon switched…' }), 'agent naxon switched…');
console.log('session-model: all passed');
