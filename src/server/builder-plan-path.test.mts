// The plan follows the pin; an older plan is archived by name. Run: npm test src/server/builder-plan-path.test.mts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionMetaStore } from '../storage/sessions.ts';
import { archiveNameFor, movePlanToWorkdir, patchBuilderState } from './builder-session.ts';

const agent = 'plan-path-test-agent';
const ws = await mkdtemp(join(tmpdir(), 'somora-ws-'));
const repo = await mkdtemp(join(tmpdir(), 'somora-repo-'));
// a defaulted plan path moves with the pin, file included
const s1 = '20260924-000000_move';
await sessionMetaStore.set(agent, s1, { builderMode: 'attended', builderPhase: 'plan', builderPlanPath: join(ws, 'PLAN.md'), builderPlanPathDefault: true } as never);
await writeFile(join(ws, 'PLAN.md'), '# old plan\n');
const r = await movePlanToWorkdir(sessionMetaStore, agent, s1, repo);
assert.deepEqual(r, { from: join(ws, 'PLAN.md'), to: join(repo, 'PLAN.md'), moved: true });
assert.equal(await readFile(join(repo, 'PLAN.md'), 'utf8'), '# old plan\n');
assert.equal((await sessionMetaStore.get(agent, s1) as { builderPlanPath?: string }).builderPlanPath, join(repo, 'PLAN.md'));
assert.equal(await movePlanToWorkdir(sessionMetaStore, agent, s1, repo), null, 'already there');
// an explicit plan path stays where it is
const s2 = '20260924-000000_explicit';
await sessionMetaStore.set(agent, s2, { builderMode: 'unattended', builderPhase: 'build' } as never);
await patchBuilderState(sessionMetaStore, agent, s2, { planPath: join(ws, 'docs', 'my-plan.md') });
assert.equal(await movePlanToWorkdir(sessionMetaStore, agent, s2, repo), null);
// archive names: date + session slug, numbered when taken
const dir = await mkdtemp(join(tmpdir(), 'somora-arch-'));
await mkdir(dir, { recursive: true });
const d = new Date('2026-09-24T10:00:00Z');
const a1 = await archiveNameFor(join(dir, 'PLAN.md'), '20260924-101010_3d-shooter', d);
assert.equal(a1, join(dir, 'PLAN-2026-09-24-3d-shooter.md'));
await writeFile(a1, 'x');
assert.equal(await archiveNameFor(join(dir, 'PLAN.md'), '20260924-101010_3d-shooter', d), join(dir, 'PLAN-2026-09-24-3d-shooter-2.md'));
console.log('builder-plan-path.test: ok');
