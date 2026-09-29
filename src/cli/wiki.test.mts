// `somora wiki migrate` against a fake server: argument parsing, every
// step's calls and output, the guided walk with typed answers, and undo
// on a temp wiki.
//
// Run: npx tsx src/cli/wiki.test.mts

import { mkdtemp, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-wiki-cli-home-'));
const { parseArgs, runWikiCli, stepUndo, usage } = await import('./wiki.ts');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
};

// ── parse ─────────────────────────────────────────────────────────────
{
  const p = parseArgs(['approve', '20260929-123450', '--action', 'move', '--action', 'fold', '--twins', '--group', 'fold:projekte/somora', '--dismiss', '--url', 'http://x:1/']);
  check('parse approve', p.step === 'approve' && p.id === '20260929-123450' && p.actions.join(',') === 'move,fold' && p.twins && p.groups[0] === 'fold:projekte/somora' && p.dismiss && p.url === 'http://x:1/');
  check('parse run --confirm', parseArgs(['run', 'x', '--confirm', 'move my wiki']).confirm === 'move my wiki');
  check('parse guided', parseArgs([]).step === '');
  let err = '';
  try {
    parseArgs(['--bogus']);
  } catch (e) {
    err = (e as Error).message;
  }
  check('unknown option rejected', /unknown option/.test(err));
  check('usage mentions every step', ['plan', 'judge', 'status', 'approve', 'dry-run', 'run', 'undo'].every((s) => usage().includes(s)));
}

// ── fake server ───────────────────────────────────────────────────────
const calls: Array<{ m: string; p: string; b?: unknown }> = [];
const state = {
  refined: null as null | { model: string; pagesJudged: number; batchesFailed: number; groups: Array<{ action: string; target: string | null; pages: number }> },
  refine: null as null | { done: number; total: number; finished?: string },
  execute: null as null | { done: number; total: number; dryRun: boolean; finished?: string; last?: string },
  approvals: { groups: {} as Record<string, { status: string }>, twins: {} as Record<string, { status: string }> },
};
const groups = [
  { action: 'move', target: 'regeln', pages: 47 },
  { action: 'fold', target: 'projekte/somora', pages: 96 },
  { action: 'keep', target: null, pages: 145 },
  { action: 'unclear', target: null, pages: 13 },
];
const api = {
  async get(p: string) {
    calls.push({ m: 'GET', p });
    if (p === '/wiki/status') return { enabled: true, root: '/tmp/none' };
    if (p.startsWith('/wiki/migration/plans/')) {
      // refine "finishes" on the second poll, execute on the second poll
      if (state.refine && !state.refine.finished) {
        state.refine.done = state.refine.total;
        state.refine.finished = 'now';
        state.refined = { model: 'fake/judge', pagesJudged: 301, batchesFailed: 0, groups };
      }
      if (state.execute && !state.execute.finished) {
        state.execute.done = state.execute.total;
        state.execute.finished = 'now';
      }
      return { id: 'P1', plan: { pagesTotal: 991, foldersTotal: 71, summary: { move_folder: { items: 1, pages: 40 }, unite_twins: { items: 1, pages: 38 }, fold_report: { items: 1, pages: 190 }, review_pages: { items: 1, pages: 700 }, unclear: { items: 0, pages: 0 } } }, refine: state.refine, execute: state.execute, approvals: state.approvals, refined: state.refined };
    }
    throw new Error(`GET ${p} → 404`);
  },
  async post(p: string, b?: unknown) {
    calls.push({ m: 'POST', p, b });
    if (p === '/wiki/migration/plan') return { id: 'P1', plan: '/x/plan.md', pagesTotal: 991, foldersTotal: 71, summary: { move_folder: { items: 1, pages: 40 } } };
    if (p === '/wiki/migration/refine') {
      state.refine = { done: 0, total: 40 };
      return { id: 'P1', started: true, message: 'started' };
    }
    if (p === '/wiki/migration/plans/P1/approve') {
      const body = b as { action?: string; groups?: string[]; twins?: string; status: string };
      const keys = body.groups ?? groups.filter((g) => g.action === body.action).map((g) => `${g.action}:${g.target ?? ''}`);
      for (const k of keys) state.approvals.groups[k] = { status: body.status };
      if (body.twins === 'all') state.approvals.twins['x'] = { status: body.status };
      const ap = Object.entries(state.approvals.groups).filter(([, v]) => v.status === 'approved');
      return { approvedGroups: ap.length, approvedPages: ap.reduce((n, [k]) => n + (groups.find((g) => `${g.action}:${g.target ?? ''}` === k)?.pages ?? 0), 0), approvedTwins: Object.values(state.approvals.twins).filter((t) => t.status === 'approved').length };
    }
    if (p === '/wiki/migration/plans/P1/execute') {
      const body = b as { dryRun: boolean; confirm?: string; wait?: boolean };
      if (body.dryRun) return { report: '/x/dry-run.md', steps: 144, counts: { move: 0, fold: 0, unite: 0, failed: 0, skipped: 0 }, linksRewritten: 300 };
      if (body.confirm !== 'move my wiki') throw new Error('a real run needs confirm');
      state.execute = { done: 0, total: 144, dryRun: false };
      return { started: true, message: 'bg' };
    }
    if (p === '/wiki/migration/reindex') return { indexed: 3, skipped: 400 };
    if (p === '/wiki/migration/plans/P1/relink') return { id: 'P1', renames: 5, refsRewritten: 7, pagesTouched: 3 };
    throw new Error(`POST ${p} → 404`);
  },
};
const lines: string[] = [];
const out = (l: string): void => {
  lines.push(l);
};
const reset = (): void => {
  lines.length = 0;
  calls.length = 0;
};

