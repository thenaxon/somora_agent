// Builder prompt pieces: env block, repo instructions, identity line.
// Run: npm test src/server/builder-prompt.test.mts
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILDER_HARNESS_PROMPT,
  BUILDER_LOOP_DEFAULTS,
  isGitRepo,
  readRepoInstructions,
  renderBuilderEnvBlock,
  renderBuilderIdentity,
  renderRepoInstructionsBlock,
} from './builder-prompt.ts';

const dir = await mkdtemp(join(tmpdir(), 'somora-builder-'));
try {
  assert.equal(await isGitRepo(dir), false);
  assert.equal(await readRepoInstructions(dir), null);
  await mkdir(join(dir, '.git'));
  assert.equal(await isGitRepo(dir), true);
  // CLAUDE.md is read when there is no AGENTS.md, AGENTS.md wins when both exist
  await writeFile(join(dir, 'CLAUDE.md'), 'claude rules');
  assert.equal((await readRepoInstructions(dir))?.text, 'claude rules');
  await writeFile(join(dir, 'AGENTS.md'), 'agents rules');
  const r = await readRepoInstructions(dir);
  assert.equal(r?.text, 'agents rules');
  assert.ok(r?.file.endsWith('/AGENTS.md'));
  assert.match(renderRepoInstructionsBlock(r!), /^# Instructions from .*AGENTS\.md\n\nagents rules$/);
  // a huge file is cut with a marker
  await writeFile(join(dir, 'AGENTS.md'), 'x'.repeat(30_000));
  const big = await readRepoInstructions(dir);
  assert.ok(big!.text.length < 20_200);
  assert.match(big!.text, /cut at 20000 chars/);
} finally {
  await rm(dir, { recursive: true, force: true });
}

const env = renderBuilderEnvBlock({ workdir: '/repo', isGitRepo: true, platform: 'linux x64', modelRef: 'deepseek', today: '2026-09-23' });
assert.match(env, /Working directory: \/repo/);
assert.match(env, /Git repository: yes/);
assert.match(env, /Today: 2026-09-23/);

assert.equal(
  renderBuilderIdentity({ name: 'rudi', description: 'Builds things.' } as never),
  'You are `rudi`: Builds things.',
);
assert.equal(renderBuilderIdentity({ name: 'rudi', description: '' } as never), 'You are `rudi`.');

// the harness text carries the sentences weak models need
for (const must of [
  'Code or a file that only appears in your text is NOT saved',
  'WITHOUT the `N: ` line-number prefix',
  'Verify after every change',
  'Do not repeat the same tool call with the same arguments',
  'todo_write',
  'ask_user',
  'never commit',
]) {
  assert.ok(BUILDER_HARNESS_PROMPT.toLowerCase().includes(must.toLowerCase()), `missing: ${must}`);
}
assert.equal(BUILDER_LOOP_DEFAULTS.maxRounds, 500);
assert.equal(BUILDER_LOOP_DEFAULTS.maxTurnMs, 8 * 60 * 60 * 1000);
console.log('builder-prompt.test: ok');

// The report rule: the answer is the report, no message back to the orderer.
{
  const { BUILDER_HARNESS_PROMPT } = await import('./builder-prompt.ts');
  assert.match(BUILDER_HARNESS_PROMPT, /Your final answer IS the report/);
  assert.match(BUILDER_HARNESS_PROMPT, /Never send it with agent_ask/);
}

// The orderer survives the meta round trip and is absent for a person's session.
{
  const { readBuilderState } = await import('./builder-session.ts');
  const st = readBuilderState({ builderMode: 'unattended', builderPhase: 'plan', builderOrderer: { agent: 'naxon', session: 's1' } })!;
  assert.deepEqual(st.orderer, { agent: 'naxon', session: 's1' });
  assert.equal(readBuilderState({ builderMode: 'attended', builderPhase: 'plan' })!.orderer, undefined);
  assert.equal(readBuilderState({ builderMode: 'attended', builderPhase: 'plan', builderOrderer: { agent: '' } })!.orderer, undefined);
}

// Helpers: wait, do not poll or message them mid-work.
{
  const { BUILDER_HARNESS_PROMPT } = await import('./builder-prompt.ts');
  assert.match(BUILDER_HARNESS_PROMPT, /Never message a running helper/);
  assert.match(BUILDER_HARNESS_PROMPT, /subagent_result with wait:true/);
}
