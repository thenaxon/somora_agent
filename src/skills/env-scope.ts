// Skill-scoped env injection for exec (2026-07-27, gog friction report).
//
// Skills declare `requires.env_vars` (secrets/config their CLI needs) and
// `requires.bins` (the binaries they drive). Historically the declared
// vars were documentation + availability-check only: operators put the
// values into ~/.somora/somora.env, which lands in process.env at server
// boot — and from there leaked into EVERY spawned exec child, whether the
// command had anything to do with the skill or not. On hosts where that
// felt wrong, per-host wrapper-script workarounds grew instead (Lucy case
// study 2026-07-24) — three competing conventions.
//
// This module makes the declaration operational, scoped by PROGRAM NAME
// (Rene's decision 2026-07-27):
//
//   - Every env var declared by ANY skill is STRIPPED from spawned exec
//     children by default (deny-by-default).
//   - When the command visibly invokes one of a skill's declared bins,
//     exactly THAT skill's vars are injected back (values from the server
//     process env, i.e. somora.env). `gog sync …` sees GOG_*, nothing
//     else does.
//
// Matching scans all command tokens (not just the first) so compound
// commands (`cd x && gog sync`, `VAR=1 gog …`) still match. A command
// that merely MENTIONS a bin name as an argument over-matches — accepted:
// injection just makes the var present, and a command that can name the
// bin could invoke it anyway.
//
// Known limits (documented in docs/skills.md):
//   - Scripts that call a skill bin only INDIRECTLY (wrapper .sh) don't
//     match — invoke the bin visibly, or pass the var via exec's `env`.
//   - A skill that declares env_vars but no bins can never match — its
//     vars stay stripped everywhere. Declare the bins.
//   - Local exec only. tmux panes are interactive (no command to match
//     at create time) and remote exec runs under the remote host's env.

import type { Config } from '../config/types.ts';
import { parseBinRequirement } from './bin-checks.ts';
import { loadAvailableSkills, type LoadedSkill } from './load.ts';

export interface SkillEnvScope {
  /** Union of all skill-declared env vars — removed from the child env
   *  unless re-injected below. */
  stripVars: string[];
  /** Vars of the skills whose bins appear in the command, with values
   *  resolved from the provided env. Applied after the strip. */
  injectEnv: Record<string, string>;
  /** Names of the matched skills (log/diagnostics). */
  matchedSkills: string[];
}

type SkillEnvSource = Pick<LoadedSkill, 'name' | 'requiresBins' | 'requiresEnvVars'>;

/** Tokens that can precede the actual binary in shell commands. */
const SHELL_SEPARATORS = /[\s;|&()<>]+/;

/** Extract candidate binary names from a shell command: every token,
 *  quote-stripped, plus its basename. Pure — exported for tests. */
export function extractCommandBins(command: string): Set<string> {
  const out = new Set<string>();
  for (const raw of command.split(SHELL_SEPARATORS)) {
    if (!raw) continue;
    const tok = raw.replace(/^["']+|["']+$/g, '');
    if (!tok) continue;
    out.add(tok);
    const slash = tok.lastIndexOf('/');
    if (slash >= 0 && slash < tok.length - 1) out.add(tok.slice(slash + 1));
  }
  return out;
}

/** Compute the scope for one command against a skill set. Pure —
 *  exported for tests; values come from the passed env, not process.env. */
export function computeSkillEnvScope(
  command: string,
  skills: SkillEnvSource[],
  env: Record<string, string | undefined>,
): SkillEnvScope {
  const declaring = skills.filter((s) => s.requiresEnvVars.length > 0);
  if (declaring.length === 0) {
    return { stripVars: [], injectEnv: {}, matchedSkills: [] };
  }
  const stripVars = [...new Set(declaring.flatMap((s) => s.requiresEnvVars))];
  const tokens = extractCommandBins(command);
  const injectEnv: Record<string, string> = {};
  const matchedSkills: string[] = [];
  for (const skill of declaring) {
    // requiresBins entries may carry version constraints ("gog>=0.30")
    // — match on the bare binary name.
    if (!skill.requiresBins.some((entry) => tokens.has(parseBinRequirement(entry).bin))) continue;
    matchedSkills.push(skill.name);
    for (const name of skill.requiresEnvVars) {
      const value = env[name];
      if (value !== undefined) injectEnv[name] = value;
    }
  }
  return { stripVars, injectEnv, matchedSkills };
}

// ---------------------------------------------------------------------------
// Cached convenience wrapper for the exec dispatcher. loadAvailableSkills
// reads + lints every SKILL.md — fine per turn, too heavy per exec call
// when an agent runs a burst of commands. A short TTL keeps the cost at
// one directory scan per burst while a freshly installed skill still
// becomes injectable within seconds.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15_000;
let cachedAt = 0;
let cachedSkills: SkillEnvSource[] | null = null;

export async function skillEnvScopeForCommand(
  command: string,
  config: Config,
): Promise<SkillEnvScope | undefined> {
  if (!config.skills.envScoping) return undefined;
  const now = Date.now();
  if (!cachedSkills || now - cachedAt > CACHE_TTL_MS) {
    const loaded = await loadAvailableSkills(config);
    cachedSkills = loaded.map((s) => ({
      name: s.name,
      requiresBins: s.requiresBins,
      requiresEnvVars: s.requiresEnvVars,
    }));
    cachedAt = now;
  }
  return computeSkillEnvScope(command, cachedSkills, process.env);
}

/** Test hook — drop the TTL cache. */
export function resetSkillEnvScopeCache(): void {
  cachedSkills = null;
  cachedAt = 0;
}
