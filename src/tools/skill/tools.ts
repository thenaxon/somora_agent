// `skill` tool — activate a skill by name. Loads the skill's full
// SKILL.md body into the agent's context. The skill registry that the
// agent sees in its system prompt only carries name + description (+
// optional when_to_use); to actually FOLLOW a skill the agent calls
// this tool, then performs the work itself with the regular tools.
//
// Why a dedicated tool instead of the standard `file_read`: semantic
// clarity ("I am activating skill X" is a deliberate act, not a random
// file read), per-agent allow-list enforcement, and a future hook
// surface (telemetry, requires-recheck before activation, etc.). See
// `private/skills-design.md` for the full rationale.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import { loadPersona } from '../../persona/loader.ts';
import { loadAvailableSkills } from '../../skills/load.ts';
import { filterSkillsForAgent } from '../../skills/registry.ts';
import type { ToolDefinition } from '../types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const SKILLS_DIR = join(SOMORA_HOME, 'skills');

// Same regex as load.ts — must match the on-disk slug format. Cheap
// up-front rejection of obviously bad inputs (path traversal, casing).
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SkillInput = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(SKILL_NAME_RE, 'skill names are lowercase [a-z0-9-], no leading/trailing/consecutive hyphens')
      .describe(
        'Slug of the skill to activate (matches the directory name under ~/.somora/skills/, ' +
          'and the `name` listed in the system-prompt <available_skills> registry). Use exactly ' +
          'the name as shown in the registry — no path, no extension.',
      ),
  })
  .strict();

interface SkillOutput {
  name: string;
  description: string;
  when_to_use?: string;
  /** Full SKILL.md body (frontmatter stripped). The agent should treat
   *  this as instructions to follow — typically a multi-step procedure
   *  using the regular tools. */
  body: string;
  /** True if the skill's `requires.bins` and `requires.config` are all
   *  satisfied on this host. When false, body is still returned but
   *  the agent should consider whether the procedure can actually run. */
  available: boolean;
  /** Reason when `available` is false. */
  unavailable_reason?: string;
  /** Tags from `metadata.somora.tags`, when present. */
  tags?: string[];
}

export const skill: ToolDefinition<z.infer<typeof SkillInput>, SkillOutput> = {
  name: 'skill',
  toolset: 'skills',
  description:
    'Activate a skill — load its full step-by-step instructions into your context. ' +
    'The system prompt lists every available skill in <available_skills> with name, ' +
    'description, and (sometimes) when_to_use. When a task matches a skill, call this ' +
    'tool with the skill\'s `name` to pull the full SKILL.md body, then follow the ' +
    'instructions step by step using your normal tools (file_*, exec, tmux, web, …). ' +
    '\n\n' +
    'A skill is pure instruction text — it does NOT execute anything by itself. The ' +
    'work is yours to do based on what the body tells you. Skills may reference scripts ' +
    'or assets shipped alongside (paths relative to the skill folder); read them with ' +
    'file_read or run them with exec as the body directs. ' +
    '\n\n' +
    'Per-agent filtering: each agent sees only the skills allowed by its agent.yaml ' +
    'configuration (empty/unset = all skills). Calling this tool with a name that is ' +
    'not in your <available_skills> registry returns an error.',
  inputSchema: SkillInput,
  jsonSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Slug of the skill to activate, exactly as listed in <available_skills>. ' +
          'Lowercase letters, digits, dashes; no path, no extension.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async handler(input, ctx): Promise<SkillOutput> {
    // Re-load skills + persona on every call. Same convention as
    // persona/loader.ts: filesystem reads are cheap, edits take effect
    // on the next turn without a server restart.
    const persona = await loadPersona(ctx.agent);
    if (!persona) {
      throw new Error(`skill: agent '${ctx.agent}' not found`);
    }
    const all = await loadAvailableSkills(ctx.config);
    const allowed = filterSkillsForAgent(all, persona.skillsAllowList);
    const skill = allowed.find((s) => s.name === input.name);
    if (!skill) {
      const knownNames = allowed.map((s) => s.name);
      // Help the agent self-correct: if the requested name exists but
      // is filtered out, say so clearly.
      const inAllButFiltered = all.some((s) => s.name === input.name);
      if (inAllButFiltered) {
        throw new Error(
          `skill '${input.name}' exists but is not allowed for agent '${ctx.agent}'. ` +
            `Allowed skills: ${knownNames.join(', ') || '(none)'}.`,
        );
      }
      throw new Error(
        `skill '${input.name}' not found. Available: ${knownNames.join(', ') || '(none)'}.`,
      );
    }

    // Re-stat the file so we honor the configured per-file size cap
    // (`config.skills.maxSkillFileBytes`). The body in `skill.body` was
    // already read by loadAvailableSkills, but we want a fresh enforcement
    // point in case the file grew between scan and activation.
    const skillMdPath = join(SKILLS_DIR, skill.name, 'SKILL.md');
    try {
      const s = await stat(skillMdPath);
      if (s.size > ctx.config.skills.maxSkillFileBytes) {
        throw new Error(
          `skill '${skill.name}' SKILL.md is ${s.size} bytes, exceeds limit of ` +
            `${ctx.config.skills.maxSkillFileBytes} (config.skills.maxSkillFileBytes).`,
        );
      }
    } catch (err) {
      // Re-stat failure is unusual (we just listed it). Fall through to
      // returning the previously-read body — the cap-check is best-
      // effort, not a security gate.
      logger.warn({
        msg: 'skill.restat_failed',
        name: skill.name,
        err: (err as Error).message,
      });
    }

    // Re-read the body fresh so a SKILL.md edited mid-session takes
    // effect immediately. Reuse the parser path? Cheaper to just read
    // the file — frontmatter at the top is small, the body is what we
    // want. We strip frontmatter manually to avoid re-instantiating
    // gray-matter for a single read.
    let raw: string;
    try {
      raw = await readFile(skillMdPath, 'utf8');
    } catch (err) {
      logger.warn({
        msg: 'skill.body_read_failed',
        name: skill.name,
        err: (err as Error).message,
      });
      // Fall back to the body captured at scan time.
      raw = '';
    }
    let body = skill.body;
    if (raw) {
      // Strip a leading `---\n...\n---\n` frontmatter block if present.
      // We don't care about the YAML content here — that was already
      // validated at scan time.
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n?/);
      body = (fmMatch ? raw.slice(fmMatch[0].length) : raw).trim();
    }

    logger.info({
      msg: 'skill.activated',
      agent: ctx.agent,
      session: ctx.session,
      name: skill.name,
      available: skill.available,
      body_len: body.length,
    });

    return {
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse ? { when_to_use: skill.whenToUse } : {}),
      body,
      available: skill.available,
      ...(skill.unavailableReason ? { unavailable_reason: skill.unavailableReason } : {}),
      ...(skill.tags.length > 0 ? { tags: skill.tags } : {}),
    };
  },
};

export function skillTools(): ToolDefinition[] {
  return [skill] as ToolDefinition[];
}
