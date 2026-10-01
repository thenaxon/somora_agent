// Tests for the team module: schema/validation (resolve.ts) and the
// rendered `# Your team` block (render.ts).
//
// Run: npx tsx src/team/team.test.mts

import assert from 'node:assert/strict';
import { parseTeamFile, resolveTeam } from './resolve.ts';
import { renderTeamBlock, TEAM_BLOCK_SOFT_MAX_CHARS } from './render.ts';
import { DEFAULT_TEAM_RULES, type TeamAgentInfo } from './types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const onDisk: TeamAgentInfo[] = [
  { name: 'nova', role: 'COO', description: 'Orchestrator' },
  { name: 'ada', role: 'Engineer', description: 'Code' },
  { name: 'bea', role: 'Researcher', description: 'Research' },
  { name: 'cleo', description: 'Media & Film Designer' },
  { name: 'ghost', role: 'Unassigned', description: 'not in file' },
];

const good = {
  version: 1,
  principal: { name: 'Max', about: 'Investor. Final say.' },
  agents: {
    nova: { reports_to: 'principal', title: 'COO & Orchestrator', involve_for: ['coordination'], not_for: ['hands-on coding'] },
    ada: { reports_to: 'nova', involve_for: ['code', 'builds'], not_for: ['research'], notes: 'Comes to cleo for assets.' },
    bea: { reports_to: 'nova', involve_for: ['investigative research'] },
    cleo: { reports_to: 'nova' },
    vanished: { reports_to: 'ada' },
  },
};

// ── schema + validation ──────────────────────────────────────────────
{
  const r = parseTeamFile(good);
  check('valid file parses', r.file !== null, JSON.stringify(r.issues));

  const cyc = parseTeamFile({ ...good, agents: { a: { reports_to: 'b' }, b: { reports_to: 'a' } } });
  check('cycle is rejected', cyc.file === null && cyc.issues.some((i) => /cycle/.test(i.message)), JSON.stringify(cyc.issues));

  const self = parseTeamFile({ ...good, agents: { a: { reports_to: 'a' } } });
  check('self-report is rejected', self.file === null && /itself/.test(self.issues[0]?.message ?? ''));

  const unknown = parseTeamFile({ ...good, agents: { a: { reports_to: 'nobody' } } });
  check('unknown reports_to is rejected with the path', unknown.file === null && unknown.issues[0]?.path === 'agents.a.reports_to');

  const noPrincipal = parseTeamFile({ version: 1, agents: {} });
  check('missing principal is a schema error', noPrincipal.file === null && noPrincipal.issues.some((i) => i.path.startsWith('principal')));

  const badVersion = parseTeamFile({ ...good, version: 2 });
  check('unknown version is rejected', badVersion.file === null);

  const extra = parseTeamFile({ ...good, agents: { a: { reports_to: 'principal', color: 'red' } } });
  check('unknown agent keys are rejected (strict)', extra.file === null);
}

// ── resolution ───────────────────────────────────────────────────────
const team = resolveTeam(parseTeamFile(good).file!, onDisk);
{
  check('missing agent is skipped and warned', team.missing.includes('vanished') && team.warnings.some((w) => w.includes('vanished')));
  check('unlisted agent is reported', team.unlisted.map((u) => u.name).includes('ghost'));
  check('order is a pre-order walk', team.order.join(',') === 'nova,ada,bea,cleo', team.order.join(','));
  check('title falls back to frontmatter role', team.agents.ada!.title === 'Engineer');
  check('title falls back to description when no role', team.agents.cleo!.title === 'Media & Film Designer');
  check('file title wins', team.agents.nova!.title === 'COO & Orchestrator');
  check('children in file order', team.agents.nova!.children.join(',') === 'ada,bea,cleo');
  check('depth set', team.agents.nova!.depth === 1 && team.agents.ada!.depth === 2);
  check('default rules when none given', team.rules.length === DEFAULT_TEAM_RULES.length);
  const withRules = resolveTeam(parseTeamFile({ ...good, rules: ['Only rule.'] }).file!, onDisk);
  check('explicit rules replace defaults', withRules.rules.length === 1 && withRules.rules[0] === 'Only rule.');
}

// ── rendering ────────────────────────────────────────────────────────
{
  const ada = renderTeamBlock(team, 'ada')!;
  check('block starts with heading', ada.startsWith('# Your team\n'));
  check('principal line with about', ada.includes('Max — Principal (human): Investor. Final say.'));
  check('self marker on own line', ada.includes('├── ada — Engineer  ← you'));
  check('no marker on others', !ada.includes('bea — Researcher  ← you'));
  check('superior line names nova', ada.includes('Your superior: nova — escalate there first'));
  check('peers exclude self', ada.includes('Your peers (same superior): bea, cleo.'));
  check('reports none', ada.includes('Your reports: none.'));
  check('involve line with not-for and notes',
    ada.includes('- nova (COO & Orchestrator): coordination. Not for: hands-on coding.'));
  check('self excluded from involve list', !ada.includes('- ada (Engineer)'));
  check('agents without phrases grouped', ada.includes('- cleo (Media & Film Designer).'));
  check('unlisted agent shown', ada.includes('Not in the org chart yet: ghost (Unassigned).'));
  check('rules rendered', ada.includes('Rules:\n- ' + DEFAULT_TEAM_RULES[0]));
  check('deterministic', renderTeamBlock(team, 'ada') === ada);
  check('under soft cap for a 5-agent team', ada.length < TEAM_BLOCK_SOFT_MAX_CHARS, String(ada.length));

  const nova = renderTeamBlock(team, 'nova')!;
  check('root child reports to principal directly', nova.includes('Your superior: Max, the principal'));
  check('reports listed', nova.includes('Your reports: ada, bea, cleo.'));
  check('peers none at root level', nova.includes('Your peers (same superior): none.'));
  check('ada notes rendered for nova', nova.includes('- ada (Engineer): code; builds. Not for: research. Comes to cleo for assets.'));

  const ghost = renderTeamBlock(team, 'ghost')!;
  check('unlisted self gets a placement note', ghost.includes('You are not placed in the org chart yet'));
  check('unlisted self marked', ghost.includes('ghost (Unassigned) ← you'));

  const inactiveFile = parseTeamFile({
    ...good,
    agents: { ...good.agents, bea: { reports_to: 'nova', involve_for: ['research'], active: false } },
  }).file!;
  const tInactive = resolveTeam(inactiveFile, onDisk);
  const adaI = renderTeamBlock(tInactive, 'ada')!;
  check('inactive marked in the chart', adaI.includes('├── bea — Researcher (currently inactive)'));
  check('inactive excluded from involve list', !adaI.includes('- bea (Researcher)'));
  check('inactive named in the do-not-involve line', adaI.includes('Currently inactive — do not involve: bea.'));
  check('inactive peer tagged', adaI.includes('Your peers (same superior): bea (inactive), cleo.'));
  const lisaI = renderTeamBlock(tInactive, 'bea')!;
  check('inactive self gets the notice', lisaI.includes('You are currently marked inactive in the team'));
  const naxonI = renderTeamBlock(tInactive, 'nova')!;
  check('inactive report tagged', naxonI.includes('Your reports: ada, bea (inactive), cleo.'));
  check('active default true', team.agents.ada!.active === true);

  const empty = resolveTeam(parseTeamFile({ version: 1, principal: { name: 'X' }, agents: {} }).file!, []);
  check('empty team renders nothing', renderTeamBlock(empty, 'anyone') === null);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
