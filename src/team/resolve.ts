// Validation + resolution of a parsed team file against the agents on
// disk. Pure — no I/O — so the CLI, the server and the tests share it.

import {
  DEFAULT_TEAM_RULES,
  TeamFileSchema,
  type ResolvedTeam,
  type ResolvedTeamAgent,
  type TeamAgentInfo,
  type TeamFile,
  type TeamIssue,
} from './types.ts';

/** Parse + structural validation. Returns the file or the issues that
 *  make it unusable (schema errors, unknown reports_to, cycles). */
export function parseTeamFile(raw: unknown): { file: TeamFile; issues: [] } | { file: null; issues: TeamIssue[] } {
  const parsed = TeamFileSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      file: null,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    };
  }
  const file = parsed.data;
  const issues: TeamIssue[] = [];
  const names = Object.keys(file.agents);
  for (const name of names) {
    const target = file.agents[name]!.reports_to;
    if (target === name) {
      issues.push({ path: `agents.${name}.reports_to`, message: 'an agent cannot report to itself' });
    } else if (target !== 'principal' && !(target in file.agents)) {
      issues.push({
        path: `agents.${name}.reports_to`,
        message: `'${target}' is neither 'principal' nor an agent listed in this file`,
      });
    }
  }
  if (issues.length > 0) return { file: null, issues };
  // Cycle check: every agent must reach the principal.
  for (const name of names) {
    const seen = new Set<string>([name]);
    let cur = file.agents[name]!.reports_to;
    while (cur !== 'principal') {
      if (seen.has(cur)) {
        issues.push({ path: `agents.${name}.reports_to`, message: `reporting cycle: ${[...seen, cur].join(' → ')}` });
        break;
      }
      seen.add(cur);
      cur = file.agents[cur]!.reports_to;
    }
  }
  if (issues.length > 0) return { file: null, issues };
  return { file, issues: [] };
}

/** Title fallback chain: file `title` → frontmatter `role` → `description` → the name. */
function titleFor(name: string, fileTitle: string | undefined, info: TeamAgentInfo | undefined): string {
  return fileTitle ?? info?.role ?? info?.description ?? name;
}

/** Combine a valid file with the agents on disk. Agents in the file but
 *  not on disk are dropped (with a warning) — their children re-attach
 *  to the nearest existing ancestor so the tree stays connected. */
export function resolveTeam(file: TeamFile, onDisk: TeamAgentInfo[]): ResolvedTeam {
  const infoByName = new Map(onDisk.map((a) => [a.name, a]));
  const warnings: string[] = [];
  const missing = Object.keys(file.agents).filter((n) => !infoByName.has(n));
  for (const m of missing) warnings.push(`agents.${m}: no such agent directory — skipped`);

  const existing = Object.keys(file.agents).filter((n) => infoByName.has(n));
  const effectiveParent = (name: string): string => {
    let cur = file.agents[name]!.reports_to;
    while (cur !== 'principal' && !infoByName.has(cur)) cur = file.agents[cur]!.reports_to;
    return cur;
  };

  const agents: Record<string, ResolvedTeamAgent> = {};
  for (const name of existing) {
    const a = file.agents[name]!;
    agents[name] = {
      name,
      title: titleFor(name, a.title, infoByName.get(name)),
      reportsTo: effectiveParent(name),
      involveFor: a.involve_for ?? [],
      notFor: a.not_for ?? [],
      ...(a.notes ? { notes: a.notes } : {}),
      children: [],
      depth: 0,
    };
  }
  for (const name of existing) {
    const parent = agents[name]!.reportsTo;
    if (parent !== 'principal') agents[parent]!.children.push(name);
  }
  const order: string[] = [];
  const walk = (parent: string, depth: number): void => {
    const kids = existing.filter((n) => agents[n]!.reportsTo === parent);
    for (const k of kids) {
      agents[k]!.depth = depth;
      order.push(k);
      walk(k, depth + 1);
    }
  };
  walk('principal', 1);

  const unlisted = onDisk
    .filter((a) => !(a.name in file.agents))
    .map((a) => ({ name: a.name, title: titleFor(a.name, undefined, a) }));
  for (const u of unlisted) warnings.push(`${u.name} exists but is not in team.yaml — shown under "Not in the org chart"`);

  return {
    principal: file.principal,
    rules: file.rules ?? [...DEFAULT_TEAM_RULES],
    agents,
    order,
    unlisted,
    missing,
    warnings,
  };
}
