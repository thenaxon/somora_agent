// Regression tests for the Deep MERGE anti-clobber guard (2026-07-22).
//
// Run: npx tsx src/dream/deep-actions.test.mts
//
// Context: Deep's MERGE prompt asks the worker model for the FULL
// integrated page body. On large pages a model may summarize instead —
// and applyMerge used to write that result unconditionally, then delete
// the source memory. External incident 2026-07-13 (Donna/luzudemca):
// a 22 KB page came back as 2.7 KB, content lost, recovery only from
// backup. Deep auto-applies (`requireApproval: false`), so nobody saw it
// happen.
//
// The guard refuses the write when the body shrank past `minRatio`. The
// property that actually matters and is asserted below: on a trip BOTH
// the wiki page AND the source memory file survive untouched.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyMerge, type ActionContext } from './deep-actions.ts';
import type { PromotionCandidate } from '../wiki/types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Build an isolated wiki + memory pair on disk. `bodyChars` controls
 *  the size of the existing wiki page body. */
async function scenario(bodyChars: number): Promise<{
  ctx: ActionContext;
  candidate: PromotionCandidate;
  wikiFile: string;
  memFile: string;
  existingBody: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'somora-deep-guard-'));
  const wikiAbs = join(root, 'wiki');
  await mkdir(join(wikiAbs, 'projekte'), { recursive: true });

  const existingBody = `## Aktueller Stand\n${'Bestehender Inhalt der Seite. '.repeat(
    Math.max(1, Math.ceil(bodyChars / 29)),
  )}`;
  const wikiFile = join(wikiAbs, 'projekte', 'flowbex-tech.md');
  await writeFile(
    wikiFile,
    `---\nslug: projekte/flowbex-tech\ntype: projekt\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n${existingBody}\n`,
    'utf8',
  );

  const memFile = join(root, 'neue-info.md');
  await writeFile(memFile, '---\nname: neue-info\n---\nEine kleine neue Info.\n', 'utf8');

  const candidate: PromotionCandidate = {
    agent: 'testagent',
    slug: 'neue-info',
    path: memFile,
    raw: 'irrelevant',
    frontmatter: {},
    body: 'Eine kleine neue Info.',
    mtimeMs: 0,
  };
  return { ctx: { wikiAbs }, candidate, wikiFile, memFile, existingBody };
}

async function run(): Promise<void> {
  // ── 1. The incident: big page, model returns a summary → must refuse ──
  {
    const s = await scenario(22_000);
    const before = await readFile(s.wikiFile, 'utf8');
    const mtime = (await stat(s.wikiFile)).mtimeMs;
    const out = await applyMerge({
      candidate: s.candidate,
      decision: {
        kind: 'merge',
        wikiPath: 'projekte/flowbex-tech',
        body: '## Aktueller Stand\nNur die neue Info blieb uebrig.',
        logSummary: 'flowbex-tech aktualisiert',
      },
      ctx: s.ctx,
      wikiPageMtimeMs: mtime,
    });
    check('22KB→small: merge refused', out.kind === 'skipped', JSON.stringify(out));
    check(
      '22KB→small: marked transient (retries next run)',
      out.kind === 'skipped' && out.transient === true,
    );
    check('22KB→small: wiki page untouched', (await readFile(s.wikiFile, 'utf8')) === before);
    check('22KB→small: source memory NOT deleted', await exists(s.memFile));
  }

  // ── 2. Legitimate merge on a big page → must go through ──
  {
    const s = await scenario(22_000);
    const mtime = (await stat(s.wikiFile)).mtimeMs;
    const grownBody = `${s.existingBody}\n\n## Zeitleiste\n- 2026-07-22: Eine kleine neue Info.`;
    const out = await applyMerge({
      candidate: s.candidate,
      decision: {
        kind: 'merge',
        wikiPath: 'projekte/flowbex-tech',
        body: grownBody,
        logSummary: 'flowbex-tech aktualisiert',
      },
      ctx: s.ctx,
      wikiPageMtimeMs: mtime,
    });
    check('full-body merge: applied', out.kind === 'merged', JSON.stringify(out));
    const after = await readFile(s.wikiFile, 'utf8');
    check('full-body merge: new content present', after.includes('2026-07-22'));
    check('full-body merge: old content preserved', after.includes('Bestehender Inhalt'));
    check('full-body merge: source memory consumed', !(await exists(s.memFile)));
  }

  // ── 3. Small page is exempt (minExistingBytes) — normal editing ──
  {
    const s = await scenario(300);
    const mtime = (await stat(s.wikiFile)).mtimeMs;
    const out = await applyMerge({
      candidate: s.candidate,
      decision: {
        kind: 'merge',
        wikiPath: 'projekte/flowbex-tech',
        body: '## Aktueller Stand\nKompakt.',
        logSummary: 'gekuerzt',
      },
      ctx: s.ctx,
      wikiPageMtimeMs: mtime,
    });
    check('small page: shrink allowed', out.kind === 'merged', JSON.stringify(out));
  }

  // ── 4. Guard explicitly disabled → old behaviour (operator opt-out) ──
  {
    const s = await scenario(22_000);
    const mtime = (await stat(s.wikiFile)).mtimeMs;
    const out = await applyMerge({
      candidate: s.candidate,
      decision: {
        kind: 'merge',
        wikiPath: 'projekte/flowbex-tech',
        body: '## Aktueller Stand\nNur die neue Info.',
        logSummary: 'x',
      },
      ctx: { ...s.ctx, mergeShrinkGuard: { enabled: false, minRatio: 0.5, minExistingBytes: 2000 } },
      wikiPageMtimeMs: mtime,
    });
    check('guard disabled: shrink goes through', out.kind === 'merged', JSON.stringify(out));
  }

  // ── 5. Exactly at the boundary — just above minRatio must pass ──
  {
    const s = await scenario(10_000);
    const mtime = (await stat(s.wikiFile)).mtimeMs;
    const target = Math.ceil(s.existingBody.trim().length * 0.6);
    const out = await applyMerge({
      candidate: s.candidate,
      decision: {
        kind: 'merge',
        wikiPath: 'projekte/flowbex-tech',
        body: 'x'.repeat(target),
        logSummary: 'x',
      },
      ctx: s.ctx,
      wikiPageMtimeMs: mtime,
    });
    check('0.6× of original: allowed', out.kind === 'merged', JSON.stringify(out));
  }

  // ── 6. A caller that forgot to thread config still gets the guard ──
  {
    const s = await scenario(22_000);
    const mtime = (await stat(s.wikiFile)).mtimeMs;
    const out = await applyMerge({
      candidate: s.candidate,
      decision: {
        kind: 'merge',
        wikiPath: 'projekte/flowbex-tech',
        body: 'winzig',
        logSummary: 'x',
      },
      // ctx WITHOUT mergeShrinkGuard — the fallback must be guard-ON.
      ctx: { wikiAbs: s.ctx.wikiAbs },
      wikiPageMtimeMs: mtime,
    });
    check('no config threaded: guard still ON', out.kind === 'skipped', JSON.stringify(out));
    check('no config threaded: memory survives', await exists(s.memFile));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

await run();
assert.ok(true);
