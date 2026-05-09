// Skill-Registry rendering. Two stages:
//
//   1. filterSkillsForAgent — apply the agent.yaml allow-list. Empty
//      list (or undefined) = all skills pass through. Names that don't
//      exist in the loaded skill set are warned, not errored — same
//      degrade-not-die principle as the rest of the persona pipeline.
//
//   2. renderSkillsRegistry — emit the XML block that goes into the
//      cached prefix portion of the system prompt. Falls back to
//      compact (name+description, no XML wrapper) when the XML would
//      exceed the configured budget. See `private/skills-design.md`.

import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import type { LoadedSkill } from './load.ts';

/** Apply the agent's allow-list to the loaded skill set. */
export function filterSkillsForAgent(
  skills: LoadedSkill[],
  allowList: string[] | undefined,
): LoadedSkill[] {
  if (!allowList || allowList.length === 0) {
    // No allow-list = agent gets all skills. Convention from
    // skills-design.md.
    return skills;
  }
  const allowed = new Set(allowList);
  const known = new Set(skills.map((s) => s.name));
  for (const name of allowList) {
    if (!known.has(name)) {
      logger.warn({
        msg: 'skills.allowlist_unknown',
        name,
        hint: 'agent.yaml lists a skill that is not present in ~/.somora/skills/',
      });
    }
  }
  return skills.filter((s) => allowed.has(s.name));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderXml(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return '<available_skills/>';
  }
  const lines: string[] = ['<available_skills>'];
  for (const s of skills) {
    const attrs = s.available
      ? ''
      : ` unavailable=${JSON.stringify(s.unavailableReason ?? 'requirements not met')}`;
    lines.push(`  <skill${attrs}>`);
    lines.push(`    <name>${escapeXml(s.name)}</name>`);
    lines.push(`    <description>${escapeXml(s.description)}</description>`);
    if (s.whenToUse) {
      lines.push(`    <when_to_use>${escapeXml(s.whenToUse)}</when_to_use>`);
    }
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function renderCompact(skills: LoadedSkill[]): string {
  if (skills.length === 0) {
    return '<available_skills/>';
  }
  const lines: string[] = ['<available_skills format="compact">'];
  for (const s of skills) {
    const flag = s.available ? '' : ` [unavailable: ${s.unavailableReason ?? 'requirements not met'}]`;
    lines.push(`  ${s.name}: ${s.description}${flag}`);
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

export interface RenderOptions {
  maxSkillsInPrompt: number;
  maxPromptChars: number;
}

export interface RenderedRegistry {
  /** The string to inject into the system prompt. Empty when no skills. */
  text: string;
  /** Format actually used. */
  format: 'xml' | 'compact' | 'compact-truncated' | 'empty';
  /** How many skills made it into the rendered registry. */
  rendered: number;
  /** How many skills were dropped due to budget overflow. */
  truncated: number;
}

/**
 * Render the skills registry for system-prompt injection.
 *
 * Strategy:
 *   - Empty list → empty string (caller skips the section)
 *   - Within budget → full XML with name + description + when_to_use
 *   - Over `maxSkillsInPrompt` OR XML exceeds `maxPromptChars`
 *     → fall back to compact (name + description only, no when_to_use,
 *       no XML per-skill wrapping)
 *   - Compact STILL over `maxPromptChars` → hard-truncate alphabetically,
 *     append a `<!-- truncated: N skills hidden -->` marker
 */
export function renderSkillsRegistry(
  skills: LoadedSkill[],
  options: RenderOptions,
): RenderedRegistry {
  if (skills.length === 0) {
    return { text: '', format: 'empty', rendered: 0, truncated: 0 };
  }

  const xmlText = renderXml(skills);
  const fitsCount = skills.length <= options.maxSkillsInPrompt;
  const fitsChars = xmlText.length <= options.maxPromptChars;
  if (fitsCount && fitsChars) {
    return { text: xmlText, format: 'xml', rendered: skills.length, truncated: 0 };
  }

  const compactText = renderCompact(skills);
  if (compactText.length <= options.maxPromptChars) {
    return {
      text: compactText,
      format: 'compact',
      rendered: skills.length,
      truncated: 0,
    };
  }

  // Even compact overflows — hard-truncate alphabetically (skills are
  // already sorted by name in loadAvailableSkills).
  const lines: string[] = ['<available_skills format="compact">'];
  let used = lines[0]!.length + 1; // include trailing newline
  const closing = '\n</available_skills>';
  let kept = 0;
  for (const s of skills) {
    const flag = s.available
      ? ''
      : ` [unavailable: ${s.unavailableReason ?? 'requirements not met'}]`;
    const line = `  ${s.name}: ${s.description}${flag}`;
    if (used + line.length + 1 + closing.length + 64 > options.maxPromptChars) {
      // 64 char headroom for the truncation marker
      break;
    }
    lines.push(line);
    used += line.length + 1;
    kept += 1;
  }
  const dropped = skills.length - kept;
  if (dropped > 0) {
    lines.push(`  <!-- truncated: ${dropped} skills hidden -->`);
  }
  lines.push('</available_skills>');
  return {
    text: lines.join('\n'),
    format: 'compact-truncated',
    rendered: kept,
    truncated: dropped,
  };
}

/**
 * Convenience: filter + render in one call. Used by the persona loader.
 */
export function buildSkillsRegistry(
  skills: LoadedSkill[],
  allowList: string[] | undefined,
  config: Config,
): RenderedRegistry {
  const filtered = filterSkillsForAgent(skills, allowList);
  return renderSkillsRegistry(filtered, {
    maxSkillsInPrompt: config.skills.maxSkillsInPrompt,
    maxPromptChars: config.skills.maxPromptChars,
  });
}
