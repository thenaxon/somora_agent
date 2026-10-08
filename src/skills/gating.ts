// Per-agent skill visibility — the same shape and order as tool gating
// (src/tools/gating.ts), so the web matrix drives both the same way:
//
//   skills:
//     deny:  [instagram-downloader]   # these off
//     deny:  ["*"]                    # every skill off, later ones too
//     allow: [github]                 # on — also when "*" is denied
//
// A chat agent's allow list without "*" is the old "only these" form and
// keeps that meaning. Section missing = no restriction.
//
// Why a deny-list at all when an allow-list already existed: the old
// `skills: [a, b]` form means "only these", so un-ticking ONE skill in
// a matrix would have to write a list of all the others — and a skill
// installed next week would be invisible to that agent by surprise.
// The tool matrix avoids exactly that by managing exact-name denies;
// skills now do the same. The list form stays valid as an allow-list
// shorthand (the operator, 2026-08-31).
//
// Enforced at every surface that hands a skill to an agent: the
// <available_skills> registry in the system prompt, `skill_list`, and
// `skill` activation — including when another agent delegates via
// agent_ask: hidden is hidden, the work stays with an agent that has
// the skill.

export interface SkillGating {
  deny: string[];
  allow: string[];
  /** Builders: nothing is offered unless `allow` names it — an empty
   *  allow list means NONE here, not "everything" as for chat agents. */
  defaultDeny?: boolean;
}

/** The gating a builder runs with: its own allow/deny, and no skill at
 *  all when it allows none. */
export function builderSkillGating(own: SkillGating | undefined): SkillGating {
  return { deny: own?.deny ?? [], allow: own?.allow ?? [], defaultDeny: true };
}

/** agent.yaml `skills:` — legacy allow-list, or the tools-style object. */
export type RawSkillGating = string[] | { deny?: string[]; allow?: string[] } | undefined;

/** agentskills.io: [a-z0-9-], max 64 chars. Same rule the loader
 *  applies to skill directories, so a typo can't smuggle a pattern. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertValidSkillName(name: string): void {
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name: ${JSON.stringify(name)}`);
  }
}

/** Normalize either agent.yaml form. An empty legacy list keeps its
 *  documented lenient meaning (no restriction). */
export function normalizeSkillGating(raw: RawSkillGating): SkillGating | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw.length === 0 ? undefined : { deny: [], allow: [...raw] };
  }
  const deny = raw.deny ?? [];
  const allow = raw.allow ?? [];
  if (deny.length === 0 && allow.length === 0) return undefined;
  return { deny: [...deny], allow: [...allow] };
}

/** `*` under deny: every skill off, skills added later too. */
export const ALL_SKILLS = '*';

/**
 * Decided in this order (same shape as isToolAllowed):
 *   1. named in deny → off      2. named in allow → on
 *   3. deny holds `*` → off     4. builder → off (none unless allowed)
 *   5. chat with an allow list in the old "only these" form → off
 *   6. otherwise on
 */
export function isSkillAllowed(name: string, gating: SkillGating | undefined): boolean {
  if (!gating) return true;
  if (gating.deny.includes(name)) return false;
  if (gating.allow.includes(name)) return true;
  if (gating.deny.includes(ALL_SKILLS)) return false;
  if (gating.defaultDeny) return false;
  return gating.allow.length === 0;
}
