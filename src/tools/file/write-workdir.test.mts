// A session pinned to a project folder: relative paths of file_write
// resolve there — the same root file_read uses. Found 2026-09-23 by a
// builder whose relative file_write landed in the agent workspace while
// its file_read of the same relative path read the repository.
// Run: npm test src/tools/file/write-workdir.test.mts (SOMORA_HOME is a
// throwaway dir under scripts/run-tests.mjs)
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../config/types.ts';
import { sessionMetaStore } from '../../storage/sessions.ts';
import { localRead, localWrite } from './local.ts';

const home = process.env.SOMORA_HOME;
assert.ok(home && !home.endsWith('/.somora'), 'needs a throwaway SOMORA_HOME');
const agent = 'workdir-test-agent';
await mkdir(join(home!, 'agents', agent), { recursive: true });
await writeFile(join(home!, 'agents', agent, 'AGENTS.md'), `---\nname: ${agent}\n---\nTest agent.\n`);
const workspace = await mkdtemp(join(tmpdir(), 'somora-ws-'));
const repo = await mkdtemp(join(tmpdir(), 'somora-repo-'));
const config = { workspace: { default: workspace } } as unknown as Config;
const session = '20260923-000000_pinned';
await sessionMetaStore.set(agent, session, { workdir: repo } as never);

// pinned session: the relative path lands in the repository
await localWrite({ path: 'cockpit/history.py', content: 'x = 1\n', agent, session, config, mode: 'create' });
assert.equal(await readFile(join(repo, 'cockpit', 'history.py'), 'utf8'), 'x = 1\n');
const read = await localRead({ path: 'cockpit/history.py', agent, session, config } as never);
assert.match(JSON.stringify(read), /x = 1/);

// no session: the agent workspace stays the root
await localWrite({ path: 'notes.md', content: 'n\n', agent, config, mode: 'create' });
assert.equal(await readFile(join(workspace, 'notes.md'), 'utf8'), 'n\n');
console.log('write-workdir.test: ok');
