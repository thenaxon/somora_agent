// Builder tool defaults: the kind's allow-list merged with agent.yaml.
// Run: npm test src/tools/gating-builder.test.mts
import assert from 'node:assert/strict';
import { BUILDER_TOOL_ALLOW, effectiveToolGating, isToolAllowed } from './gating.ts';

// chat agents: their own block plus the builder toolset denied
const chat = effectiveToolGating('chat', undefined)!;
assert.equal(isToolAllowed('todo_write', 'builder', chat), false, 'builder-only tools hidden from chat agents');
assert.equal(isToolAllowed('file_read', 'file', chat), true);
const chatDeny = effectiveToolGating('chat', { deny: ['browser'], allow: [] });
assert.equal(isToolAllowed('browser', 'browser', chatDeny), false);
assert.equal(isToolAllowed('plan_write', 'builder', chatDeny), false, 'builder-only tools stay hidden with an own block');
assert.equal(isToolAllowed('web_fetch', 'web', chatDeny), true);
// …and not even when the agent names one: they belong to the builder kind
const chatAllow = effectiveToolGating('chat', { deny: [], allow: ['todo_write'] })!;
assert.equal(isToolAllowed('todo_write', 'builder', chatAllow), false);

// builder without own block: exactly the kind list
const g = effectiveToolGating('builder', undefined)!;
for (const n of BUILDER_TOOL_ALLOW) assert.equal(isToolAllowed(n, undefined, g), true, `${n} in the builder set`);
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
// an own allow repeating a default changes nothing
const g3 = effectiveToolGating('builder', { deny: [], allow: ['exec'] })!;
assert.equal(isToolAllowed('exec', 'exec', g3), true);
assert.equal(isToolAllowed('memory_write', 'memory', g3), false);
console.log('gating-builder.test: ok');
