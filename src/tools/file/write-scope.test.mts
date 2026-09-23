// Where a builder may write. Run: npm test src/tools/file/write-scope.test.mts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../config/types.ts';
import { sessionMetaStore } from '../../storage/sessions.ts';
import { localWrite } from './local.ts';
import { agentTempDir, decideWriteScope, enforceWriteScope, isWithinRoots, writeScopeRoots } from './write-scope.ts';

// pure decisions
assert.equal(decideWriteScope({ absolute: '/x/other/a.txt', kind: 'chat', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: [] }).kind, 'unscoped');
assert.equal(decideWriteScope({ absolute: '/x/other/a.txt', kind: 'builder', workdir: null, mode: 'unattended', agent: 'a', sessionGrants: [] }).kind, 'unscoped');
assert.equal(decideWriteScope({ absolute: '/x/repo/src/a.ts', kind: 'builder', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: [] }).kind, 'inside');
assert.equal(decideWriteScope({ absolute: '/x/repo2/a.ts', kind: 'builder', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: [] }).kind, 'refused', 'sibling with shared prefix is outside');
assert.equal(decideWriteScope({ absolute: agentTempDir('a') + '/scratch.txt', kind: 'builder', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: [] }).kind, 'inside');
assert.equal(decideWriteScope({ absolute: '/x/other/a.txt', kind: 'builder', workdir: '/x/repo', mode: 'attended', agent: 'a', sessionGrants: [] }).kind, 'ask');
assert.equal(decideWriteScope({ absolute: '/x/other/a.txt', kind: 'builder', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: ['/x/other'] }).kind, 'inside', 'session grant');
const refused = decideWriteScope({ absolute: '/x/other/a.txt', kind: 'builder', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: [] });
assert.match((refused as { reason: string }).reason, /outside the project folder/);
assert.ok(isWithinRoots('/x/repo', writeScopeRoots('a', '/x/repo/')), 'the folder itself, trailing slash ignored');

// through the real file_write: a builder pinned to a folder
const home = process.env.SOMORA_HOME;
assert.ok(home && !home.endsWith('/.somora'), 'needs a throwaway SOMORA_HOME');
const agent = 'scope-test-builder';
await mkdir(join(home!, 'agents', agent), { recursive: true });
await writeFile(join(home!, 'agents', agent, 'AGENTS.md'), `---\nname: ${agent}\n---\nBuilder for the test.\n`);
await writeFile(join(home!, 'agents', agent, 'agent.yaml'), 'kind: builder\n');
const workspace = await mkdtemp(join(tmpdir(), 'somora-ws-'));
const repo = await mkdtemp(join(tmpdir(), 'somora-repo-'));
const config = { workspace: { default: workspace } } as unknown as Config;
const session = '20260923-000000_scoped';
await sessionMetaStore.set(agent, session, { workdir: repo, builderMode: 'unattended', builderPhase: 'build' } as never);

await localWrite({ path: 'inside.txt', content: 'ok\n', agent, session, config, mode: 'create' });
await assert.rejects(
  localWrite({ path: join(workspace, 'outside.txt'), content: 'no\n', agent, session, config, mode: 'create' }),
  /outside the project folder/,
  'unattended: refused',
);
await localWrite({ path: join(agentTempDir(agent), 'note.txt'), content: 'tmp\n', agent, session, config, mode: 'create' });
// a session grant opens that folder
await sessionMetaStore.update(agent, session, (m) => ({ ...m, builderWriteAllow: [workspace] }) as never);
await localWrite({ path: join(workspace, 'outside.txt'), content: 'granted\n', agent, session, config, mode: 'create' });
// no session, or a chat agent: untouched
await enforceWriteScope({ absolute: join(workspace, 'x.txt'), agent, config });
console.log('write-scope.test: ok');
