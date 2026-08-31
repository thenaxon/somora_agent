// Read/write the `skills:` section of an agent.yaml WITHOUT touching
// the rest of the file — same text-splice approach as
// tool-gating-store.ts (agent.yaml is operator-edited and full of
// comments; a YAML round-trip would strip them).
//
// Consumed by PUT /agents/:name/skills (web Abilities matrix). Reads go
// through the normal persona loader (src/skills/gating.ts normalizes
// both the legacy list form and this object form); this module is
// write-side only. Writing always produces the object form — a legacy
// `skills: [a, b]` list is replaced by `skills:\n  allow: [a, b]`, which
// means the same thing.

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertValidSkillName, type SkillGating } from '../skills/gating.ts';
import { spliceTopLevelBlock } from './tool-gating-store.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const AGENTS_DIR = join(SOMORA_HOME, 'agents');

/** Render the replacement block. Empty deny+allow = remove the section
 *  entirely (agent sees every skill — same as before the UI touched it). */
export function renderSkillsBlock(gating: SkillGating): string {
  if (gating.deny.length === 0 && gating.allow.length === 0) return '';
  const lines = ['skills:'];
  if (gating.deny.length > 0) {
    lines.push('  deny:');
    for (const n of gating.deny) lines.push(`    - ${JSON.stringify(n)}`);
  }
  if (gating.allow.length > 0) {
    lines.push('  allow:');
    for (const n of gating.allow) lines.push(`    - ${JSON.stringify(n)}`);
  }
  return lines.join('\n') + '\n';
}

export function spliceSkillsBlock(yamlText: string, gating: SkillGating): string {
  return spliceTopLevelBlock(
    yamlText,
    'skills',
    renderSkillsBlock(gating),
    '# Per-agent skill visibility (managed via web UI — docs/skills.md)',
  );
}

/** Full read-modify-write against the agent's on-disk agent.yaml.
 *  Missing file → created with just the skills block. */
export async function writeAgentSkillGating(agent: string, gating: SkillGating): Promise<void> {
  for (const n of [...gating.deny, ...gating.allow]) assertValidSkillName(n);
  const path = join(AGENTS_DIR, agent, 'agent.yaml');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    // ENOENT — agent.yaml is optional; we create it.
  }
  await writeFile(path, spliceSkillsBlock(current, gating), 'utf8');
}
