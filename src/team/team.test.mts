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
  { name: 'naxon', role: 'COO', description: 'Orchestrator' },
  { name: 'hans', role: 'Engineer', description: 'Code' },
  { name: 'lisa', role: 'Researcher', description: 'Research' },
  { name: 'spielberg', description: 'Media & Film Designer' },
  { name: 'ghost', role: 'Unassigned', description: 'not in file' },
];

const good = {
  version: 1,
  principal: { name: 'Rene', about: 'Investor. Final say.' },
  agents: {
    naxon: { reports_to: 'principal', title: 'COO & Orchestrator', involve_for: ['coordination'], not_for: ['hands-on coding'] },
    hans: { reports_to: 'naxon', involve_for: ['code', 'builds'], not_for: ['research'], notes: 'Comes to spielberg for assets.' },
    lisa: { reports_to: 'naxon', involve_for: ['investigative research'] },
    spielberg: { reports_to: 'naxon' },
    vanished: { reports_to: 'hans' },
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
  check('order is a pre-order walk', team.order.join(',') === 'naxon,hans,lisa,spielberg', team.order.join(','));
  check('title falls back to frontmatter role', team.agents.hans!.title === 'Engineer');
  check('title falls back to description when no role', team.agents.spielberg!.title === 'Media & Film Designer');
  check('file title wins', team.agents.naxon!.title === 'COO & Orchestrator');
  check('children in file order', team.agents.naxon!.children.join(',') === 'hans,lisa,spielberg');
  check('depth set', team.agents.naxon!.depth === 1 && team.agents.hans!.depth === 2);
  check('default rules when none given', team.rules.length === DEFAULT_TEAM_RULES.length);
  const withRules = resolveTeam(parseTeamFile({ ...good, rules: ['Only rule.'] }).file!, onDisk);
  check('explicit rules replace defaults', withRules.rules.length === 1 && withRules.rules[0] === 'Only rule.');
}

// ── rendering ────────────────────────────────────────────────────────
{
  const hans = renderTeamBlock(team, 'hans')!;
  check('block starts with heading', hans.startsWith('# Your team\n'));
  check('principal line with about', hans.includes('Rene — Principal (human): Investor. Final say.'));
  check('self marker on own line', hans.includes('├── hans — Engineer  ← you'));
  check('no marker on others', !hans.includes('lisa — Researcher  ← you'));
  check('superior line names naxon', hans.includes('Your superior: naxon — escalate there first'));
  check('peers exclude self', hans.includes('Your peers (same superior): lisa, spielberg.'));
  check('reports none', hans.includes('Your reports: none.'));
  check('involve line with not-for and notes',
    hans.includes('- naxon (COO & Orchestrator): coordination. Not for: hands-on coding.'));
  check('self excluded from involve list', !hans.includes('- hans (Engineer)'));
  check('agents without phrases grouped', hans.includes('- spielberg (Media & Film Designer).'));
  check('unlisted agent shown', hans.includes('Not in the org chart yet: ghost (Unassigned).'));
  check('rules rendered', hans.includes('Rules:\n- ' + DEFAULT_TEAM_RULES[0]));
  check('deterministic', renderTeamBlock(team, 'hans') === hans);
  check('under soft cap for a 5-agent team', hans.length < TEAM_BLOCK_SOFT_MAX_CHARS, String(hans.length));

  const naxon = renderTeamBlock(team, 'naxon')!;
  check('root child reports to principal directly', naxon.includes('Your superior: Rene, the principal'));
  check('reports listed', naxon.includes('Your reports: hans, lisa, spielberg.'));
  check('peers none at root level', naxon.includes('Your peers (same superior): none.'));
  check('hans notes rendered for naxon', naxon.includes('- hans (Engineer): code; builds. Not for: research. Comes to spielberg for assets.'));

  const ghost = renderTeamBlock(team, 'ghost')!;
  check('unlisted self gets a placement note', ghost.includes('You are not placed in the org chart yet'));
  check('unlisted self marked', ghost.includes('ghost (Unassigned) ← you'));

  const inactiveFile = parseTeamFile({
    ...good,
    agents: { ...good.agents, lisa: { reports_to: 'naxon', involve_for: ['research'], active: false } },
  }).file!;
  const tInactive = resolveTeam(inactiveFile, onDisk);
  const hansI = renderTeamBlock(tInactive, 'hans')!;
  check('inactive marked in the chart', hansI.includes('├── lisa — Researcher (currently inactive)'));
  check('inactive excluded from involve list', !hansI.includes('- lisa (Researcher)'));
  check('inactive named in the do-not-involve line', hansI.includes('Currently inactive — do not involve: lisa.'));
  check('inactive peer tagged', hansI.includes('Your peers (same superior): lisa (inactive), spielberg.'));
  const lisaI = renderTeamBlock(tInactive, 'lisa')!;
  check('inactive self gets the notice', lisaI.includes('You are currently marked inactive in the team'));
  const naxonI = renderTeamBlock(tInactive, 'naxon')!;
  check('inactive report tagged', naxonI.includes('Your reports: hans, lisa (inactive), spielberg.'));
  check('active default true', team.agents.hans!.active === true);

  const empty = resolveTeam(parseTeamFile({ version: 1, principal: { name: 'X' }, agents: {} }).file!, []);
  check('empty team renders nothing', renderTeamBlock(empty, 'anyone') === null);
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
