// The facts under a builder's report (builder-facts.ts): what git says
// about the working copy and its worktrees, commands that timed out,
// background jobs still running — from somora's records, not the
// builder's text.
//
// Run: npm test src/server/builder-facts.test.mts
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FACTS_HEADING, collectBuilderFacts, gitFacts } from './builder-facts.ts';
import { recordExecTimeout } from '../tools/exec/timeout-repeats.ts';
import { ensureJobDir, writeMeta } from '../tools/exec/job-store.ts';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'somora-facts-'));
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid');
  g('config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return dir;
}

test('a clean repository: one line saying so, or nothing for a turn that only answered', async () => {
  const dir = repo();
  const block = await collectBuilderFacts({ agent: 'factsa', session: 's', workdir: dir, since: 0 });
  assert.ok(block?.startsWith(FACTS_HEADING));
  assert.match(block!, /Everything in `.*` is committed\./);
  assert.equal(await collectBuilderFacts({ agent: 'factsa', session: 's', workdir: dir, since: 0, quietWhenClean: true }), null);
});

test('not committed and not tracked, in the working copy and a worktree beside it; worktree commits not in main', async () => {
  const dir = repo();
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  writeFileSync(join(dir, 'LEDGER.md'), 'x\n');
  const wt = `${dir}-wt`;
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'feature', wt], { stdio: 'pipe' });
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  execFileSync('git', ['-C', wt, 'add', 'b.txt'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wt, 'commit', '-qm', 'b'], { stdio: 'pipe' });
  writeFileSync(join(wt, 'page.tsx'), 'ui\n');
  const block = (await collectBuilderFacts({ agent: 'factsb', session: 's', workdir: dir, since: 0, quietWhenClean: true }))!;
  assert.match(block, /Working copy `[^`]+` \(branch `main`\): 1 changed, not committed: `a.txt`; 1 not tracked by git: `LEDGER.md`\./);
  assert.match(block, /Worktree `[^`]+-wt` \(branch `feature`\): 1 not tracked by git: `page.tsx`; 1 commit\(s\) not in the main checkout\./);
});

test('a worktree inside the project is not reported as an untracked folder of the main checkout', async () => {
  const dir = repo();
  mkdirSync(join(dir, '.worktrees'));
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', 'inner', join(dir, '.worktrees', 'inner')], { stdio: 'pipe' });
  const facts = (await gitFacts(dir))!;
  const main = facts.worktrees.find((f) => f.main)!;
  assert.deepEqual(main.untracked, []);
  assert.equal(facts.worktrees.length, 2);
});

test('outside a repository: no git lines; timeouts of this turn still listed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somora-facts-plain-'));
  assert.equal(await gitFacts(dir), null);
  assert.equal(await collectBuilderFacts({ agent: 'factsc', session: 's1', workdir: dir, since: 0 }), null);
  const since = Date.now();
  await recordExecTimeout({ agent: 'factsc', session: 's1', cwd: dir, command: 'pytest -q', ms: 600_000 });
  await recordExecTimeout({ agent: 'factsc', session: 's1', cwd: dir, command: 'pytest -q', ms: 600_000 });
  await recordExecTimeout({ agent: 'factsc', session: 'other', cwd: dir, command: 'make', ms: 1000 });
  const block = (await collectBuilderFacts({ agent: 'factsc', session: 's1', workdir: dir, since }))!;
  assert.match(block, /Timed out 2× in this session \(1200s in all\): `pytest -q`\./);
  assert.doesNotMatch(block, /make/, 'another session is not this order');
});

test('the repository config cannot make the server run a command (core.fsmonitor)', async () => {
  const dir = repo();
  const marker = join(dir, '..', `fsmonitor-ran-${Date.now()}`);
  execFileSync('git', ['-C', dir, 'config', 'core.fsmonitor', `touch ${marker}; true`], { stdio: 'pipe' });
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  const block = (await collectBuilderFacts({ agent: 'factsd', session: 's', workdir: dir, since: 0 }))!;
  assert.match(block, /1 changed, not committed: `a.txt`/);
  assert.equal(existsSync(marker), false, 'fsmonitor hook did not run');
});

test('a worktree git cannot read is "state unknown", never "everything is committed"', async () => {
  const dir = repo();
  writeFileSync(join(dir, '.git', 'index'), 'not an index');
  const block = (await collectBuilderFacts({ agent: 'factse', session: 's', workdir: dir, since: 0 }))!;
  assert.match(block, /git status did not answer — state unknown/);
  assert.doesNotMatch(block, /is committed/);
});

