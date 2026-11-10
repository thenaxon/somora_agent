// Dream actions never turn a model-supplied wiki path into a file
// outside the wiki (Fable review 2026-11-10 Nr. 8).
import '../testing/isolated-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wikiFile, WikiPathError } from './wiki-file.ts';
import { applyLucidFinding } from './lucid-actions.ts';

test('paths inside the wiki pass, everything else is refused', () => {
  const w = '/vault/wiki';
  assert.equal(wikiFile(w, 'people/ada'), '/vault/wiki/people/ada.md');
  for (const bad of ['../../etc/notes', 'a/../../x', '/etc/x', 'a\\..\\b', '..', '', 'a/\0b']) {
    assert.throws(() => wikiFile(w, bad), WikiPathError, JSON.stringify(bad));
  }
});

test('a Lucid fix aimed outside the wiki fails that finding and writes nothing', async () => {
  const base = mkdtempSync(join(tmpdir(), 'wikifile-'));
  const wikiAbs = join(base, 'vault', 'wiki');
  mkdirSync(wikiAbs, { recursive: true });
  const victim = join(base, 'vault', 'victim.md');
  writeFileSync(victim, 'untouched');
  const r = await applyLucidFinding(
    { fix: { kind: 'update_page', wikiPath: '../victim', newBody: 'pwned', logSummary: 'x' } } as never,
    { wikiAbs } as never,
  );
  assert.equal(r.kind, 'failed');
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
});
