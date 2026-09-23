// Open turns at boot get a marker; askers are named. Run: npm test src/server/restart-reconcile.test.mts
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openTurnOf, reconcileInterruptedTurns, RESTART_NOTE, restartWakeText } from './restart-reconcile.ts';

const home = process.env.SOMORA_HOME!;
assert.ok(home && !home.endsWith('/.somora'));
const line = (o: unknown) => JSON.stringify(o) + '\n';
// pure: a finished turn is not open; a cut one is, with its asker
assert.equal(openTurnOf([{ kind: 'user_message', ts: 1 }, { kind: 'turn_start', ts: 2, turnId: 't-2' }, { kind: 'turn_end', ts: 3, turnId: 't-2' }]), null);
const cut = openTurnOf([
  { kind: 'user_message', ts: 1, text: 'x', from_agent: 'lisa', from_session: 's-l', agent_ask_call_id: 'c1', origin: { kind: 'agent' } },
  { kind: 'turn_start', ts: 2, turnId: 't-2' },
  { kind: 'tool_call', ts: 3, tool: 'exec' },
])!;
assert.deepEqual({ turnId: cut.turnId, fromAgent: cut.fromAgent, fromSession: cut.fromSession, callId: cut.callId }, { turnId: 't-2', fromAgent: 'lisa', fromSession: 's-l', callId: 'c1' });
const helper = openTurnOf([{ kind: 'user_message', ts: 1, origin: { kind: 'subagent', depth: 1, parent: { agent: 'rudi', session: 's-r' } } }, { kind: 'turn_start', ts: 2, turnId: 't-9' }])!;
assert.deepEqual(helper.parent, { agent: 'rudi', session: 's-r' });
// on disk: two sessions, one cut, one clean
const agent = 'reconcile-test-agent';
const dir = join(home, 'agents', agent, 'sessions');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'main.jsonl'), line({ kind: 'user_message', ts: 1, text: 'hi' }) + line({ kind: 'turn_start', ts: 2, turnId: 't-a' }) + line({ kind: 'assistant_message', ts: 3, text: 'yo' }) + line({ kind: 'turn_end', ts: 4, turnId: 't-a' }));
await writeFile(join(dir, '20260923-000000_cut.jsonl'), line({ kind: 'user_message', ts: 1, text: 'go', from_agent: 'naxon', from_session: 's-n', agent_ask_call_id: 'c9' }) + line({ kind: 'turn_start', ts: 2, turnId: 't-b' }) + line({ kind: 'tool_call', ts: 3, tool: 'exec', input: {} }));
const found = await reconcileInterruptedTurns([agent, 'no-such-agent']);
assert.equal(found.length, 1);
assert.equal(found[0]!.session, '20260923-000000_cut');
assert.equal(found[0]!.callId, 'c9');
const after = (await readFile(join(dir, '20260923-000000_cut.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
assert.equal(after.at(-2)!.kind, 'error'); assert.equal(after.at(-2)!.message, RESTART_NOTE);
assert.equal(after.at(-1)!.kind, 'turn_end'); assert.equal(after.at(-1)!.turnId, 't-b');
const again = await reconcileInterruptedTurns([agent]);
assert.equal(again.length, 0, 'a second boot finds nothing open');
assert.match(restartWakeText(found[0]!), /cut off by a server restart.*call_id "c9"/);
console.log('restart-reconcile.test: ok');
