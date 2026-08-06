// Read/write the `tools:` section of an agent.yaml WITHOUT touching the
// rest of the file. agent.yaml is operator-edited and full of comments;
// a js-yaml round-trip would strip every one of them. So the update is
// a text splice: replace the existing top-level `tools:` block (from
// the `tools:` line up to the next top-level key / EOF) or append one.
//
// Consumed by PUT /agents/:name/tools (web UI Agents×Tools matrix —
// design private/mcp-hub-design.md §4.6). Reads go through the normal
// persona loader; this module is write-side only.

import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolGating } from '../tools/gating.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const AGENTS_DIR = join(SOMORA_HOME, 'agents');

const PATTERN_SHAPE = /^[A-Za-z0-9_*:.-]+$/;

/** Validate one gating pattern (exact name, toolset:<tag>, trailing-*
 *  glob). Throws with a message suitable for a 400 body. */
export function assertValidPattern(p: string): void {
  if (typeof p !== 'string' || p.length === 0 || p.length > 128 || !PATTERN_SHAPE.test(p)) {
    throw new Error(`invalid tool pattern: ${JSON.stringify(p)}`);
  }
}

/** Render the replacement block. Empty deny+allow = remove the section
 *  entirely (agent sees everything — same as before the UI touched it). */
export function renderToolsBlock(gating: ToolGating): string {
  if (gating.deny.length === 0 && gating.allow.length === 0) return '';
  const lines = ['tools:'];
  if (gating.deny.length > 0) {
    lines.push('  deny:');
    for (const p of gating.deny) lines.push(`    - ${JSON.stringify(p)}`);
  }
  if (gating.allow.length > 0) {
    lines.push('  allow:');
    for (const p of gating.allow) lines.push(`    - ${JSON.stringify(p)}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Splice a new `tools:` block into agent.yaml content. Handles the
 * three cases: existing block replaced in place, no block → appended,
 * empty gating → block removed. Top-level detection is column-0 keys —
 * agent.yaml roots at column 0 (unlike the operator's config.yaml).
 */
export function spliceToolsBlock(yamlText: string, gating: ToolGating): string {
  const block = renderToolsBlock(gating);
  const lines = yamlText.split('\n');
  const start = lines.findIndex((l) => /^tools:\s*(#.*)?$/.test(l));
  if (start === -1) {
    if (block === '') return yamlText;
    const sep = yamlText.length === 0 || yamlText.endsWith('\n') ? '' : '\n';
    return `${yamlText}${sep}\n# Per-agent tool visibility (managed via web UI — docs/mcp.md)\n${block}`;
  }
  // Find the end of the block: next line that is a top-level key or a
  // top-level comment directly preceding one. Indented lines and blank
  // lines inside the block belong to it.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^[A-Za-z_]/.test(l)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start).join('\n');
  const after = lines.slice(end).join('\n');
  const mid = block === '' ? '' : block;
  const sepBefore = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  return `${before}${sepBefore}${mid}${after}`;
}

/** Full read-modify-write against the agent's on-disk agent.yaml.
 *  Missing file → created with just the tools block. */
export async function writeAgentToolGating(agent: string, gating: ToolGating): Promise<void> {
  for (const p of [...gating.deny, ...gating.allow]) assertValidPattern(p);
  const path = join(AGENTS_DIR, agent, 'agent.yaml');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch {
    // ENOENT — agent.yaml is optional; we create it.
  }
  await writeFile(path, spliceToolsBlock(current, gating), 'utf8');
}
