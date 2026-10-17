// Renaming an agent, the ways it could go wrong (docs/agents.md#renaming-an-agent):
//   - nothing starts for either name while the rename runs (turns, session
//     writes, the A2A switch), and two renames run one after the other;
//   - a step that fails late puts back every earlier one, byte for byte;
//   - a browser profile under the new name stops it before anything moves;
//   - Chromium's lock (a symlink) counts as a running browser, a lock left
//     by a dead process does not; a running browser of the service does;
//   - an entry reached through a YAML anchor or merge key is refused;
//   - names YAML would read as a number or a boolean are refused;
//   - only the frontmatter's `name` changes in AGENTS.md;
//   - the A2A switch edits `a2a` however it is written, never breaks the file.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config/loader.ts';
import { parseYaml } from '../config/yaml.ts';
import { setConfig } from '../server/server-state.ts';
import { acquireSessionLock } from '../server/session-queue.ts';
import { appendEvent } from '../storage/sessions.ts';
import { loadTriggers, saveTrigger } from '../sentinel/store.ts';
import { renameAgent, renameInFrontmatter, type RenameDeps } from './rename.ts';
import { setA2AInText, writeAgentA2A } from './a2a-store.ts';

const home = process.env.SOMORA_HOME!;
const agents = join(home, 'agents');

function agent(name: string, md?: string) {
  mkdirSync(join(agents, name, 'sessions'), { recursive: true });
  writeFileSync(join(agents, name, 'AGENTS.md'), md ?? `---\nname: ${name}\ndescription: ${name} the tester\n---\n# ${name}\n`);
  writeFileSync(join(agents, name, 'agent.yaml'), 'model: x\n');
  writeFileSync(join(agents, name, 'sessions', 'main.jsonl'), JSON.stringify({ kind: 'user_message', ts: 1, engine: 'x', text: 'hello' }) + '\n');
}

const run = async (from: string, to: string, extra: Partial<RenameDeps> = {}, dryRun = false) => {
  setConfig(await loadConfig());
  const { config } = await import('../server/server-state.ts');
  return renameAgent(from, to, { config, ...extra }, { dryRun });
};

/** Every file under the home with its bytes' hash (logs left out). */
function tree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const rel = relative(home, p);
      if (rel === 'logs') continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = 'link';
      else if (st.isDirectory()) walk(p);
      else out[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(home);
  return out;
}

agent('ada');
agent('bea');
agent('cleo');
agent('dora');
agent('gus');
agent('hal');
agent('ivy', '---\ndescription: no name here\n---\n# Ivy\nAn example service file:\n```yaml\nname: service\n```\n');
agent('jon', '# Jon, no frontmatter\nUse this:\n---\nname: service\n');
agent('kim', '---\nname: kim   # the tester\ndescription: k\n---\n# Kim\n');
writeFileSync(
  join(home, 'team.yaml'),
  'version: 1\nprincipal:\n  name: Max\nagents:\n  ada:\n    reports_to: principal\n  bea:\n    reports_to: ada\n  cleo:\n    reports_to: principal\n  dora:\n    reports_to: principal\n',
);
writeFileSync(join(home, 'config.yaml'), 'providers: {}\ntts:\n  provider: openai\n  model: tts-1\n  agentVoices:\n    dora: nova\n');
setConfig(await loadConfig());
await loadTriggers();

test('while a rename runs, nothing starts for either name; renames run one at a time', async () => {
  const seen: string[] = [];
  const probe = async () => {
    for (const name of ['ada', 'nova']) {
      await acquireSessionLock(name, 'main', { priority: 'user' }).then(
        (release) => {
          release();
          seen.push(`${name}: lock taken`);
        },
        (err: Error) => seen.push(`${name}: ${err.message}`),
      );
      await appendEvent(name, 'main', { kind: 'user_message', ts: 2, engine: 'x', text: 'late' } as never).then(
        () => seen.push(`${name}: written`),
        (err: Error) => seen.push(`${name}: ${err.message}`),
      );
    }
    await writeAgentA2A('ada', true).then(
      () => seen.push('switch written'),
      (err: Error) => seen.push(`switch: ${err.message}`),
    );
  };
  // Two renames at once, both editing team.yaml: the second must start
  // from the first one's result, not from the same old text.
  const [a, c] = await Promise.all([run('ada', 'nova', { syncDreamers: probe }), run('cleo', 'cora')]);
  assert.equal(a.ok, true, a.error);
  assert.equal(c.ok, true, c.error);
  assert.deepEqual(seen, [
    "ada: agent 'ada' is being renamed — try again in a moment",
    "ada: agent 'ada' is being renamed — try again in a moment",
    "nova: agent 'nova' is being renamed — try again in a moment",
    "nova: agent 'nova' is being renamed — try again in a moment",
    "switch: agent 'ada' is being renamed — try again in a moment",
  ]);
  assert.equal(existsSync(join(agents, 'ada')), false, 'no write made the old folder again');
  const team = parseYaml(readFileSync(join(home, 'team.yaml'), 'utf8')) as { agents: Record<string, { reports_to: string }> };
  assert.deepEqual(Object.keys(team.agents).sort(), ['bea', 'cora', 'dora', 'nova']);
  assert.equal(team.agents.bea!.reports_to, 'nova');
  // Afterwards the new name works.
  (await acquireSessionLock('nova', 'main', { priority: 'user' }))();
});

