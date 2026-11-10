// Sentinel's store is written as tmp file + rename (store.ts); the
// scheduler watches the folder with these options and must see every
// rewrite of triggers.json (a missed one lost an `every 3m` trigger on
// 2026-05-17). Written for the chokidar 6 bump, kept for the next one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chokidar from 'chokidar';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('every tmp+rename rewrite of triggers.json is seen; the history folder and tmp files are not it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-watch-'));
  const target = join(dir, 'triggers.json');
  mkdirSync(join(dir, 'history'));
  writeFileSync(target, '[]');
  const seen: string[] = [];
  const w = chokidar.watch(dir, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }, persistent: true, depth: 0 });
  w.on('add', (p) => p === target && seen.push('add'));
  w.on('change', (p) => p === target && seen.push('change'));
  await new Promise<void>((r) => w.on('ready', () => r()));
  try {
    for (let i = 1; i <= 3; i++) {
      const before = seen.length;
      const tmp = join(dir, `.triggers.json.tmp-${i}`);
      writeFileSync(tmp, JSON.stringify([{ id: i }]));
      renameSync(tmp, target);
      writeFileSync(join(dir, 'history', `${i}.json`), '{}');
      const end = Date.now() + 4000;
      while (seen.length === before && Date.now() < end) await sleep(50);
      assert.ok(seen.length > before, `rewrite ${i} seen (events so far: ${seen.join(',')})`);
      await sleep(300);
    }
  } finally {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
