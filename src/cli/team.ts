// `somora team` — operator commands for team.yaml (design:
// private/team-design.md). Not agent tools: agents only ever READ the
// rendered block; the operator edits the file (or, from Phase 2, the
// web Team window) and uses these to bootstrap and verify it.
//
//   somora team init [--principal <name>]   write a first team.yaml from the agents on disk
//   somora team check                        validate, list warnings, find old team prose in personas
//   somora team show <agent>                 print the block that agent gets in its prompt

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAgents } from '../persona/loader.ts';
import { renderTeamBlock, TEAM_BLOCK_SOFT_MAX_CHARS } from '../team/render.ts';
import { resolveTeam } from '../team/resolve.ts';
import { loadTeamFile, teamFilePath } from '../team/store.ts';
import { DEFAULT_TEAM_RULES } from '../team/types.ts';

function usage(): string {
  return `Usage:
  somora team init [--principal <name>]   write ~/.somora/team.yaml from the agents on disk (never overwrites)
  somora team check                        validate the file, report warnings and old team prose in personas
  somora team show <agent>                 print the "# Your team" block that agent sees
`;
}

const yamlStr = (s: string): string => JSON.stringify(s);

async function cmdInit(args: string[]): Promise<number> {
  const path = teamFilePath();
  if (existsSync(path)) {
    process.stderr.write(`team.yaml already exists: ${path}\nEdit it by hand, or move it away first.\n`);
    return 1;
  }
  let principal = 'Principal';
  const i = args.indexOf('--principal');
  if (i >= 0 && args[i + 1]) principal = args[i + 1]!;
  const agents = await listAgents();
  if (agents.length === 0) {
    process.stderr.write('no agents found — create an agent first (somora init writes a starter agent).\n');
    return 1;
  }
  const lines: string[] = [
    '# somora team — who is who, who reports to whom, who to involve for what.',
    '# Rendered into every agent\'s system prompt as "# Your team" (see docs/team.md).',
    '# Edit by hand or in the web Team window; agents read it, they never write it.',
    'version: 1',
    '',
    'principal:                     # the human at the root',
    `  name: ${yamlStr(principal)}`,
    '  title: Principal',
    '  about: ""                    # 1–3 sentences, optional',
    '',
    'rules:                         # rendered verbatim; delete a line you do not want',
    ...DEFAULT_TEAM_RULES.map((r) => `  - ${yamlStr(r)}`),
    '',
    'agents:                        # every entry must be an agent directory under ~/.somora/agents/',
  ];
  for (const a of agents) {
    lines.push(`  ${a.name}:`);
    lines.push('    reports_to: principal    # or another agent name');
    if (a.role) lines.push(`    title: ${yamlStr(a.role)}`);
    lines.push('    involve_for: []          # short trigger phrases, e.g. "library docs", "framework comparisons"');
    lines.push('    not_for: []              # what NOT to bring here, e.g. "media"');
  }
  lines.push('');
  writeFileSync(path, lines.join('\n'), 'utf8');
  process.stdout.write(`wrote ${path} with ${agents.length} agent(s), all reporting to the principal.\n`);
  process.stdout.write('Next: set reports_to / involve_for / not_for, then `somora team check` and `somora team show <agent>`.\n');
  return 0;
}

/** Personas that still carry a hand-written org chart — the thing
 *  team.yaml replaces. Heuristic, report-only. */
function scanPersonasForTeamProse(agentNames: string[]): Array<{ agent: string; line: number; text: string }> {
  const home = process.env.SOMORA_HOME ?? join(process.env.HOME ?? '', '.somora');
  const hits: Array<{ agent: string; line: number; text: string }> = [];
  for (const name of agentNames) {
    const file = join(home, 'agents', name, 'AGENTS.md');
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((l, idx) => {
      const tree = /[└├]──/.test(l);
      const heading = /^#{1,4}\s.*\b(team|org chart|organisation|organization|who is who|wer ist wer|platz im team)\b/i.test(l);
      if (tree || heading) hits.push({ agent: name, line: idx + 1, text: l.trim().slice(0, 80) });
    });
  }
  return hits;
}

async function cmdCheck(): Promise<number> {
  const path = teamFilePath();
  const load = await loadTeamFile();
  const agents = await listAgents();
  if (!load.exists) {
    process.stdout.write(`no team.yaml at ${path} — the team block is off. Run \`somora team init\` to start one.\n`);
    return 0;
  }
  if (!load.file) {
    process.stderr.write(`team.yaml is INVALID (${path}):\n`);
    for (const i of load.issues) process.stderr.write(`  - ${i.path}: ${i.message}\n`);
    process.stderr.write('The server keeps the last valid team (or none) until this is fixed.\n');
    return 1;
  }
  const team = resolveTeam(load.file, agents.map((a) => ({ name: a.name, role: a.role, description: a.description })));
  process.stdout.write(`team.yaml OK: principal ${team.principal.name}, ${team.order.length} agent(s) in the chart.\n`);
  for (const w of team.warnings) process.stdout.write(`  warning: ${w}\n`);
  for (const name of team.order) {
    const block = renderTeamBlock(team, name) ?? '';
    const flag = block.length > TEAM_BLOCK_SOFT_MAX_CHARS ? `  ← over ${TEAM_BLOCK_SOFT_MAX_CHARS} chars, shorten involve_for/not_for/notes` : '';
    process.stdout.write(`  ${name}: block ${block.length} chars${flag}\n`);
  }
  const hits = scanPersonasForTeamProse(agents.map((a) => a.name));
  if (hits.length > 0) {
    process.stdout.write('\nPersonas that still carry hand-written team prose (team.yaml replaces it — remove after checking `somora team show`):\n');
    const byAgent = new Map<string, typeof hits>();
    for (const h of hits) byAgent.set(h.agent, [...(byAgent.get(h.agent) ?? []), h]);
    for (const [agent, list] of byAgent) {
      process.stdout.write(`  ${agent}/AGENTS.md: ${list.length} line(s), first at line ${list[0]!.line}: "${list[0]!.text}"\n`);
    }
  }
  return 0;
}

async function cmdShow(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    process.stderr.write(usage());
    return 2;
  }
  const load = await loadTeamFile();
  if (!load.file) {
    process.stderr.write(load.exists ? 'team.yaml is invalid — run `somora team check`.\n' : 'no team.yaml — run `somora team init`.\n');
    return 1;
  }
  const agents = await listAgents();
  if (!agents.some((a) => a.name === name)) {
    process.stderr.write(`unknown agent '${name}'. Agents: ${agents.map((a) => a.name).join(', ')}\n`);
    return 1;
  }
  const team = resolveTeam(load.file, agents.map((a) => ({ name: a.name, role: a.role, description: a.description })));
  process.stdout.write((renderTeamBlock(team, name) ?? '(empty team)') + '\n');
  return 0;
}

export async function runTeamCli(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'init':
      return cmdInit(args.slice(1));
    case 'check':
      return cmdCheck();
    case 'show':
      return cmdShow(args.slice(1));
    default:
      process.stdout.write(usage());
      return sub ? 2 : 0;
  }
}
