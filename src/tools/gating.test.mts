// Unit tests for per-agent tool gating (agent.yaml tools: section).
//
// Run: npx tsx src/tools/gating.test.mts

import assert from 'node:assert/strict';
import { isToolAllowed, matchesToolPattern } from './gating.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}`);
  }
}

// Pattern forms
check('exact match', matchesToolPattern('web_search', 'web_search', 'web'));
check('exact no-match', !matchesToolPattern('web_search', 'web_fetch', 'web'));
check('toolset match', matchesToolPattern('toolset:exec', 'exec', 'exec'));
check('toolset no-match', !matchesToolPattern('toolset:exec', 'web_search', 'web'));
check('glob match', matchesToolPattern('mcp__parallel__*', 'mcp__parallel__web_search', 'mcp'));
check('glob no-match other server', !matchesToolPattern('mcp__parallel__*', 'mcp__github__search', 'mcp'));

// No gating = everything visible
check('no gating', isToolAllowed('anything', 'web', undefined));

// Deny only
const denyOnly = { deny: ['web_search', 'toolset:exec'], allow: [] };
check('deny exact', !isToolAllowed('web_search', 'web', denyOnly));
check('deny toolset', !isToolAllowed('exec', 'exec', denyOnly));
check('deny leaves rest', isToolAllowed('memory_search', 'memory', denyOnly));

// Allow list narrows
const allowList = { deny: [], allow: ['memory_search', 'mcp__parallel__*'] };
check('allow exact', isToolAllowed('memory_search', 'memory', allowList));
check('allow glob', isToolAllowed('mcp__parallel__web_search', 'mcp', allowList));
check('allow excludes rest', !isToolAllowed('exec', 'exec', allowList));

// Deny beats allow
const both = { deny: ['mcp__parallel__web_search'], allow: ['mcp__parallel__*'] };
check('deny beats allow', !isToolAllowed('mcp__parallel__web_search', 'mcp', both));
check('allow survives sibling deny', isToolAllowed('mcp__parallel__web_fetch', 'mcp', both));

// The design-doc scenario: agent keeps native web_search, hides the MCP twin.
const nativeOnly = { deny: ['mcp__parallel__web_search'], allow: [] };
check('scenario: native visible', isToolAllowed('web_search', 'web', nativeOnly));
check('scenario: MCP twin hidden', !isToolAllowed('mcp__parallel__web_search', 'mcp', nativeOnly));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
