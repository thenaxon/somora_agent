// file_list recursive: .gitignore'd paths are skipped via rg --files,
// directories on the way to kept files still appear, globs still apply.
// Run: npx tsx src/tools/file/list-gitignore.test.mts (needs rg)
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFromFileList, compileGlob, rgFiles, type ListEntry } from './local.ts';

const root = await mkdtemp(join(tmpdir(), 'somora-list-'));
try {
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFile(join(root, 'src', 'a.ts'), 'a');
  await writeFile(join(root, 'src', 'deep', 'b.test.ts'), 'b');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  await writeFile(join(root, 'dist', 'bundle.js'), 'x');
  await writeFile(join(root, 'README.md'), 'r');

  const files = await rgFiles(root);
  assert.ok(files, 'rg present');
  const set = new Set(files!);
  assert.ok(set.has('src/a.ts'));
  assert.ok(set.has('src/deep/b.test.ts'));
  assert.ok(set.has('README.md'));
  assert.ok(!set.has('node_modules/pkg/index.js'), 'ignored');
  assert.ok(!set.has('dist/bundle.js'), 'ignored');
  assert.ok(!set.has('.gitignore'), 'hidden skipped');

  const all: ListEntry[] = [];
  await collectFromFileList(root, files!, all, null);
  const rel = all.map((e) => e.path.slice(root.length + 1)).sort();
  assert.deepEqual(rel, ['README.md', 'src', 'src/a.ts', 'src/deep', 'src/deep/b.test.ts']);
  assert.equal(all.find((e) => e.path.endsWith('/src'))?.type, 'dir');

  const tests: ListEntry[] = [];
  await collectFromFileList(root, files!, tests, compileGlob('*.test.ts'));
  assert.deepEqual(
    tests.map((e) => e.path.slice(root.length + 1)),
    ['src/deep/b.test.ts'],
  );
  const positional: ListEntry[] = [];
  await collectFromFileList(root, files!, positional, compileGlob('src/*.ts'));
  assert.deepEqual(
    positional.map((e) => e.path.slice(root.length + 1)),
    ['src/a.ts'],
  );
  console.log('list-gitignore.test: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
