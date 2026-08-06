// Unit tests for the agent.yaml tools:-block splice (comment-preserving
// write-side of the web UI tool matrix).
//
// Run: npx tsx src/persona/tool-gating-store.test.mts

import assert from 'node:assert/strict';
import { renderToolsBlock, spliceToolsBlock } from './tool-gating-store.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const BASE = `# operator config — hand-written comment
model: opus           # keep me
fallback: gpt55

resources:
  deny: ['production-db']
`;

// Append when no block exists
{
  const out = spliceToolsBlock(BASE, { deny: ['toolset:exec'], allow: [] });
  check('append: block added', out.includes('tools:\n  deny:\n    - "toolset:exec"'));
  check('append: comments preserved', out.includes('# keep me') && out.includes('hand-written comment'));
  check('append: existing keys intact', out.includes("resources:\n  deny: ['production-db']"));
}

// Replace existing block in place
{
  const withBlock = `model: opus
tools:
  deny:
    - "old_tool"

fallback: gpt55
`;
  const out = spliceToolsBlock(withBlock, { deny: ['new_tool', 'mcp__parallel__*'], allow: [] });
  check('replace: old entry gone', !out.includes('old_tool'));
  check('replace: new entries present', out.includes('"new_tool"') && out.includes('"mcp__parallel__*"'));
  check('replace: following key intact', out.includes('fallback: gpt55'));
  check('replace: preceding key intact', out.startsWith('model: opus'));
}

// Empty gating removes the block
{
  const withBlock = `model: opus
tools:
  deny:
    - "x"
fallback: gpt55
`;
  const out = spliceToolsBlock(withBlock, { deny: [], allow: [] });
  check('remove: block gone', !out.includes('tools:'));
  check('remove: rest intact', out.includes('model: opus') && out.includes('fallback: gpt55'));
}

// Empty gating on file without block = no-op
check('noop: unchanged', spliceToolsBlock(BASE, { deny: [], allow: [] }) === BASE);

// Block at EOF (no following top-level key)
{
  const eof = `model: opus
tools:
  deny:
    - "x"
`;
  const out = spliceToolsBlock(eof, { deny: ['y'], allow: ['z'] });
  check('eof: replaced', !out.includes('"x"') && out.includes('"y"') && out.includes('allow:\n    - "z"'));
}

// renderToolsBlock shape
check('render: empty', renderToolsBlock({ deny: [], allow: [] }) === '');
check(
  'render: deny+allow',
  renderToolsBlock({ deny: ['a'], allow: ['b'] }) === 'tools:\n  deny:\n    - "a"\n  allow:\n    - "b"\n',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
