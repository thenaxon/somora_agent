// Renaming an agent (docs/agents.md#renaming-an-agent):
//   - a somora agent: folder with sessions and memory, AGENTS.md name, the
//     memory index paths, dream files, browser profile and state, Sentinel
//     triggers, tmux records, team.yaml (key and reports_to, comments kept),
//     config.yaml fields (a2a, browser profiles, voices; comments kept);
//   - an external agent: its config.yaml entry renamed in place, its
//     sessions folder, team.yaml;
//   - a dry run changes nothing and says what would change;
//   - refused: unknown agent, invalid or taken name, a busy agent;
//   - texts that still say the old name are reported, not rewritten;
//   - the route answers with the report.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { loadConfig } from '../config/loader.ts';
import { setConfig } from '../server/server-state.ts';
import { acquireSessionLock } from '../server/session-queue.ts';
import { listTriggers, loadTriggers, saveTrigger } from '../sentinel/store.ts';
import { renameAgent } from './rename.ts';
import { registerAgentRoutes } from '../server/routes/agents.ts';

const home = process.env.SOMORA_HOME!;
const agents = join(home, 'agents');

function agent(name: string, extra = '') {
  mkdirSync(join(agents, name, 'sessions'), { recursive: true });
  writeFileSync(join(agents, name, 'AGENTS.md'), `---\nname: ${name}\ndescription: ${name} the tester\n---\n# ${name}\n${extra}`);
  writeFileSync(join(agents, name, 'agent.yaml'), 'model: x\na2a: true\n');
  writeFileSync(join(agents, name, 'sessions', 'main.jsonl'), JSON.stringify({ kind: 'user_message', ts: 1, engine: 'x', text: 'hello' }) + '\n');
}

agent('ada');
agent('bea', 'Ask ada for research.\n');
agent('cleo');
mkdirSync(join(agents, 'claw', 'sessions'), { recursive: true });
writeFileSync(join(agents, 'claw', 'sessions', 'main.jsonl'), JSON.stringify({ kind: 'user_message', ts: 1, engine: 'acp', text: 'hi' }) + '\n');

// ada's memory index, with absolute paths under her folder.
mkdirSync(join(agents, 'ada', 'memory', '.dreams'), { recursive: true });
const dbPath = join(agents, 'ada', 'memory.db');
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE files (path TEXT PRIMARY KEY, source TEXT, hash TEXT, mtime INTEGER, size INTEGER);
           CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_path TEXT, source TEXT, slug TEXT, text TEXT, FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE);`);
  const p = join(agents, 'ada', 'memory', 'note.md');
  db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?)').run(p, 'memory', 'h', 1, 1);
  db.prepare('INSERT INTO chunks (file_path, source, slug, text) VALUES (?, ?, ?, ?)').run(p, 'memory', 'note', 'x');
  db.close();
}
writeFileSync(join(agents, 'ada', 'memory', '.dreams', 'd1.json'), JSON.stringify({ id: 'd1', agent: 'ada' }));
mkdirSync(join(home, 'browser', 'profiles', 'ada'), { recursive: true });
writeFileSync(join(home, 'browser', 'state.json'), JSON.stringify({ browsers: { 'agent:ada': { profile: 'ada', views: { 'agent:ada@ada': { control: { handoff: { agent: 'ada' } } } } } } }));
writeFileSync(join(home, 'tmux-origins.json'), JSON.stringify({ build: { name: 'build', agent: 'ada' }, other: { name: 'other', agent: 'bea' } }));

writeFileSync(
  join(home, 'team.yaml'),
  '# my team, hand-written\nversion: 1\nprincipal:\n  name: Max\nrules:\n  - Only Max may involve ada directly.\nagents:\n  ada: # the researcher\n    reports_to: principal\n  bea:\n    reports_to: ada\n  claw:\n    reports_to: ada\n',
);
writeFileSync(
  join(home, 'config.yaml'),
  `providers: {}
# A2A for the lab
a2a:
  defaultAgent: ada
  peers:
    lab:
      token: 0123456789abcdef0123
      agents: [ada, bea]   # who the lab may reach
tts:
  provider: openai
  model: tts-1
  agentVoices:
    ada: nova
external:
  systems:
    oc:
      transport: { local: true }
      agents:
        # the OpenClaw lab agent
        claw:
          command: "false"
