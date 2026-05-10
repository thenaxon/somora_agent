// Skill loader. Skills are markdown documents that tell the agent
// "this is how you do task X with our tools" — pure instruction text,
// not executable. They live in `~/.somora/skills/<slug>/SKILL.md` and
// follow the agentskills.io spec (Anthropic-originated standard,
// adopted by Claude Code, Cursor, OpenHands, OpenClaw, Hermes etc.).
//
// somora extras (when_to_use, requires) live under `metadata.somora.*`
// so strict agentskills.io validators stay green — the spec allows
// free-form metadata. See `private/skills-design.md` for the full
// rationale and the user-confirmed decisions.
//
// Files are re-read on every loadAvailableSkills() call so editing a
// SKILL.md takes effect on the next turn — same convention as
// persona/loader.ts. If perf becomes an issue later we can cache.

import { execFile } from 'node:child_process';
import { findBin } from './path-helpers.ts';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import matter from 'gray-matter';
import { z } from 'zod';
import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { lintSkillBody, summarizeFindings, type LintFinding } from './lint.ts';

const execFileP = promisify(execFile);

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const SKILLS_DIR = join(SOMORA_HOME, 'skills');

// agentskills.io spec: name is [a-z0-9-], max 64 chars, no leading/
// trailing/consecutive hyphens, must equal the parent dir name.
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const SomoraExtrasSchema = z
  .object({
    when_to_use: z.string().max(2000).optional(),
    requires: z
      .object({
        bins: z.array(z.string().min(1)).optional(),
        config: z.array(z.string().min(1)).optional(),
        /** Documentation list of env vars the skill needs at runtime.
         *  somora does NOT auto-inject these (no secrets-store yet);
         *  the skill tool surfaces the list so the agent + user know
         *  what to export before invoking the skill's commands. */
        env_vars: z.array(z.string().min(1)).optional(),
      })
      .optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

// Top-level frontmatter is `.strict()` — unknown top-level keys are an
// authoring mistake that should fail loud, not pass through silently.
// The agentskills.io spec is finite and well-defined; if we want to
// support a new top-level key we add it explicitly here.
//
// `metadata` itself stays `.passthrough()` because it's the documented
// extension point of the spec — somora uses `metadata.somora.*`,
// openclaw uses `metadata.openclaw.*`, and other ecosystems may add
// their own. Inside `metadata.somora` we ARE strict (SomoraExtrasSchema
// above), so somora-side typos still fail loud.
//
// `homepage` is listed as a top-level field because it's a common
// agentskills.io convention; if you add another, add it here too.
const SkillFrontmatterSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    homepage: z.string().max(500).optional(),
    license: z.string().max(200).optional(),
    compatibility: z.string().max(500).optional(),
    'allowed-tools': z.string().max(500).optional(),
    'disable-model-invocation': z.boolean().optional(),
    metadata: z
      .object({
        somora: SomoraExtrasSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface LoadedSkill {
  name: string;
  description: string;
  /** Resolved when_to_use (from `metadata.somora.when_to_use`). */
  whenToUse?: string;
  /** Frontmatter `requires.bins` — already checked. */
  requiresBins: string[];
  /** Frontmatter `requires.config` — already checked. */
  requiresConfig: string[];
  /** Frontmatter `requires.env_vars` — documentation only, not
   *  auto-injected. The skill tool surfaces this so the agent/user
   *  know what to set before invoking commands from the body. */
  requiresEnvVars: string[];
  /** Optional tags from `metadata.somora.tags`. */
  tags: string[];
  /** Absolute path to the skill folder (parent of SKILL.md). */
  dir: string;
  /** Markdown body of SKILL.md, frontmatter stripped. */
  body: string;
  /** True if all `requires.bins` are on PATH and `requires.config` keys are set. */
  available: boolean;
  /** Human-readable reason when `available` is false (e.g. "missing bin: op"). */
  unavailableReason?: string;
  /** Body-lint findings (anti-pattern detection). Errors mark the skill
   *  unavailable so the agent never sees a misleading body; warnings
   *  surface to the operator log without blocking. */
  lintFindings: LintFinding[];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function isOnPath(bin: string): Promise<boolean> {
  // Delegated to findBin so the hybrid which-then-stat strategy is
  // shared with the exec tool's PATH enrichment. See path-helpers.ts
  // for the full why (Hans bug 2026-05-09: brew/cargo/go binaries
  // invisible to the systemd-service-default PATH).
  return findBin(bin);
}

/** Resolve a dotted config key (e.g. `obsidian.vault_dir`) to a value
 *  in the loaded config. Returns true if the key resolves to a non-
 *  empty string/number/object — same intuition as "this is configured". */
function isConfigKeySet(config: Config, key: string): boolean {
  const parts = key.split('.');
  let cur: unknown = config;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return false;
  }
  if (cur === null || cur === undefined) return false;
  if (typeof cur === 'string') return cur.length > 0;
  if (typeof cur === 'number') return true;
  if (typeof cur === 'boolean') return cur === true;
  return true;
}

async function checkAvailability(
  fm: SkillFrontmatter,
  config: Config,
): Promise<{ available: boolean; reason?: string }> {
  const requires = fm.metadata?.somora?.requires;
  if (!requires) return { available: true };
  const bins = requires.bins ?? [];
  for (const bin of bins) {
    if (!(await isOnPath(bin))) {
      return { available: false, reason: `missing bin: ${bin}` };
    }
  }
  const cfgKeys = requires.config ?? [];
  for (const key of cfgKeys) {
    if (!isConfigKeySet(config, key)) {
      return { available: false, reason: `missing config: ${key}` };
    }
  }
  // Verify declared env_vars are actually present in this server's
  // process env. Skills that fail this check should report unavailable
  // with a precise reason instead of letting the agent hack around it
  // (the gog-skill-body anti-pattern from 2026-05-10: the body grew a
  // 17-line `eval $(brew shellenv) + export GOG_*=…` recipe precisely
  // because env-inheritance was inconsistent across agents and there
  // was no precondition check).
  const envVars = requires.env_vars ?? [];
  const missingEnv: string[] = [];
  for (const name of envVars) {
    if (!process.env[name]) missingEnv.push(name);
  }
  if (missingEnv.length > 0) {
    return {
      available: false,
      reason:
        `missing env vars: ${missingEnv.join(', ')} — set them in ~/.somora/somora.env ` +
        `(loaded at server start) or in the agent's launch environment. Do NOT inject ` +
        `them per-call from inside the agent.`,
    };
  }
  return { available: true };
}

async function loadOneSkill(slug: string, config: Config): Promise<LoadedSkill | null> {
  // Strict folder-name validation upfront so we reject a malicious
  // ../../../etc dir before any FS reads.
  if (!SKILL_NAME_RE.test(slug) || slug.length > 64) {
    logger.warn({ msg: 'skills.skip_invalid_dir', slug });
    return null;
  }
  const dir = join(SKILLS_DIR, slug);
  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch {
    return null;
  }
  if (!dirStat.isDirectory()) return null;
  const skillMdPath = join(dir, 'SKILL.md');
  if (!(await fileExists(skillMdPath))) {
    logger.warn({ msg: 'skills.no_skill_md', slug });
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(skillMdPath, 'utf8');
  } catch (err) {
    logger.warn({
      msg: 'skills.read_failed',
      slug,
      err: (err as Error).message,
    });
    return null;
  }

  let parsed;
  try {
    parsed = matter(raw);
  } catch (err) {
    logger.warn({
      msg: 'skills.frontmatter_parse_failed',
      slug,
      err: (err as Error).message,
    });
    return null;
  }

  let fm: SkillFrontmatter;
  try {
    fm = SkillFrontmatterSchema.parse(parsed.data ?? {});
  } catch (err) {
    logger.warn({
      msg: 'skills.frontmatter_invalid',
      slug,
      err: (err as Error).message,
    });
    return null;
  }

  // agentskills.io: `name` MUST equal the parent directory name.
  // We allow a missing `name` and fall back to the dir slug, but a
  // mismatch is a hard reject — it would break tool routing.
  if (fm.name !== slug) {
    logger.warn({
      msg: 'skills.name_mismatch',
      slug,
      frontmatter_name: fm.name,
    });
    return null;
  }
  if (!SKILL_NAME_RE.test(fm.name)) {
    logger.warn({ msg: 'skills.name_invalid_chars', slug });
    return null;
  }

  const somora = fm.metadata?.somora;
  const body = parsed.content.trim();

  // Body-lint runs before availability so authoring errors (Setup-in-body,
  // eval $(brew shellenv), ...) preempt env/bin checks. Errors mark the
  // skill unavailable — we never expose a misleading body to the agent.
  // Warnings just log; the skill stays usable.
  const lintFindings = lintSkillBody(body);
  const lintSummary = summarizeFindings(lintFindings);
  if (lintSummary.warningCount > 0) {
    logger.warn({
      msg: 'skills.lint_warnings',
      slug,
      count: lintSummary.warningCount,
      rules: lintFindings
        .filter((f) => f.severity === 'warning')
        .map((f) => `${f.rule}@L${f.line}`)
        .slice(0, 5)
        .join(','),
    });
  }
  if (lintSummary.errorCount > 0) {
    logger.warn({
      msg: 'skills.lint_errors',
      slug,
      count: lintSummary.errorCount,
      rules: lintSummary.shortReason,
    });
  }

  // Availability rolls in lint errors: if the body has anti-patterns the
  // skill can't be safely activated even if bins/env are present. The
  // operator sees the skill in `skill list` with available:false and a
  // reason that points at the lint findings.
  const avail = await checkAvailability(fm, config);
  let available = avail.available;
  let unavailableReason = avail.reason;
  if (available && lintSummary.errorCount > 0) {
    available = false;
    unavailableReason = `body lint failed: ${lintSummary.shortReason}. Inspect with logs (msg=skills.lint_errors).`;
  }

  return {
    name: fm.name,
    description: fm.description,
    whenToUse: somora?.when_to_use,
    requiresBins: somora?.requires?.bins ?? [],
    requiresConfig: somora?.requires?.config ?? [],
    requiresEnvVars: somora?.requires?.env_vars ?? [],
    tags: somora?.tags ?? [],
    dir,
    body,
    available,
    unavailableReason,
    lintFindings,
  };
}

/**
 * Scan `~/.somora/skills/` and return all valid skills, sorted by name.
 * Invalid skills (missing SKILL.md, bad frontmatter, name/dir mismatch)
 * are logged at warn level and silently skipped — we never want a single
 * malformed skill to break the entire registry.
 */
export async function loadAvailableSkills(config: Config): Promise<LoadedSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    logger.warn({ msg: 'skills.scan_failed', err: (err as Error).message });
    return [];
  }
  const out: LoadedSkill[] = [];
  for (const entry of entries) {
    const skill = await loadOneSkill(entry, config);
    if (skill) out.push(skill);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
