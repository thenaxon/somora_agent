// `skills:` block splice in agent.yaml (2026-08-31) — must leave every
// other line (comments, tools block, model) byte-identical.
//
// Run: npx tsx src/persona/skill-gating-store.test.mts

import assert from 'node:assert/strict';
import { renderSkillsBlock, spliceSkillsBlock } from './skill-gating-store.ts';
import { spliceToolsBlock } from './tool-gating-store.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name}\n${detail}`);
  }
}

const BASE = `# hans — engineer
model: fable
thinking: high   # keep

tools:
  deny:
    - "mcp__parallel__web_fetch"
rem:
  enabled: true
`;

// ── render ─────────────────────────────────────────────────────────
check('render: empty → removed', renderSkillsBlock({ deny: [], allow: [] }) === '');
check('render: deny only', renderSkillsBlock({ deny: ['gog'], allow: [] }) === 'skills:\n  deny:\n    - "gog"\n');
check('render: both', renderSkillsBlock({ deny: ['gog'], allow: ['github'] }) === 'skills:\n  deny:\n    - "gog"\n  allow:\n    - "github"\n');

// ── append when absent ─────────────────────────────────────────────
{
  const out = spliceSkillsBlock(BASE, { deny: ['gog'], allow: [] });
  check('append: original content intact', out.startsWith(BASE), out);
  check('append: block + comment at the end', out.endsWith('# Per-agent skill visibility (managed via web UI — docs/skills.md)\nskills:\n  deny:\n    - "gog"\n'), out);
  check('append: tools block untouched', out.includes('tools:\n  deny:\n    - "mcp__parallel__web_fetch"\nrem:'));
}

// ── replace legacy list form in place ──────────────────────────────
{
  const legacy = `model: fable
skills:
  - github
  - gog
# trailing comment belongs to the next key
rem:
  enabled: true
`;
  const out = spliceSkillsBlock(legacy, { deny: ['instagram-downloader'], allow: [] });
  check('replace: legacy list gone', !out.includes('- github'), out);
  check('replace: object form written in place', out.includes('model: fable\nskills:\n  deny:\n    - "instagram-downloader"\n'), out);
  check('replace: following key kept', out.includes('# trailing comment belongs to the next key\nrem:\n  enabled: true\n'), out);
}

// ── remove when emptied ────────────────────────────────────────────
{
  const withBlock = spliceSkillsBlock(BASE, { deny: ['gog'], allow: [] });
  const out = spliceSkillsBlock(withBlock, { deny: [], allow: [] });
  check('remove: skills block gone', !out.includes('skills:'), out);
  check('remove: rest identical to base', out.trimEnd() === BASE.trimEnd() || out.replace(/\n# Per-agent skill visibility[^\n]*\n?$/, '').trimEnd() === BASE.trimEnd(), out);
}

// ── tools and skills blocks coexist, each splice edits only its own ─
{
  const both = spliceSkillsBlock(BASE, { deny: ['gog'], allow: [] });
  const toolsEdited = spliceToolsBlock(both, { deny: ['mcp__parallel__web_fetch', 'exec'], allow: [] });
  check('tools splice keeps skills block', toolsEdited.includes('skills:\n  deny:\n    - "gog"'), toolsEdited);
  check('tools splice updated tools', toolsEdited.includes('- "exec"'));
  const skillsEdited = spliceSkillsBlock(toolsEdited, { deny: ['gog', 'storeganise'], allow: [] });
  check('skills splice keeps tools block', skillsEdited.includes('- "exec"'), skillsEdited);
  check('skills splice updated skills', skillsEdited.includes('- "storeganise"'));
}

// ── empty file ─────────────────────────────────────────────────────
{
  const out = spliceSkillsBlock('', { deny: ['gog'], allow: [] });
  check('empty file: created with just the block', out.trim().endsWith('skills:\n  deny:\n    - "gog"'), out);
}

console.log(`skill-gating-store: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
