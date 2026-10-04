// `somora team show <agent>` prints what that agent really gets in its
// prompt: a builder the compact block, and a builder colleague marked
// as one in everybody else's block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = join(tmpdir(), `somora-team-cli-${process.pid}`);
for (const [name, yaml] of [['ada', 'model: m\n'], ['dan', 'model: m\nkind: builder\n']] as const) {
  mkdirSync(join(home, 'agents', name), { recursive: true });
  writeFileSync(join(home, 'agents', name, 'AGENTS.md'), `# ${name}\nA test agent.\n`);
  writeFileSync(join(home, 'agents', name, 'agent.yaml'), yaml);
}
process.env.SOMORA_HOME = home;
const { runTeamCli } = await import('./team.ts');
const { listAgents } = await import('../persona/loader.ts');
const { loadTeamFile } = await import('../team/store.ts');
const { resolveTeam } = await import('../team/resolve.ts');
const { renderTeamBlock, renderTeamBlockCompact } = await import('../team/render.ts');

async function capture(args: string[]): Promise<{ code: number; out: string }> {
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as { write: unknown }).write = (chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  };
  try {
    return { code: await runTeamCli(args), out };
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }
}

test('team show prints the block the agent gets — compact for a builder', async () => {
  assert.equal((await capture(['init', '--principal', 'Karl'])).code, 0);
  const agents = await listAgents();
  assert.equal(agents.find((a) => a.name === 'dan')?.kind, 'builder');
  const load = await loadTeamFile();
  const team = resolveTeam(load.file!, agents.map((a) => ({ name: a.name, role: a.role, description: a.description, kind: a.kind })));
  const full = renderTeamBlock(team, 'dan')!;
  const compact = renderTeamBlockCompact(team, 'dan')!;
  assert.notEqual(full, compact);

  const dan = await capture(['show', 'dan']);
  assert.equal(dan.code, 0);
  assert.equal(dan.out.trimEnd(), compact.trimEnd());

  const ada = await capture(['show', 'ada']);
  assert.equal(ada.out.trimEnd(), renderTeamBlock(team, 'ada')!.trimEnd());
  // ada's line about dan carries the builder sentence — it was missing
  // while the roster reached the renderer without the agents' kind.
  const withoutKind = resolveTeam(load.file!, agents.map((a) => ({ name: a.name, role: a.role, description: a.description })));
  assert.notEqual(ada.out.trimEnd(), renderTeamBlock(withoutKind, 'ada')!.trimEnd());
});
