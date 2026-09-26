// Every tool in the builder set has a short description, and the
// harness prompt leaves out sections for hidden tools.
// Run: npm test src/tools/builder/short-descriptions.test.mts
import assert from 'node:assert/strict';
import { BUILDER_TOOL_ALLOW } from '../gating.ts';
import { BUILDER_SHORT_DESCRIPTIONS, builderToolDescription } from './short-descriptions.ts';
import { buildBuilderHarnessPrompt, BUILDER_HARNESS_PROMPT } from '../../server/builder-prompt.ts';

for (const name of BUILDER_TOOL_ALLOW) {
  const short = BUILDER_SHORT_DESCRIPTIONS[name];
  assert.ok(short, `no short description for ${name}`);
  assert.ok(short.length < 600, `${name}: ${short.length} chars`);
}
// a tool without an entry keeps the long text
assert.equal(builderToolDescription('browser', 'LONG'), 'LONG');
assert.notEqual(builderToolDescription('file_read', 'LONG'), 'LONG');

// the full harness mentions every section
for (const must of ['# Task list', 'ask_user', '# Helpers and colleagues', 'file_patch', 'Git:']) {
  assert.ok(BUILDER_HARNESS_PROMPT.includes(must), must);
}
// hidden tools drop their sections
const noTodo = buildBuilderHarnessPrompt(new Set(['file_read', 'exec']));
assert.ok(!noTodo.includes('# Task list'));
assert.ok(!noTodo.includes('ask_user'));
assert.ok(noTodo.includes('Nobody answers questions'));
assert.ok(!noTodo.includes('# Helpers and colleagues'));
assert.ok(!noTodo.includes('file_patch'));
const unattended = buildBuilderHarnessPrompt(new Set(['file_read', 'file_patch', 'exec', 'todo_write', 'agent_ask']));
assert.ok(unattended.includes('# Task list'));
assert.ok(unattended.includes('agent_ask reaches a colleague'));
assert.ok(!unattended.includes('spawn_subagent starts'));
// todo_write's short text carries the rules that keep the panel honest (naxon, 2026-09-26)
assert.ok(/never a batch/.test(BUILDER_SHORT_DESCRIPTIONS.todo_write!), 'todo_write short description forbids batch completions');
assert.ok(/in the round it is verified/.test(BUILDER_SHORT_DESCRIPTIONS.todo_write!));
console.log('short-descriptions.test: ok');