// ── steps ─────────────────────────────────────────────────────────────
reset();
check('plan', (await runWikiCli(['migrate', 'plan'], { api, out })) === 0 && lines[0]!.startsWith('Plan P1: 991 pages in 71 folders'));
reset();
check('judge polls until finished and lists', (await runWikiCli(['migrate', 'judge', 'P1'], { api, out, pollMs: 1 })) === 0 && lines.some((l) => l.includes('Judged 301 pages with fake/judge')) && calls.some((c) => c.p === '/wiki/migration/refine'));
reset();
check('judge again does not re-run', (await runWikiCli(['migrate', 'judge', 'P1'], { api, out, pollMs: 1 })) === 0 && !calls.some((c) => c.p === '/wiki/migration/refine'));
reset();
check('status shows groups with boxes', (await runWikiCli(['migrate', 'status', 'P1'], { api, out })) === 0 && lines.some((l) => l.includes('[ ] move 47 pages to regeln/')) && lines.some((l) => l.includes('145 pages stay')));
reset();
check('approve by action and twins', (await runWikiCli(['migrate', 'approve', 'P1', '--action', 'move', '--twins'], { api, out })) === 0 && state.approvals.groups['move:regeln']?.status === 'approved' && state.approvals.twins['x']?.status === 'approved' && lines[0]!.includes('now 1 groups (47 pages) and 1 same-name unions'));
reset();
check('dismiss a group', (await runWikiCli(['migrate', 'approve', 'P1', '--group', 'fold:projekte/somora', '--dismiss'], { api, out })) === 0 && state.approvals.groups['fold:projekte/somora']?.status === 'dismissed');
reset();
check('approve with nothing selected fails', (await runWikiCli(['migrate', 'approve', 'P1'], { api, out })) === 1);
reset();
check('dry run', (await runWikiCli(['migrate', 'dry-run', 'P1'], { api, out })) === 0 && lines[0]!.includes('144 steps planned, 300 links'));
reset();
check('run without the words refused before any call', (await runWikiCli(['migrate', 'run', 'P1'], { api, out })) === 1 && !calls.some((c) => c.p.endsWith('/execute')));
reset();
check('run with the words polls to the end', (await runWikiCli(['migrate', 'run', 'P1', '--confirm', 'move my wiki'], { api, out, pollMs: 1 })) === 0 && lines.some((l) => l.startsWith('Done.')) && (calls.find((c) => c.p.endsWith('/execute'))!.b as { dryRun: boolean }).dryRun === false);
reset();
reset();
check('relink', (await runWikiCli(['migrate', 'relink', 'P1'], { api, out })) === 0 && lines[0] === 'Relinked: 7 references in 3 pages (5 renames from the run)');
check('missing id', (await runWikiCli(['migrate', 'status'], { api, out })) === 1);
check('unknown step', (await runWikiCli(['migrate', 'fly', 'P1'], { api, out })) === 2);
check('wrong subcommand', (await runWikiCli(['prune'], { api, out })) === 2);

