// The memory watcher against real files: what reaches the index and what
// does not. Written for the chokidar 6 bump (new observation pipeline),
// kept as the guard for the next one.
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownWatcher, type FileEvent } from './watcher.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(events: FileEvent[], pred: (e: FileEvent) => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (events.some(pred)) return true;
    await sleep(50);
  }
  return false;
}

test('memory watcher: add, change, unlink, late subfolders; dot folders and other files stay out', async () => {
  // The root sits below a dot folder, as ~/.somora does: only components
  // below the root may be skipped (the manager's ignore rule).
  const base = mkdtempSync(join(tmpdir(), 'mdwatch-'));
  const root = join(base, '.somora', 'agents', 'a', 'memory');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'before.md'), 'there before start');
  const ignored = (path: string): boolean => {
    if (path === root) return false;
    if (!path.startsWith(root + '/')) return false;
    return path.slice(root.length + 1).split('/').some((c) => c.startsWith('.'));
  };
  const events: FileEvent[] = [];
  const w = new MarkdownWatcher({ roots: [root], ignored: [ignored], debounceMs: 50, onEvent: (e) => void events.push(e) });
  w.start();
  try {
    const at = (kind: FileEvent['kind'], name: string) => (e: FileEvent) => e.kind === kind && e.path === join(root, name);
    assert.ok(await until(events, at('change', 'before.md')), 'a file there before start is reported (initial scan)');

    await sleep(300);
    writeFileSync(join(root, 'new.md'), 'one');
    assert.ok(await until(events, at('change', 'new.md')), 'new file');

    events.length = 0;
    writeFileSync(join(root, 'new.md'), 'two, longer');
    assert.ok(await until(events, at('change', 'new.md')), 'changed file');

    // A folder made after start, and a file in it straight away.
    mkdirSync(join(root, 'topics', 'deep'), { recursive: true });
    writeFileSync(join(root, 'topics', 'deep', 'late.md'), 'late');
    assert.ok(await until(events, at('change', 'topics/deep/late.md')), 'file in a folder created after start');

    mkdirSync(join(root, '.dreams'), { recursive: true });
    writeFileSync(join(root, '.dreams', 'hidden.md'), 'x');
    writeFileSync(join(root, 'notes.txt'), 'not markdown');

    unlinkSync(join(root, 'new.md'));
    assert.ok(await until(events, at('unlink', 'new.md')), 'deleted file');

    await sleep(600);
    assert.ok(!events.some((e) => e.path.includes('/.dreams/')), 'dot folder below the root is ignored');
    assert.ok(!events.some((e) => e.path.endsWith('.txt')), 'only markdown reaches the manager');
  } finally {
    await w.stop();
    rmSync(base, { recursive: true, force: true });
  }
});
