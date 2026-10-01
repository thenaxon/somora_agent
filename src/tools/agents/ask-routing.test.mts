// agent_ask: the result says where the message went and why.
// Run: npx tsx src/tools/agents/ask-routing.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-ask-routing-'));
const { describeRouting } = await import('./ask.ts');

const base = { targetAgent: 'nova' };
assert.deepEqual(describeRouting({ ...base, explicit: true, inferred: false, callerSession: 'proj' }), { routing_reason: 'explicit' });
assert.deepEqual(describeRouting({ ...base, explicit: false, inferred: true, callerSession: 'proj' }), { routing_reason: 'reply_to_origin' });
// explicit wins even if an origin existed
assert.equal(describeRouting({ ...base, explicit: true, inferred: true, callerSession: 'proj' }).routing_reason, 'explicit');
// the 2026-09-14 incident: tmux-started turn in a project session, no session named
const incident = describeRouting({ ...base, explicit: false, inferred: false, callerSession: '20260914-090000_kittyapp' });
assert.equal(incident.routing_reason, 'default_main');
assert.match(incident.routing_note ?? '', /nova's 'main'/);
assert.match(incident.routing_note ?? '', /20260914-090000_kittyapp/);
assert.match(incident.routing_note ?? '', /session: "<its slug>"/);
// main → main is the normal case: no noise
assert.deepEqual(describeRouting({ ...base, explicit: false, inferred: false, callerSession: 'main' }), { routing_reason: 'default_main' });
assert.deepEqual(describeRouting({ ...base, explicit: false, inferred: false, callerSession: undefined }), { routing_reason: 'default_main' });
console.log('ask-routing: all passed');