test('a step that fails late puts every earlier one back, byte for byte', async () => {
  const dir = join(agents, 'dora');
  mkdirSync(join(dir, 'memory', '.dreams'), { recursive: true });
  {
    const db = new Database(join(dir, 'memory.db'));
    db.exec('CREATE TABLE files (path TEXT PRIMARY KEY); CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_path TEXT);');
    db.prepare('INSERT INTO files VALUES (?)').run(join(dir, 'memory', 'n.md'));
    db.prepare('INSERT INTO chunks (file_path) VALUES (?)').run(join(dir, 'memory', 'n.md'));
    db.close();
  }
  writeFileSync(join(dir, 'memory', '.dreams', 'd.json'), '{"agent":"dora"}');
  mkdirSync(join(home, 'browser', 'profiles', 'dora'), { recursive: true });
  writeFileSync(join(home, 'browser', 'profiles', 'dora', 'Cookies'), 'c');
  writeFileSync(join(home, 'browser', 'state.json'), JSON.stringify({ browsers: { 'agent:dora': { profile: 'dora' } } }));
  writeFileSync(join(home, 'tmux-origins.json'), JSON.stringify({ build: { name: 'build', agent: 'dora' } }));
  await saveTrigger({ id: 'trg-d', name: 'daily', ownerAgent: 'dora', source: {}, evaluator: {}, dispatch: { agent: 'dora', session: 'main' }, createdAt: '2026-10-17T00:00:00Z', status: 'active' } as never);
  // config.yaml is written last; its temporary file cannot be made.
  mkdirSync(join(home, 'config.yaml.tmp-rename'));
  const before = tree();
  try {
    const r = await run('dora', 'eve');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /^rename stopped: .*nothing changed, everything is back under 'dora'/);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(tree(), before);
  } finally {
    rmSync(join(home, 'config.yaml.tmp-rename'), { recursive: true });
  }
  // And it works once the obstacle is gone.
  const ok = await run('dora', 'eve');
  assert.equal(ok.ok, true, ok.error);
  assert.match(readFileSync(join(home, 'config.yaml'), 'utf8'), /^ {4}eve: nova$/m);
});

test('a browser profile under the new name stops the rename before anything moves', async () => {
  mkdirSync(join(home, 'browser', 'profiles', 'gus'), { recursive: true });
  mkdirSync(join(home, 'browser', 'profiles', 'gil', 'Default'), { recursive: true });
  const before = tree();
  const r = await run('gus', 'gil');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /a browser profile named 'gil' already exists/);
  assert.deepEqual(tree(), before);
});

test("Chromium's lock symlink counts as a running browser; a dead process's does not", async () => {
  const profile = join(home, 'browser', 'profiles', 'hal');
  mkdirSync(profile, { recursive: true });
  symlinkSync(`${hostname()}-${process.pid}`, join(profile, 'SingletonLock'));
  assert.match((await run('hal', 'hank', {}, true)).error ?? '', /'hal' is busy: its browser is running/);
  rmSync(join(profile, 'SingletonLock'));
  symlinkSync(`${hostname()}-2147483646`, join(profile, 'SingletonLock'));
  assert.equal((await run('hal', 'hank', {}, true)).ok, true, 'a leftover of a crash');
  rmSync(join(profile, 'SingletonLock'));
  // The browser service knows a starting browser before any lock exists.
  const { configureBrowserService } = await import('../browser/service.ts');
  const { config } = await import('../server/server-state.ts');
  const svc = configureBrowserService(config.browser);
  (svc as unknown as { launching: Map<string, Promise<unknown>> }).launching.set('agent:hal', new Promise(() => {}));
  assert.match((await run('hal', 'hank', {}, true)).error ?? '', /its browser is running/);
  (svc as unknown as { launching: Map<string, Promise<unknown>> }).launching.clear();
});