// ── guided ────────────────────────────────────────────────────────────
reset();
state.refined = null;
state.refine = null;
state.execute = null;
state.approvals = { groups: {}, twins: {} };
const answers = ['2', 'move my wiki'];
const code = await runWikiCli(['migrate'], { api, out, pollMs: 1, ask: async () => answers.shift() ?? '' });
check('guided: four steps, group 2 left out, twins approved, real run', code === 0 && state.approvals.groups['move:regeln']?.status === 'approved' && state.approvals.groups['fold:projekte/somora']?.status === 'dismissed' && state.approvals.twins['x']?.status === 'approved' && lines.some((l) => l.startsWith('Done.')), lines.join('\n'));
check('guided lists numbered groups and the unclear count', lines.some((l) => /^\s+1\s+move 47 pages to regeln\//.test(l)) && lines.some((l) => l.includes('13 unclear pages stay')));
reset();
state.approvals = { groups: {}, twins: {} };
const answers2 = ['none', 'no'];
check('guided: stop before the real run', (await runWikiCli(['migrate'], { api, out, pollMs: 1, ask: async () => answers2.shift() ?? '' })) === 0 && lines.some((l) => l.startsWith('Stopped before any change')) && !calls.some((c) => c.p.endsWith('/execute') && (c.b as { dryRun: boolean }).dryRun === false));

// ── undo ──────────────────────────────────────────────────────────────
{
  const root = await mkdtemp(join(tmpdir(), 'somora-wiki-undo-'));
  const wikiAbs = join(root, 'wiki');
  await mkdir(join(wikiAbs, 'regeln'), { recursive: true });
  await writeFile(join(wikiAbs, 'regeln/a.md'), 'after');
  const planDir = join(process.env.SOMORA_HOME!, 'wiki-migration', 'P1');
  await mkdir(join(planDir, 'backup-20260929-132903', 'wohnen'), { recursive: true });
  await writeFile(join(planDir, 'backup-20260929-132903', 'wohnen/a.md'), 'before');
  await mkdir(join(planDir, 'backup-20260929-100000'), { recursive: true });
  await writeFile(join(planDir, 'backup-20260929-100000', 'old.md'), 'older');
  reset();
  let cancelled = '';
  try {
    await stepUndo({ id: 'P1', wikiAbs, api, yes: false, ask: async () => 'no', out });
  } catch (e) {
    cancelled = (e as Error).message;
  }
  check('undo asks and stops on anything but yes', cancelled === 'cancelled' && (await readFile(join(wikiAbs, 'regeln/a.md'), 'utf8')) === 'after');
  const r = await stepUndo({ id: 'P1', wikiAbs, api, yes: true, out, now: new Date('2026-09-29T15:00:00Z') });
  check('undo restores the NEWEST backup', (await readFile(join(wikiAbs, 'wohnen/a.md'), 'utf8')) === 'before' && !(await stat(join(wikiAbs, 'regeln')).then(() => true, () => false)) && r.restoredFrom.endsWith('backup-20260929-132903'));
  check('undo keeps the current state aside', (await readFile(join(r.movedAsideTo, 'regeln/a.md'), 'utf8')) === 'after' && r.movedAsideTo.endsWith('.before-undo-20260929-150000'));
  check('undo sweeps the index', lines.some((l) => l.includes('Search index swept: 3 indexed')));
  let none = '';
  try {
    await stepUndo({ id: 'P9', wikiAbs, yes: true, out });
  } catch (e) {
    none = (e as Error).message;
  }
  check('undo without a backup refuses', /no backup/.test(none));
  check('nothing else in the temp root', (await readdir(root)).length === 2);
}

console.log(`wiki cli: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