`,
);
setConfig(await loadConfig());
await loadTriggers();
await saveTrigger({ id: 'trg-1', name: 'morning', ownerAgent: 'ada', source: {}, evaluator: {}, dispatch: { agent: 'ada', session: 'main' }, createdAt: '2026-10-16T00:00:00Z', status: 'active' } as never);

const run = async (from: string, to: string, dryRun = false) => {
  setConfig(await loadConfig());
  const { config } = await import('../server/server-state.ts');
  return renameAgent(from, to, { config }, { dryRun });
};

test('a dry run changes nothing and lists what would change', async () => {
  const r = await run('ada', 'nova', true);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.kind, 'somora');
  assert.ok(r.changes.some((c) => c.startsWith('folder agents/ada → agents/nova')));
  assert.ok(r.changes.some((c) => c.startsWith('Sentinel: 1 trigger')));
  assert.ok(r.changes.some((c) => c === 'team.yaml: agents.ada → nova'));
  assert.ok(r.changes.some((c) => c === 'config.yaml: a2a.peers.lab.agents'));
  assert.ok(r.warnings.some((w) => /bea\/AGENTS\.md still says 'ada'/.test(w)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => /a2a\/agents\/nova/.test(w)), 'a2a address change is named');
  assert.equal(existsSync(join(agents, 'ada')), true, 'nothing moved');
});

test('refused: unknown agent, invalid or taken name, a busy agent', async () => {
  assert.match((await run('nobody', 'x')).error ?? '', /no agent 'nobody'/);
  assert.match((await run('ada', 'Bad Name')).error ?? '', /not a valid agent name/);
  assert.match((await run('ada', 'bea')).error ?? '', /already exists/);
  assert.match((await run('ada', 'claw')).error ?? '', /already exists/);
  const release = await acquireSessionLock('ada', 'main', { priority: 'user' });
  try {
    assert.match((await run('ada', 'nova')).error ?? '', /'ada' is busy: a turn is running/);
  } finally {
    release();
  }
});

test('a somora agent: everything that names it moves to the new name', async () => {
  const r = await run('ada', 'nova');
  assert.equal(r.ok, true, r.error);
  assert.equal(existsSync(join(agents, 'ada')), false);
  assert.equal(existsSync(join(agents, 'nova', 'sessions', 'main.jsonl')), true, 'sessions came along');
  assert.match(readFileSync(join(agents, 'nova', 'AGENTS.md'), 'utf8'), /^name: nova$/m);
  const db = new Database(join(agents, 'nova', 'memory.db'));
  assert.equal((db.prepare('SELECT path FROM files').get() as { path: string }).path, join(agents, 'nova', 'memory', 'note.md'));
  assert.equal((db.prepare('SELECT file_path FROM chunks').get() as { file_path: string }).file_path, join(agents, 'nova', 'memory', 'note.md'));
  db.close();
  assert.equal(JSON.parse(readFileSync(join(agents, 'nova', 'memory', '.dreams', 'd1.json'), 'utf8')).agent, 'nova');
  assert.equal(existsSync(join(home, 'browser', 'profiles', 'nova')), true);
  const state = JSON.parse(readFileSync(join(home, 'browser', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.browsers), ['agent:nova']);
  assert.equal(state.browsers['agent:nova'].profile, 'nova');
  assert.equal(state.browsers['agent:nova'].views['agent:nova@nova'].control.handoff.agent, 'nova');
  const tmux = JSON.parse(readFileSync(join(home, 'tmux-origins.json'), 'utf8'));
  assert.equal(tmux.build.agent, 'nova');
  assert.equal(tmux.other.agent, 'bea');
  await loadTriggers();
  const t = listTriggers().find((x) => x.id === 'trg-1')!;
  assert.equal(t.dispatch.agent, 'nova');
  assert.equal((t as { ownerAgent?: string }).ownerAgent, 'nova');
  const team = readFileSync(join(home, 'team.yaml'), 'utf8');
  assert.match(team, /^# my team, hand-written$/m, 'comments kept');
  assert.match(team, /^ {2}nova:(?: # the researcher|\n {4}# the researcher)$/m, 'the key renamed in place, its comment kept');
  assert.match(team, /^ {2}bea:\n {4}reports_to: nova$/m);
  assert.match(team, /^ {2}claw:\n {4}reports_to: nova$/m);
  assert.match(team, /Only Max may involve ada directly/, 'rule text left as written');
  assert.ok(r.warnings.some((w) => /team\.yaml still says 'ada' in its text/.test(w)));
  const cfg = readFileSync(join(home, 'config.yaml'), 'utf8');
  assert.match(cfg, /defaultAgent: nova/);
  assert.match(cfg, /agents: \[ nova, bea \]|agents: \[nova, bea\]/);
  assert.match(cfg, /# who the lab may reach/, 'comments kept');
  assert.match(cfg, /^ {4}nova: nova$/m, 'the voice key');
});

test('an external agent: its config entry in place, its sessions, the team', async () => {
  const r = await run('claw', 'lobo');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.kind, 'external');
  const cfg = readFileSync(join(home, 'config.yaml'), 'utf8');
  assert.match(cfg, / {8}# the OpenClaw lab agent\n {8}lobo:\n {10}command: "false"/);
  assert.equal(existsSync(join(agents, 'lobo', 'sessions', 'main.jsonl')), true);
  assert.equal(existsSync(join(agents, 'claw')), false);
  assert.match(readFileSync(join(home, 'team.yaml'), 'utf8'), /^ {2}lobo:\n {4}reports_to: nova$/m);
});

test('the route answers with the report; 409 when the name is taken', async () => {
  const app = new Hono();
  registerAgentRoutes(app, { nextTurnPrompt: undefined as never, syncDreamers: async () => {} });
  const dry = await app.request('/agents/cleo/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'dora', dryRun: true }) });
  assert.equal(dry.status, 200);
  assert.equal(((await dry.json()) as { dryRun: boolean }).dryRun, true);
  const taken = await app.request('/agents/cleo/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'bea' }) });
  assert.equal(taken.status, 409);
  const unknown = await app.request('/agents/nobody/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'x' }) });
  assert.equal(unknown.status, 404);
});
