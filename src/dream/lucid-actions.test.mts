// Lucid's actionable findings: the fix a finding's fields describe, a
// link set in plain prose only, links applied without review, pages
// united by a (fake) model with archive and relink, a page moved, and
// the memory of dismissed findings.
// Run: npx tsx src/dream/lucid-actions.test.mts
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-lucid-actions-home-'));
const { addLinkToBody, applyLucidFinding } = await import('./lucid-actions.ts');
const { fixFromFields, autoApplyLinks } = await import('./lucid-runner.ts');
const { writeLucidRun, recentlyDismissedKeys, findingKey, pendingLucidRun, listAllLucidRuns } = await import('./lucid-storage.ts');
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) pass++;
  else {
    fail++;
    console.error(`FAIL: ${n} ${d}`);
  }
};

// fixes from fields
check('link_suggestion → add_link', JSON.stringify(fixFromFields('link_suggestion', ['projekte/somora'], { phrase: 'Max Muster', target: '/personen/max-muster.md' })) === JSON.stringify({ kind: 'add_link', wikiPath: 'projekte/somora', phrase: 'Max Muster', target: 'personen/max-muster' }));
check('link_suggestion without phrase → null', fixFromFields('link_suggestion', ['a'], { target: 'b' }) === null);
check('duplicate_page → unite_pages, first survives', JSON.stringify(fixFromFields('duplicate_page', ['wissen/a-release', 'wissen/a', 'wissen/a'], {})) === JSON.stringify({ kind: 'unite_pages', keep: 'wissen/a-release', drop: ['wissen/a'] }));
check('misfiled_page → move_page into the named folder', JSON.stringify(fixFromFields('misfiled_page', ['wissen/peekaboo'], { target: 'infrastruktur/dienste' })) === JSON.stringify({ kind: 'move_page', from: 'wissen/peekaboo', to: 'infrastruktur/dienste/peekaboo' }));
check('contradiction → null (informational)', fixFromFields('contradiction', ['a', 'b'], {}) === null);

// addLinkToBody
const body = '# T\n\n## Stand\nMax Muster leitet das. Siehe [[personen/max-muster|Max Muster]] nicht.\nCode `Max Muster` bleibt.\n```\nMax Muster im Block\n```\nMax Muster wieder, und Maxwell.\n';
const linked = addLinkToBody(body, 'Max Muster', 'personen/max-muster');
check('first plain mention linked, existing link, code and fence untouched', linked !== null && linked.split('[[personen/max-muster|Max Muster]]').length === 3 && linked.includes('`Max Muster`') && linked.includes('Max Muster im Block') && linked.startsWith('# T'), linked ?? 'null');
check('heading skipped, whole words only', addLinkToBody('# Max Muster\nMaxwell\n', 'Max Muster', 'personen/max-muster') === null && addLinkToBody('Sie heißt Anna.', 'Anna', 'personen/anna') === 'Sie heißt [[personen/anna|Anna]].');
check('nothing to link → null', addLinkToBody('nichts', 'Anna', 'personen/anna') === null);

// a temp wiki
const wikiAbs = await mkdtemp(join(tmpdir(), 'somora-lucid-actions-wiki-'));
const page = async (rel: string, body: string, extra = ''): Promise<void> => {
  await mkdir(join(wikiAbs, rel, '..'), { recursive: true });
  await writeFile(join(wikiAbs, `${rel}.md`), `---\nslug: ${rel}\ntype: konzept\ncreated: 2026-01-01\nupdated: 2026-01-01\n${extra}---\n# ${rel.split('/').pop()}\n\n${body}\n`);
};
await page('personen/anna', 'Anna.');
await page('projekte/haus', 'Anna baut das Haus. Anna wieder.');
await page('wissen/a-release', '## Stand\nRelease v2, 933 Contributors. '.repeat(20));
await page('wissen/a', '## Stand\nRelease v2 mit Saturn-Cloud.\n');
await page('orte/x', 'Siehe [[wissen/a]] und [[a|die Seite]].', 'related:\n  - wissen/a\n');
await page('wissen/skill', 'Ein Skill.');

