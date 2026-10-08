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

// writeAgentToolGating drops repeats: a client that merged the kind
// defaults in (the Abilities window did) must not grow agent.yaml.
{
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { writeAgentToolGating } = await import('./tool-gating-store.ts');
  const dir = join(process.env.SOMORA_HOME!, 'agents', 'dedupe-test');
  mkdirSync(dir, { recursive: true });
  await writeAgentToolGating('dedupe-test', { deny: ['toolset:builder', 'x', 'toolset:builder'], allow: ['y', 'y'] });
  const written = readFileSync(join(dir, 'agent.yaml'), 'utf8');
  check('write: repeats dropped', (written.match(/toolset:builder/g) ?? []).length === 1 && (written.match(/"y"/g) ?? []).length === 1, written);
}

// Every write keeps the previous file as a backup (the newest five) and
// never leaves a temp file behind.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { writeAgentToolGating } = await import('./tool-gating-store.ts');
  const dir = join(process.env.SOMORA_HOME!, 'agents', 'dedupe-test');
  const before = readFileSync(join(dir, 'agent.yaml'), 'utf8');
  await writeAgentToolGating('dedupe-test', { deny: ['z'], allow: [] });
  const baks = readdirSync(dir).filter((f) => f.startsWith('agent.yaml.bak-')).sort();
  check('write: previous file kept as backup', baks.length >= 1 && readFileSync(join(dir, baks.at(-1)!), 'utf8') === before, String(baks));
  for (let i = 0; i < 8; i++) await writeAgentToolGating('dedupe-test', { deny: [`n${i}`], allow: [] });
  const after = readdirSync(dir);
  check('write: newest five backups kept', after.filter((f) => f.startsWith('agent.yaml.bak-')).length === 5, String(after));
  check('write: no temp file left', !after.some((f) => f.includes('.tmp-')), String(after));
}

// Off and on again, many times: one heading, the rest of the file intact.
{
  const { spliceSkillsBlock } = await import('./skill-gating-store.ts');
  let y = BASE;
  for (let i = 0; i < 5; i++) {
    y = spliceToolsBlock(y, { deny: ['x'], allow: [] });
    y = spliceSkillsBlock(y, { deny: ['*'], allow: [] });
    y = spliceToolsBlock(y, { deny: [], allow: [] });
    y = spliceSkillsBlock(y, { deny: [], allow: [] });
  }
  check('off/on cycles: back to the original file', y.replace(/\s+$/, '') === BASE.replace(/\s+$/, ''), JSON.stringify(y));
  y = spliceSkillsBlock(spliceToolsBlock(y, { deny: ['x'], allow: [] }), { deny: ['*'], allow: [] });
  check('off/on cycles: one heading each', (y.match(/managed via web UI/g) ?? []).length === 2, y);
  // A heading an older version left behind is reused, not doubled.
  const orphan = `${BASE}\n# Per-agent tool visibility (managed via web UI — docs/mcp.md)\n`;
  const fixed = spliceToolsBlock(orphan, { deny: ['x'], allow: [] });
  check('orphan heading reused', (fixed.match(/managed via web UI/g) ?? []).length === 1, fixed);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
