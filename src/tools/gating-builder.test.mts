// Builder tool defaults: the kind's allow-list merged with agent.yaml.
// Run: npm test src/tools/gating-builder.test.mts
import assert from 'node:assert/strict';
import { BUILDER_TOOL_ALLOW, effectiveToolGating, isToolAllowed } from './gating.ts';

// chat agents: their own block plus the builder toolset denied
const chat = effectiveToolGating('chat', undefined)!;
assert.equal(isToolAllowed('todo_write', 'builder', chat), false, 'builder-only tools hidden from chat agents');
assert.equal(isToolAllowed('file_read', 'file', chat), true);
assert.deepEqual(effectiveToolGating('chat', { deny: ['browser'], allow: [] }), { deny: ['browser', 'toolset:builder'], allow: [] });
// …unless the agent names one explicitly
const chatAllow = effectiveToolGating('chat', { deny: [], allow: ['todo_write'] })!;
assert.equal(isToolAllowed('todo_write', 'builder', chatAllow), true);

// builder without own block: exactly the kind list
const g = effectiveToolGating('builder', undefined)!;
assert.deepEqual(g.allow, [...BUILDER_TOOL_ALLOW]);
assert.deepEqual(g.deny, []);
assert.equal(isToolAllowed('file_patch', 'file', g), true);
assert.equal(isToolAllowed('exec', 'exec', g), true);
assert.equal(isToolAllowed('memory_write', 'memory', g), false, 'memory writes off');
assert.equal(isToolAllowed('sentinel', 'sentinel', g), false);
assert.equal(isToolAllowed('mcp__github__create_issue', 'mcp', g), false, 'external MCP off by default');
assert.equal(isToolAllowed('tmux', 'exec', g), false, 'no terminal detour');

// builder with own allow adds, own deny removes
const g2 = effectiveToolGating('builder', { deny: ['web_fetch'], allow: ['browser', 'mcp__github__*'] })!;
assert.equal(isToolAllowed('browser', 'browser', g2), true);
assert.equal(isToolAllowed('mcp__github__create_issue', 'mcp', g2), true);
assert.equal(isToolAllowed('web_fetch', 'web', g2), false);
assert.equal(isToolAllowed('file_read', 'file', g2), true);
// no duplicates when the own allow repeats a default
const g3 = effectiveToolGating('builder', { deny: [], allow: ['exec'] })!;
assert.equal(g3.allow.filter((n) => n === 'exec').length, 1);
console.log('gating-builder.test: ok');