const mk = (id: number, kind: string, pages: string[], fix: unknown) => ({ id, kind, status: 'pending', affected_pages: pages, reason: 'r', fix }) as never;
// apply add_link
const r1 = await applyLucidFinding(mk(1, 'link_suggestion', ['projekte/haus'], { kind: 'add_link', wikiPath: 'projekte/haus', phrase: 'Anna', target: 'personen/anna' }), { wikiAbs });
check('add_link applied once', r1.kind === 'applied' && (await readFile(join(wikiAbs, 'projekte/haus.md'), 'utf8')).includes('[[personen/anna|Anna]] baut das Haus. Anna wieder.'));
const r2 = await applyLucidFinding(mk(2, 'link_suggestion', ['projekte/haus'], { kind: 'add_link', wikiPath: 'projekte/haus', phrase: 'Anna', target: 'personen/anna' }), { wikiAbs });
check('already linked → skipped', r2.kind === 'skipped' && /already links/.test(r2.reason));
const r3 = await applyLucidFinding(mk(3, 'link_suggestion', ['projekte/haus'], { kind: 'add_link', wikiPath: 'projekte/haus', phrase: 'Bert', target: 'personen/bert' }), { wikiAbs });
check('missing target → skipped', r3.kind === 'skipped' && /does not exist/.test(r3.reason));

// autoApplyLinks bookkeeping with a fake apply
const links = [
  mk(1, 'link_suggestion', ['p/a'], { kind: 'add_link', wikiPath: 'p/a', phrase: 'x', target: 't/x' }),
  mk(2, 'link_suggestion', ['p/a'], { kind: 'add_link', wikiPath: 'p/a', phrase: 'x again', target: 't/x' }),
  mk(3, 'link_suggestion', ['p/b'], { kind: 'no_op', note: 'no phrase' }),
  mk(4, 'link_suggestion', ['p/c'], { kind: 'add_link', wikiPath: 'p/c', phrase: 'y', target: 't/y' }),
  mk(5, 'link_suggestion', ['p/d'], { kind: 'add_link', wikiPath: 'p/d', phrase: 'z', target: 't/z' }),
];
const seenApply: string[] = [];
const out = await autoApplyLinks(links, { wikiAbs, enabled: true, max: 2, id: 't', apply: async (f) => { seenApply.push(f.fix.kind === 'add_link' ? f.fix.wikiPath : '?'); return f.fix.kind === 'add_link' && f.fix.wikiPath === 'p/c' ? { kind: 'skipped', reason: 'phrase not found' } : { kind: 'applied', detail: 'ok' }; } });
check('auto links: same page+target once, no_op dismissed, budget respected, outcomes recorded', out.length === 4 && out.map((f: { status: string }) => f.status).join(',') === 'applied,dismissed,dismissed,applied' && seenApply.join(',') === 'p/a,p/c,p/d' && /phrase not found/.test((out[2] as { resolution_note: string }).resolution_note));
const off = await autoApplyLinks(links.slice(0, 1), { wikiAbs, enabled: false, max: 2, id: 't', apply: async () => ({ kind: 'applied', detail: 'x' }) });
check('auto links off → dismissed with note, nothing applied', off[0]!.status === 'dismissed' && /autoLinks/.test(off[0]!.resolution_note ?? ''));

// unite with a fake model
const asks: string[] = [];
const r4 = await applyLucidFinding(mk(4, 'duplicate_page', ['wissen/a-release', 'wissen/a'], { kind: 'unite_pages', keep: 'wissen/a-release', drop: ['wissen/a'] }), {
  wikiAbs, language: 'de', ask: async ({ user }) => { asks.push(user); const m = /<surviving path="[^"]+">\n([\s\S]*?)\n<\/surviving>/.exec(user)!; return JSON.stringify({ body: m[1]!.replace(/^---[\s\S]*?---\n/, '').trim() + '\n- Saturn-Cloud ergänzt\n' }); },
});
check('unite: merged body written, other archived, links and related repointed', r4.kind === 'applied' && (await readFile(join(wikiAbs, 'wissen/a-release.md'), 'utf8')).includes('Saturn-Cloud ergänzt') && !(await stat(join(wikiAbs, 'wissen/a.md')).then(() => true, () => false)) && (await stat(join(wikiAbs, 'logs/berichte/wissen--a.md')).then(() => true, () => false)) && (await readFile(join(wikiAbs, 'orte/x.md'), 'utf8')).includes('[[wissen/a-release]] und [[wissen/a-release|die Seite]]') && (await readFile(join(wikiAbs, 'orte/x.md'), 'utf8')).includes('- wissen/a-release'), JSON.stringify(r4));
const r5 = await applyLucidFinding(mk(5, 'duplicate_page', ['wissen/a-release', 'wissen/a'], { kind: 'unite_pages', keep: 'wissen/a-release', drop: ['wissen/a'] }), { wikiAbs, language: 'de', ask: async () => '{}' });
check('unite again → skipped, nothing left to unite', r5.kind === 'skipped');
const r6 = await applyLucidFinding(mk(6, 'duplicate_page', ['x', 'y'], { kind: 'unite_pages', keep: 'x', drop: ['y'] }), { wikiAbs });
check('unite without a model → failed with a clear reason', r6.kind === 'failed' && /needs a model/.test(r6.error));

