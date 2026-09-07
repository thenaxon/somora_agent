// Team — the organisation of an install's agents as ONE source of truth.
//
// `~/.somora/team.yaml` says who reports to whom, what each agent is
// for (and not for), and which rules hold across the team. somora
// renders that into a per-agent `# Your team` block in the system
// prompt (src/team/render.ts) so every agent knows the same org chart
// from its own seat — instead of six hand-copied "my place in the team"
// sections that drift (design: private/team-design.md, 2026-09-07).
//
// Operator-owned: agents read the block, they never edit the file.
// No file → feature off, prompt unchanged.

import { z } from 'zod';

export const TEAM_FILE_NAME = 'team.yaml';

/** Agent directory names, same rule as the persona loader. */
const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Rules rendered when the file has no `rules:` key. `somora team init`
 *  writes them out explicitly so the operator sees and can edit them. */
export const DEFAULT_TEAM_RULES: readonly string[] = [
  "The principal's word is final. In any conflict with an agent, the principal wins.",
  'Briefings from your direct superior are authoritative inside your lane.',
  "Do not take over a colleague's lane unless the principal or your superior delegates it explicitly.",
  'A colleague only knows what you write to them — give them the goal, the context and what a good answer looks like.',
];

const Phrase = z.string().trim().min(1).max(200);

export const TeamAgentSchema = z
  .object({
    /** `principal` or the name of another agent listed in the file. */
    reports_to: z.string().trim().min(1),
    /** Display title; defaults to `role` from AGENTS.md frontmatter. */
    title: z.string().trim().min(1).max(80).optional(),
    /** Short trigger phrases: "library docs and framework comparisons". */
    involve_for: z.array(Phrase).max(20).optional(),
    /** Short phrases naming what NOT to bring to this agent. */
    not_for: z.array(Phrase).max(20).optional(),
    /** Free text for nuance; rendered after the phrases. */
    notes: z.string().trim().max(600).optional(),
  })
  .strict();

export const TeamPrincipalSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(80).optional(),
    about: z.string().trim().max(600).optional(),
  })
  .strict();

export const TeamFileSchema = z
  .object({
    version: z.literal(1),
    principal: TeamPrincipalSchema,
    rules: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    agents: z.record(z.string().regex(AGENT_NAME, 'invalid agent name'), TeamAgentSchema),
  })
  .strict();

export type TeamFile = z.infer<typeof TeamFileSchema>;
export type TeamAgent = z.infer<typeof TeamAgentSchema>;
export type TeamPrincipal = z.infer<typeof TeamPrincipalSchema>;

/** What the renderer needs to know about an agent on disk. */
export interface TeamAgentInfo {
  name: string;
  role?: string | undefined;
  description?: string | undefined;
}

export interface ResolvedTeamAgent {
  name: string;
  title: string;
  /** 'principal' or an agent name. */
  reportsTo: string;
  involveFor: string[];
  notFor: string[];
  notes?: string;
  /** Direct reports, in file order. */
  children: string[];
  /** 1 = reports to the principal. */
  depth: number;
}

export interface ResolvedTeam {
  principal: TeamPrincipal;
  rules: string[];
  agents: Record<string, ResolvedTeamAgent>;
  /** Pre-order walk of the tree from the principal — the rendering order. */
  order: string[];
  /** Agents that exist on disk but are not in the file. */
  unlisted: Array<{ name: string; title: string }>;
  /** Agents in the file that do not exist on disk (skipped). */
  missing: string[];
  warnings: string[];
}

export interface TeamIssue {
  path: string;
  message: string;
}