test('a stopped order ends the git calls', async () => {
  const dir = repo();
  const ac = new AbortController();
  ac.abort();
  assert.equal(await collectBuilderFacts({ agent: 'factsf', session: 's', workdir: dir, since: 0, signal: ac.signal }), null);
});

test('a clean filter from .gitattributes does not run, and the change is still reported', async () => {
  const dir = repo();
  const marker = join(dir, '..', `filter-ran-${Date.now()}`);
  writeFileSync(join(dir, '.gitattributes'), '*.txt filter=evil\n');
  execFileSync('git', ['-C', dir, 'config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'add', '.gitattributes'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'attrs'], { stdio: 'pipe' });
  rmSync(marker, { force: true });
  writeFileSync(join(dir, 'a.txt'), 'two\n'); // same length as "one\n"
  const block = (await collectBuilderFacts({ agent: 'factsg', session: 's', workdir: dir, since: 0 }))!;
  assert.match(block, /`a.txt`/);
  assert.equal(existsSync(marker), false, 'the filter did not run');
});

test('more worktrees than the limit: the rest is named as not looked at, never "all committed"', async () => {
  const dir = repo();
  for (let i = 0; i < 8; i++) execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '-b', `w${i}`, `${dir}-w${i}`], { stdio: 'pipe' });
  const block = (await collectBuilderFacts({ agent: 'factsh', session: 's', workdir: `${dir}-w7`, since: 0 }))!;
  assert.match(block, /3 more worktree\(s\) not looked at/);
  assert.doesNotMatch(block, /is committed/);
  const facts = (await gitFacts(`${dir}-w7`))!;
  assert.ok(facts.worktrees.some((w) => w.path.endsWith('-w7')), 'the folder\'s own checkout is always looked at');
});

test('a background job still running is listed only for the session that started it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'somora-facts-jobs-'));
  const since = Date.now() - 1000;
  const job = (id: string, session: string) => ({ job_id: id, agent: 'factsj', session, target: 'local', command: `serve ${session}`, started_at: Date.now(), state: 'running' as const, pid: process.pid });
  await ensureJobDir('factsj', 'job_1_mine');
  await writeMeta('factsj', job('job_1_mine', 'mine'));
  await ensureJobDir('factsj', 'job_2_other');
  await writeMeta('factsj', job('job_2_other', 'other'));
  const block = (await collectBuilderFacts({ agent: 'factsj', session: 'mine', workdir: dir, since }))!;
  assert.match(block, /Still running in the background: `serve mine`/);
  assert.doesNotMatch(block, /serve other/);
});

test('a filter configured inside a submodule does not run', async () => {
  const sub = repo();
  const dir = repo();
  execFileSync('git', ['-C', dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'lib'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'sub'], { stdio: 'pipe' });
  const inner = join(dir, 'lib');
  const marker = join(dir, '..', `subfilter-ran-${Date.now()}`);
  writeFileSync(join(inner, '.gitattributes'), '*.txt filter=evil\n');
  execFileSync('git', ['-C', inner, 'config', 'filter.evil.clean', `sh -c 'touch ${marker}; cat'`], { stdio: 'pipe' });
  writeFileSync(join(inner, 'a.txt'), 'two\n');
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  const block = (await collectBuilderFacts({ agent: 'factsk', session: 's', workdir: dir, since: 0 }))!;
  assert.match(block, /`a.txt`/);
  assert.equal(existsSync(marker), false, 'the submodule filter did not run');
});

test('a detached worktree with its own commit is named as not in the main checkout', async () => {
  const dir = repo();
  const wt = `${dir}-det`;
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '--detach', wt], { stdio: 'pipe' });
  writeFileSync(join(wt, 'n.txt'), 'n\n');
  execFileSync('git', ['-C', wt, 'add', 'n.txt'], { stdio: 'pipe' });
  execFileSync('git', ['-C', wt, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'n'], { stdio: 'pipe' });
  const block = (await collectBuilderFacts({ agent: 'factsl', session: 's', workdir: dir, since: 0 }))!;
  assert.match(block, /Worktree `[^`]+-det`: 1 commit\(s\) not in the main checkout/);
  assert.doesNotMatch(block, /is committed/);
});