test('an entry reached through a YAML anchor or merge key is refused, nothing moved', async () => {
  const cfg = readFileSync(join(home, 'config.yaml'), 'utf8');
  mkdirSync(join(agents, 'claw', 'sessions'), { recursive: true });
  writeFileSync(join(agents, 'claw', 'sessions', 'main.jsonl'), '{}\n');
  writeFileSync(
    join(home, 'config.yaml'),
    `${cfg}x-entries: &entries\n  claw:\n    command: "false"\nexternal:\n  systems:\n    oc:\n      transport: { local: true }\n      agents:\n        <<: *entries\n`,
  );
  try {
    const before = tree();
    const r = await run('claw', 'lobo');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /config\.yaml would still name 'claw' at external\.systems\.oc\.agents\.claw: .*merge key/);
    assert.deepEqual(tree(), before);
    // The same for a list shared through an alias.
    writeFileSync(join(home, 'config.yaml'), `${cfg}x-who: &who [kim, bea]\na2a:\n  peers:\n    lab:\n      token: 0123456789abcdef0123\n      agents: *who\n`);
    const r2 = await run('kim', 'kit', {}, true);
    assert.match(r2.error ?? '', /would still name 'kim' at a2a\.peers\.lab\.agents/);
  } finally {
    writeFileSync(join(home, 'config.yaml'), cfg);
    rmSync(join(agents, 'claw'), { recursive: true });
  }
});

test('names YAML would read as a number or a boolean are refused', async () => {
  for (const name of ['123', 'true', 'false', '1e3', '0x1f', 'null']) {
    const r = await run('bea', name, {}, true);
    assert.equal(r.ok, false, name);
    assert.match(r.error ?? '', /is not a valid agent name/, name);
  }
});

test('only the frontmatter name changes in AGENTS.md', async () => {
  const ivy = readFileSync(join(agents, 'ivy', 'AGENTS.md'), 'utf8');
  assert.equal((await run('ivy', 'iris')).ok, true);
  assert.equal(readFileSync(join(agents, 'iris', 'AGENTS.md'), 'utf8'), ivy, 'no frontmatter name: nothing to change');
  const jon = readFileSync(join(agents, 'jon', 'AGENTS.md'), 'utf8');
  assert.equal((await run('jon', 'joe')).ok, true);
  assert.equal(readFileSync(join(agents, 'joe', 'AGENTS.md'), 'utf8'), jon, 'a --- further down is no frontmatter');
  assert.equal((await run('kim', 'kai')).ok, true);
  assert.equal(readFileSync(join(agents, 'kai', 'AGENTS.md'), 'utf8'), '---\nname: kai   # the tester\ndescription: k\n---\n# Kim\n', 'the comment stays, the body too');
  // The second guard behind the name rule: a value that would read as a
  // number is quoted.
  assert.equal(renameInFrontmatter('---\nname: x\n---\nb\n', '123'), "---\nname: '123'\n---\nb\n");
});

test('the A2A switch: the root a2a however written; a broken result is never written', async () => {
  for (const [text, want] of [
    ['"a2a": false\nmodel: x\n', '"a2a": true\nmodel: x\n'],
    ["'a2a': false\n", "'a2a': true\n"],
    ['a2a : false\n', 'a2a : true\n'],
    ['model: x\na2a: false   # off for now\n', 'model: x\na2a: true   # off for now\n'],
    ['model: x', 'model: x\na2a: true\n'],
    ['# only a comment\n', '# only a comment\na2a: true\n'],
    ['', 'a2a: true\n'],
    ['tools:\n  a2a: false\n', 'tools:\n  a2a: false\na2a: true\n'],
  ] as const) {
    const out = setA2AInText(text, true);
    assert.equal(out, want, JSON.stringify(text));
    assert.equal((parseYaml(out) as { a2a: boolean }).a2a, true);
  }
  assert.throws(() => setA2AInText('model: [x\n', true), /not valid YAML/);
  assert.throws(() => setA2AInText('a2a: false\na2a: true\n', true), /not valid YAML/);
  // The route's write: a file that is not YAML stays as it is.
  writeFileSync(join(agents, 'bea', 'agent.yaml'), 'model: [x\n');
  await assert.rejects(writeAgentA2A('bea', true), /not valid YAML/);
  assert.equal(readFileSync(join(agents, 'bea', 'agent.yaml'), 'utf8'), 'model: [x\n');
});
