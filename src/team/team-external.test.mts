// External agents in the team (docs/a2a.md, docs/team.md): placed in
// team.yaml like anyone, marked as external in the org chart; one that
// takes work over A2A is listed under who to involve with how to hand it
// work; one without A2A access is named as chat-only, never as someone
// to involve; unplaced ones get the same lines; the builder's short block
// lists only those that take work. The roster brings them in from
// config.yaml.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '../config/types.ts';
import { setConfig } from '../server/server-state.ts';
import { parseTeamFile, resolveTeam } from './resolve.ts';
import { renderTeamBlock, renderTeamBlockCompact } from './render.ts';
import { getResolvedTeam, resetTeamCache } from './store.ts';
import type { TeamAgentInfo } from './types.ts';

const onDisk: TeamAgentInfo[] = [
  { name: 'nova', role: 'COO' },
  { name: 'ada', role: 'Engineer' },
  { name: 'claw', description: 'OpenClaw agent', kind: 'external', external: { label: 'OpenClaw', a2a: true } },
  { name: 'herm', description: 'Hermes agent', kind: 'external', external: { label: 'Hermes', a2a: false } },
  { name: 'loose', description: 'Hermes agent', kind: 'external', external: { label: 'Hermes', a2a: true } },
];
const file = parseTeamFile({
  version: 1,
  principal: { name: 'Max' },
  agents: {
    nova: { reports_to: 'principal' },
    ada: { reports_to: 'nova' },
    claw: { reports_to: 'nova', title: 'Lab assistant', involve_for: ['browsing the lab machine'] },
    herm: { reports_to: 'nova' },
  },
}).file!;
const team = resolveTeam(file, onDisk);

test('the org chart marks external agents with their system', () => {
  const block = renderTeamBlock(team, 'ada')!;
  assert.match(block, /claw — Lab assistant \(external · OpenClaw\)/);
  assert.match(block, /herm — Hermes agent \(external · Hermes\)/);
  assert.equal(team.warnings.some((w) => /claw|herm/.test(w) && /skipped/.test(w)), false, 'not dropped as unknown');
});

test('one that takes work: under who to involve with its system and phrases; one shared note on how to hand it work', () => {
  const block = renderTeamBlock(team, 'ada')!;
  const line = block.split('\n').find((l) => l.startsWith('- claw'))!;
  assert.equal(line, '- claw (Lab assistant; external · OpenClaw): browsing the lab machine.');
  const notes = block.split('\n').filter((l) => l.startsWith('External agents ('));
  assert.equal(notes.length, 1, 'said once, not per agent');
  assert.match(notes[0]!, /^External agents \(claw, loose\) work in other systems, with their own memory and tools and no access to ours/);
  assert.match(notes[0]!, /agent_ask or spawn_subagent \(sent over A2A\)/);
});

test('one without A2A access: chat only, never under who to involve', () => {
  const block = renderTeamBlock(team, 'ada')!;
  assert.equal(block.split('\n').some((l) => l.startsWith('- herm')), false);
  assert.match(block, /^Chat only, do not involve: herm \(external agents the principal talks to directly; they take no work from agents\)\.$/m);
  assert.doesNotMatch(block, /External agents \([^)]*herm/);
});

test('unplaced external agents are named under "not in the org chart" and counted in the shared note', () => {
  const block = renderTeamBlock(team, 'ada')!;
  assert.match(block, /Not in the org chart yet: .*loose/);
  assert.match(block, /External agents \(claw, loose\)/);
});

test("the builder's short block names only those that take work", () => {
  const compact = renderTeamBlockCompact(team, 'ada')!;
  assert.match(compact, /claw \(Lab assistant; external · OpenClaw, over A2A/);
  assert.doesNotMatch(compact, /herm/);
});

test('the roster brings external agents in from config.yaml, with their A2A access', async () => {
  const home = process.env.SOMORA_HOME!;
  mkdirSync(join(home, 'agents', 'nova'), { recursive: true });
  writeFileSync(join(home, 'agents', 'nova', 'AGENTS.md'), '---\nrole: COO\n---\n# nova\n');
  writeFileSync(join(home, 'agents', 'nova', 'agent.yaml'), 'model: x\n');
  writeFileSync(join(home, 'team.yaml'), 'version: 1\nprincipal:\n  name: Max\nagents:\n  nova:\n    reports_to: principal\n  claw:\n    reports_to: nova\n');
  setConfig(
    ConfigSchema.parse({
      providers: {},
      external: {
        systems: {
          openclaw: { transport: { local: true }, agents: { claw: { command: 'openclaw acp --session agent:main:x', a2a: { url: 'https://h' } } } },
          hermes: { transport: { local: true }, agents: { herm: { command: 'hermes acp' } } },
        },
      },
    }),
  );
  resetTeamCache();
  const t = (await getResolvedTeam())!;
  assert.deepEqual(t.agents.claw!.external, { label: 'OpenClaw', a2a: true });
  assert.equal(t.agents.claw!.kind, 'external');
  const herm = t.unlisted.find((u) => u.name === 'herm')!;
  assert.deepEqual(herm.external, { label: 'Hermes', a2a: false });
  assert.deepEqual(t.missing, []);
});

test('the Team window preview and the check use the same list as the prompt (external agents included)', async () => {
  const { Hono } = await import('hono');
  const { registerTeamRoutes } = await import('../server/routes/team.ts');
  const app = new Hono();
  registerTeamRoutes(app as never);
  const file = { version: 1, principal: { name: 'Max' }, agents: { nova: { reports_to: 'principal' }, claw: { reports_to: 'nova' } } };
  const r = await app.request('/team/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, agent: 'nova' }) });
  const body = (await r.json()) as { block: string; warnings: string[] };
  assert.match(body.block, /claw — .*\(external · OpenClaw\)/);
  assert.equal(body.warnings.some((w) => /claw/.test(w)), false, 'not reported as unknown');
  const check = (await (await app.request('/team/check')).json()) as { blocks: Array<{ agent: string }> };
  assert.equal(check.blocks.some((b) => b.agent === 'claw'), false, 'an external agent has no block to measure');
});
