// Folders an orderer allows besides the project (builder_dispatch
// `write_allow`): the check, the refusal that names them and forbids the
// exec detour, and where the builder is told. Report 2026-10-28: a
// builder ordered into a worktree beside its project hit the write scope
// mid-build and wrote the files through exec instead.
//
// Run: npm test src/tools/file/write-allow.test.mts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_WRITE_ALLOW, checkWriteAllow, decideWriteScope } from './write-scope.ts';
import { renderBuilderSessionBlock } from '../../server/builder-session.ts';
import { buildBuilderHarnessPrompt } from '../../server/builder-prompt.ts';
import { composeBuildOrder } from '../agents/builder-dispatch.ts';

const base = await realpath(await mkdtemp(join(tmpdir(), 'somora-allow-')));
const project = join(base, 'app');
const worktree = join(base, 'app-next');
await mkdir(project);
await mkdir(worktree);
await writeFile(join(base, 'a-file'), 'x');
await symlink(worktree, join(base, 'link-to-next'));

test('a worktree beside the project is allowed, by its real path', () => {
  const r = checkWriteAllow([worktree, join(base, 'link-to-next')], project);
  assert.deepEqual(r, { ok: true, folders: [worktree] }, 'the symlink resolves to the same folder, once');
});

test('refused: missing, a file, relative, too many', () => {
  const err = (folders: unknown[]) => {
    const r = checkWriteAllow(folders, project);
    assert.equal(r.ok, false);
    return (r as { error: string }).error;
  };
  assert.match(err([join(base, 'nope')]), /does not exist — create it first/);
  assert.match(err([join(base, 'a-file')]), /is not a folder/);
  assert.match(err(['app-next']), /not an absolute path/);
  assert.match(err([42]), /not an absolute path/);
  assert.match(err(Array.from({ length: MAX_WRITE_ALLOW + 1 }, () => worktree)), /at most 4/);
});

test('refused: too wide — the root, home, a folder holding the project, somora home', () => {
  const err = (f: string) => (checkWriteAllow([f], project) as { error?: string }).error ?? '';
  assert.match(err('/'), /too wide/);
  assert.match(err(homedir()), /too wide/);
  assert.match(err(dirname(homedir())), /too wide/, 'a parent of home');
  assert.match(err(base), /holds the project folder/, 'the Projects folder would open every neighbour');
  assert.match(err(project), /holds the project folder/, 'the project itself is already allowed');
  const somoraHome = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  assert.match(err(somoraHome), /somora's home/);
});

test('the refusal names the allowed folders and says: not through exec', () => {
  const v = decideWriteScope({ absolute: '/x/elsewhere/a.sh', kind: 'builder', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: ['/x/repo-next'] });
  assert.equal(v.kind, 'refused');
  const reason = (v as { reason: string }).reason;
  assert.match(reason, /\/x\/repo \(the pinned project\)/);
  assert.match(reason, /a folder allowed for this session \(\/x\/repo-next\)/);
  assert.match(reason, /do not write the file with exec instead/);
  assert.match(reason, /name the folder in your report/);
  const none = decideWriteScope({ absolute: '/x/elsewhere/a.sh', kind: 'builder', workdir: '/x/repo', mode: 'unattended', agent: 'a', sessionGrants: [] });
  assert.doesNotMatch((none as { reason: string }).reason, /allowed for this session/);
});

test('the builder is told: in the session block, in the order, in the harness rules', () => {
  const state = { mode: 'unattended', phase: 'build', planPath: null, todos: [] } as const;
  assert.match(renderBuilderSessionBlock({ ...state, todos: [] }, { writeAllow: ['/x/repo-next'] }), /Also allowed to write, besides the project folder: \/x\/repo-next/);
  assert.doesNotMatch(renderBuilderSessionBlock({ ...state, todos: [] }, { writeAllow: [] }), /Also allowed/);
  assert.match(composeBuildOrder({ task: 'Fix it.', write_allow: ['/x/repo-next'] }), /Besides the project folder you may write in: \/x\/repo-next/);
  assert.match(composeBuildOrder({ task: 'Fix it.', phase: 'plan', write_allow: ['/x/repo-next'] }), /Besides the project folder you may write in/);
  assert.doesNotMatch(composeBuildOrder({ task: 'Fix it.' }), /Besides the project folder/);
  assert.match(buildBuilderHarnessPrompt(), /never make the same change with exec/);
  assert.doesNotMatch(buildBuilderHarnessPrompt(new Set(['file_read', 'file_write'])), /never make the same change with exec/, 'no exec, no exec rule');
});