// move
await mkdir(join(wikiAbs, 'infrastruktur/dienste'), { recursive: true });
const r7 = await applyLucidFinding(mk(7, 'misfiled_page', ['wissen/skill'], { kind: 'move_page', from: 'wissen/skill', to: 'infrastruktur/dienste/skill' }), { wikiAbs, language: 'de' });
check('move applied', r7.kind === 'applied' && (await stat(join(wikiAbs, 'infrastruktur/dienste/skill.md')).then(() => true, () => false)));
const r8 = await applyLucidFinding(mk(8, 'misfiled_page', ['personen/anna'], { kind: 'move_page', from: 'personen/anna', to: 'fahrzeuge/anna' }), { wikiAbs, language: 'de' });
check('move into an unknown folder → failed', r8.kind === 'failed' && /neither an existing folder/.test(r8.error));

// dismissed memory + pending run
const now = new Date();
await writeLucidRun({ id: '20260901-000000_auto_lucid', status: 'processed', created_at: now.toISOString(), trigger: 'auto', pages_scanned: 1, worker_model_ref: 'x', findings: [
  { id: 1, kind: 'contradiction', status: 'dismissed', affected_pages: ['B/x', 'a/y'], reason: 'r', fix: { kind: 'no_op', note: '' }, resolved_at: now.toISOString(), resolution_note: 'Max: both dates are right, different events' },
  { id: 2, kind: 'contradiction', status: 'dismissed', affected_pages: ['old/1'], reason: 'r', fix: { kind: 'no_op', note: '' }, resolved_at: new Date(now.getTime() - 100 * 86_400_000).toISOString(), resolution_note: 'Max: no' },
  { id: 4, kind: 'contradiction', status: 'dismissed', affected_pages: ['auto/1'], reason: 'r', fix: { kind: 'no_op', note: '' }, resolved_at: now.toISOString() },
  { id: 5, kind: 'contradiction', status: 'dismissed', affected_pages: ['auto/2'], reason: 'r', fix: { kind: 'no_op', note: '' }, resolved_at: now.toISOString(), resolution_note: 'dismissed with the rest at review end' },
  { id: 3, kind: 'contradiction', status: 'resolved_manually', affected_pages: ['done/1'], reason: 'r', fix: { kind: 'no_op', note: '' }, resolved_at: now.toISOString() },
] });
const keys = await recentlyDismissedKeys(90, now.getTime());
check('remembered: a person\'s dismissal with a reason within 90 days — not older, not resolved, not closed by the software', keys.has(findingKey({ kind: 'contradiction', affected_pages: ['a/y', 'b/X'] })) && keys.size === 1, [...keys].join(' | '));
check('no pending run yet', (await pendingLucidRun()) === null);
await writeLucidRun({ id: '20260902-000000_auto_lucid', status: 'completed', created_at: now.toISOString(), trigger: 'auto', pages_scanned: 1, worker_model_ref: 'x', findings: [{ id: 1, kind: 'contradiction', status: 'pending', affected_pages: ['q'], reason: 'r', fix: { kind: 'no_op', note: '' } }] });
check('a run with open findings is the pending run', (await pendingLucidRun())?.id === '20260902-000000_auto_lucid' && (await listAllLucidRuns()).length === 2);

console.log(`lucid actions: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
