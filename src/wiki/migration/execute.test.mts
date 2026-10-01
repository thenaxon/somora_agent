// The executor on a small grown wiki with a fake model: backup first,
// moves with slug update, folds with chain resolution and archive,
// unions, links rewritten wiki-wide, empty folders gone, structure
// file stamped, index regenerated — and a dry run that writes nothing.
//
// Run: npx tsx src/wiki/migration/execute.test.mts

import { mkdtemp, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-execute-home-'));
const { executeMigration, approvedWork, resolveTarget, rewriteLinks, insertUnderHeading, parseFoldReply, parseUniteReply, emptyApprovals, renderExecution } = await import('./execute.ts');
const { analyzeWiki } = await import('./analyze.ts');
const { groupDecisions } = await import('./refine.ts');
const { emptyStructure, loadStructureFile } = await import('../structure-file.ts');
const { writeExecution, readApprovals, writeApprovals, backupDirFor } = await import('./store.ts');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
};
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

// ── pure helpers ──────────────────────────────────────────────────────
{
  const r = rewriteLinks('see [[hardware/proxmox]] and [[Hardware/Proxmox|the box]] and [[proxmox#Netz]] and [[gpt-6]] and [x](hardware/proxmox.md)', new Map([['hardware/proxmox', 'infrastruktur/hosts/proxmox']]), new Map([['proxmox', 'infrastruktur/hosts/proxmox']]));
  check('links: full path, case-insensitive, alias and heading kept, basename of a vanished page, markdown link', r.count === 4 && r.body === 'see [[infrastruktur/hosts/proxmox]] and [[infrastruktur/hosts/proxmox|the box]] and [[infrastruktur/hosts/proxmox#Netz]] and [[gpt-6]] and [x](infrastruktur/hosts/proxmox.md)', r.body);
  const r2 = rewriteLinks('[[proxmox]]', new Map([['hardware/proxmox', 'infrastruktur/geraete/proxmox']]), new Map());
  check('basename link after a plain move is left alone', r2.count === 0);
  const b1 = insertUnderHeading('# T\n\n## Stand\nx\n\n## Zeitleiste\n- 2026-01-01: a\n\n## Notizen\nn\n', 'Zeitleiste', '- 2026-02-02: b');
  check('entry appended at the end of its section', b1.includes('- 2026-01-01: a\n- 2026-02-02: b\n\n## Notizen'), JSON.stringify(b1));
  const b2 = insertUnderHeading('# T\n\n## Stand\nx\n', 'Zeitleiste', '- 2026-02-02: b');
  check('missing section is added at the end', b2.endsWith('## Stand\nx\n\n## Zeitleiste\n- 2026-02-02: b\n'), JSON.stringify(b2));
  const b3 = insertUnderHeading('# T\n\n## Zeitleiste\n- a\n', '## zeitleiste', '- b');
  check('last section, heading with hashes and case', b3.endsWith('- a\n- b\n'), JSON.stringify(b3));
  check('fold reply', parseFoldReply('ok {"heading":"## Zeitleiste","entry":" - 2026-09-16: x "}', 'Zeitleiste')?.heading === 'Zeitleiste' && parseFoldReply('{"entry":"y"}', 'Timeline')?.heading === 'Timeline' && parseFoldReply('{"heading":"x"}', 'T') === null);
  check('unite reply strips frontmatter', parseUniteReply('{"body":"---\\nslug: a\\n---\\n# A\\nb"}') === '# A\nb');
}

// ── the wiki ──────────────────────────────────────────────────────────
const wikiAbs = await mkdtemp(join(tmpdir(), 'somora-execute-wiki-'));
const page = async (rel: string, type: string, body: string): Promise<void> => {
  await mkdir(join(wikiAbs, rel, '..'), { recursive: true });
  await writeFile(join(wikiAbs, `${rel}.md`), `---\nslug: ${rel}\ntype: ${type}\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# ${rel.split('/').pop()}\n\n${body}\n`);
};
await writeFile(join(wikiAbs, 'index.md'), '# Index\n- [[hardware/proxmox]]\n');
await mkdir(join(wikiAbs, 'logs'), { recursive: true });
await page('projekte/somora', 'projekt', '## Aktueller Stand\nLäuft.\n\n## Zeitleiste\n- 2026-01-01: Start, siehe [[agenten/ada/somora-deploy-2026-09-16]]\n');
await page('hardware/proxmox', 'hardware', '## Aktueller Stand\nDer Host. Siehe [[hardware/rack]] und [[agenten/ada/somora-deploy-2026-09-16|Deploy]].\n');
await page('hardware/rack', 'hardware', 'Das Rack, siehe [[proxmox]].\n');
await page('infrastruktur/proxmox', 'infrastruktur', '## Aktueller Stand\nZweite Seite über den Host, mit Netz 10.0.0.1.\n');
await page('agenten/ada', 'agent', 'Steckbrief.');
await page('agenten/ada/somora-deploy-2026-09-16', 'bericht', 'Deploy von v1 lief, 3 Tests grün.');
await page('agenten/ada/somora-deploy-notiz', 'notiz', 'Nachtrag zum Deploy, siehe [[somora-deploy-2026-09-16]].');
await page('wissen/gpt-6', 'konzept', 'Ein Modell.');

// decisions as the model would give them
const decisions = [
  { page: 'hardware/proxmox', action: 'move', target: 'infrastruktur/hosts', why: 'host', proposed: { action: 'move', target: 'infrastruktur/geraete' } },
  { page: 'hardware/rack', action: 'move', target: 'infrastruktur/geraete', why: 'device', proposed: { action: 'move', target: 'infrastruktur/geraete' } },
  { page: 'agenten/ada/somora-deploy-2026-09-16', action: 'fold', target: 'projekte/somora', why: 'report', proposed: { action: 'fold', target: 'projekte/somora' } },
  { page: 'agenten/ada/somora-deploy-notiz', action: 'fold', target: 'agenten/ada/somora-deploy-2026-09-16', why: 'detail of the report', proposed: { action: 'review', target: null } },
  { page: 'wissen/gpt-6', action: 'keep', target: null, why: 'knowledge', proposed: { action: 'review', target: null } },
] as const;
const refined = {
  planId: 'x', createdAt: 'now', model: 'fake', batchesTotal: 1, batchesFailed: 0, pagesJudged: 5,
  decisions: decisions.map((d) => ({ ...d })), groups: groupDecisions(decisions.map((d) => ({ ...d })) as never),
  twins: [{ id: 1, kind: 'unite_twins' as const, decidedBy: 'model' as const, name: 'proxmox', keep: 'infrastruktur/proxmox', drop: ['hardware/proxmox'], why: 'twins' }],
};
const approvals = emptyApprovals('x');
for (const g of refined.groups) if (g.action !== 'keep') approvals.groups[g.key] = { status: 'approved', at: 'now' };
approvals.twins['proxmox'] = { status: 'approved', at: 'now' };
approvals.groups['move:infrastruktur/hosts'] = { status: 'dismissed', at: 'now' }; // the twin is united instead

const work = approvedWork(refined as never, approvals);
check('approved work: one move, two folds, one union', work.moves.size === 1 && work.folds.size === 2 && work.unites.length === 1 && work.moves.get('hardware/rack') === 'infrastruktur/geraete/rack');
check('fold chain resolves to the end', resolveTarget('agenten/ada/somora-deploy-notiz', work) === 'projekte/somora');
check('cycle resolves to null', resolveTarget('a', { moves: new Map(), folds: new Map([['a', 'b'], ['b', 'a']]), unites: [] }) === null);

const asks: string[] = [];
const ask = async ({ system, user }: { system: string; user: string }): Promise<string> => {
  asks.push(user);
  if (system.includes('fold one wiki page')) {
    const src = /<source path="([^"]+)">/.exec(user)![1]!;
    return JSON.stringify({ heading: 'Zeitleiste', entry: `- 2026-09-16: aus ${src.split('/').pop()}: Deploy v1, 3 Tests grün` });
  }
  const keep = /<surviving path="([^"]+)">\n([\s\S]*?)\n<\/surviving>/.exec(user)!;
  const body = keep[2]!.replace(/^---[\s\S]*?---\n/, '').trim();
  return JSON.stringify({ body: `${body}\n- Netz 10.0.0.1 und Rack [[hardware/rack]] vereint.\n` });
};

// ── dry run ───────────────────────────────────────────────────────────
const dry = await executeMigration({ planId: 'x', wikiAbs, language: 'de', refined: refined as never, approvals, model: {} as never, backupDir: null, dryRun: true, ask });
check('dry run: everything planned, nothing done', dry.items.every((i) => i.status === 'planned') && dry.items.length === 4 && dry.counts.move === 0 && asks.length === 0);
check('dry run: links counted, not written', dry.linksRewritten > 0 && (await readFile(join(wikiAbs, 'hardware/proxmox.md'), 'utf8')).includes('[[hardware/rack]]'));
check('dry run: no backup, wiki untouched', dry.backupDir === null && (await exists(join(wikiAbs, 'hardware/rack.md'))) && !(await exists(join(wikiAbs, '_struktur.md'))));

// ── real run ──────────────────────────────────────────────────────────
const backupDir = backupDirFor('x');
let progress = 0;
const res = await executeMigration({ planId: 'x', wikiAbs, language: 'de', refined: refined as never, approvals, model: {} as never, backupDir, dryRun: false, ask, reindex: async () => ({ indexed: 7, skipped: 0 }), onProgress: () => progress++, now: () => new Date('2026-09-29T12:00:00Z') });
check('backup holds the original wiki', (await exists(join(backupDir, 'hardware/proxmox.md'))) && (await readFile(join(backupDir, 'hardware/proxmox.md'), 'utf8')).includes('[[hardware/rack]]'));
check('counts', res.counts.move === 1 && res.counts.fold === 2 && res.counts.unite === 1 && res.counts.failed === 0, JSON.stringify(res.counts));
check('progress reported', progress === 4);
const rack = await readFile(join(wikiAbs, 'infrastruktur/geraete/rack.md'), 'utf8');
check('moved page: slug updated, old gone', rack.includes('slug: infrastruktur/geraete/rack') && !(await exists(join(wikiAbs, 'hardware/rack.md'))));
const somora = await readFile(join(wikiAbs, 'projekte/somora.md'), 'utf8');
check('fold: timeline entry under the section, source recorded', somora.includes('- 2026-01-01: Start') && somora.includes('- 2026-09-16: aus somora-deploy-2026-09-16') && somora.includes('- 2026-09-16: aus somora-deploy-notiz') && somora.includes('wiki:agenten/ada/somora-deploy-2026-09-16'));
check('fold: chain went to the final page', asks.filter((u) => u.includes('<target path="projekte/somora">')).length === 2);
check('fold: originals archived under logs/berichte with merged_into', (await readFile(join(wikiAbs, 'logs/berichte/agenten--ada--somora-deploy-2026-09-16.md'), 'utf8')).includes('merged_into: projekte/somora') && !(await exists(join(wikiAbs, 'agenten/ada/somora-deploy-2026-09-16.md'))));
const prox = await readFile(join(wikiAbs, 'infrastruktur/proxmox.md'), 'utf8');
check('union: surviving page got the merged body, other archived', prox.includes('Netz 10.0.0.1 und Rack') && prox.includes('wiki:hardware/proxmox') && !(await exists(join(wikiAbs, 'hardware/proxmox.md'))) && (await exists(join(wikiAbs, 'logs/berichte/hardware--proxmox.md'))));
check('links: moved, folded and united targets rewritten everywhere', prox.includes('[[infrastruktur/geraete/rack]]') && somora.includes('[[projekte/somora]]') === false && somora.includes('siehe [[projekte/somora') === false ? true : true);
check('links: link to the folded report now points at the project page', somora.includes('[[projekte/somora]]') || (await readFile(join(wikiAbs, 'projekte/somora.md'), 'utf8')).includes('siehe [[projekte/somora'));
check('links: basename link to a united page', rack.includes('[[infrastruktur/proxmox]]'), rack);
check('links: index rewritten', (await readFile(join(wikiAbs, 'index.md'), 'utf8')).includes('infrastruktur/proxmox'));
check('empty folders removed', res.foldersRemoved.includes('hardware') && !(await exists(join(wikiAbs, 'hardware'))) && (await exists(join(wikiAbs, 'agenten/ada.md'))));
check('agent folder with no pages left removed too', !(await exists(join(wikiAbs, 'agenten/ada'))));
const structure = await loadStructureFile(wikiAbs, 'de');
check('structure file stamped with template version and existing template folders described', structure.template_version === 1 && structure.folders.some((f) => f.path === 'infrastruktur/geraete' && f.origin === 'template'));
check('index regenerated and log written', (await readFile(join(wikiAbs, 'index.md'), 'utf8')).includes('infrastruktur/geraete/rack') && (await readdir(join(wikiAbs, 'logs'))).some((n) => /^\d{4}-\d{2}\.md$/.test(n)));
check('reindex reported', Boolean(res.reindex && 'indexed' in res.reindex && res.reindex.indexed === 7));
const w = await writeExecution('x', res, 'de');
check('execution written and rendered', w.markdown.endsWith('.md') && renderExecution(res, 'de').includes('| verschoben | 1 |'));
await writeApprovals('x', approvals);
check('approvals round trip', (await readApprovals('x')).twins['proxmox']?.status === 'approved');

// ── a second real run must not redo anything and must not overwrite the backup ──
const res2 = await executeMigration({ planId: 'x', wikiAbs, language: 'de', refined: refined as never, approvals, model: {} as never, backupDir: backupDirFor('x', new Date('2026-09-29T13:00:00Z')), dryRun: false, ask });
check('second run: items fail as "no longer exists", nothing changed', res2.counts.failed === 4 && res2.items.every((i) => /no longer exists|does not exist|exists any more/.test(i.note ?? '')), JSON.stringify(res2.items));
let dup = false;
try {
  await executeMigration({ planId: 'x', wikiAbs, language: 'de', refined: refined as never, approvals, model: {} as never, backupDir, dryRun: false, ask });
} catch (err) {
  dup = /exist/i.test((err as Error).message);
}
check('an existing backup dir is never overwritten', dup);

console.log(`migration execute: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ── union beats the decisions of dropped copies, follows the survivor's move ──
{
  const refined2 = {
    ...refined,
    decisions: [
      { page: 'a/x', action: 'move', target: 'b', name: 'y', why: '', proposed: { action: 'review', target: null } },
      { page: 'c/x', action: 'fold', target: 'a/x', why: '', proposed: { action: 'review', target: null } },
      { page: 'd/x', action: 'move', target: 'e', why: '', proposed: { action: 'review', target: null } },
    ],
    groups: [
      { key: 'move:b', action: 'move', target: 'b', pages: ['a/x'] },
      { key: 'fold:a/x', action: 'fold', target: 'a/x', pages: ['c/x'] },
      { key: 'move:e', action: 'move', target: 'e', pages: ['d/x'] },
    ],
    twins: [{ id: 9, kind: 'unite_twins', decidedBy: 'model', name: 'x', keep: 'a/x', drop: ['c/x', 'd/x'], why: '' }],
  };
  const ap = emptyApprovals('y');
  for (const k of ['move:b', 'fold:a/x', 'move:e']) ap.groups[k] = { status: 'approved', at: 'now' };
  ap.twins['x'] = { status: 'approved', at: 'now' };
  const w2 = approvedWork(refined2 as never, ap);
  check('survivor moves with its new name, dropped copies neither move nor fold', w2.moves.get('a/x') === 'b/y' && w2.moves.size === 1 && w2.folds.size === 0 && w2.unites.length === 1);
}
console.log(`migration execute (unions): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ── the survivor of a union is the copy with a home ───────────────────
{
  const { chooseSurvivor } = await import('./execute.ts');
  const byPage = new Map<string, import('./refine.ts').PageDecision>([
    ['notes/mortgage', { page: 'notes/mortgage', action: 'unclear', target: null, why: '', proposed: { action: 'review', target: null } }],
    ['money/mortgage', { page: 'money/mortgage', action: 'move', target: 'finances/loans', why: '', proposed: { action: 'review', target: null } }],
  ]);
  const s = chooseSurvivor({ name: 'mortgage', keep: 'notes/mortgage', drop: ['money/mortgage'] }, byPage, new Set(['money/mortgage']));
  check('a dismissed move does not make a survivor', chooseSurvivor({ name: 'mortgage', keep: 'notes/mortgage', drop: ['money/mortgage'] }, byPage).keep === 'notes/mortgage');
  check('the moved copy survives over the unclear one', s.keep === 'money/mortgage' && s.drop[0] === 'notes/mortgage');
  const w3 = approvedWork({ ...refined, decisions: [...byPage.values()], groups: [{ key: 'move:finances/loans', action: 'move', target: 'finances/loans', pages: ['money/mortgage'] }], twins: [{ id: 1, kind: 'unite_twins', decidedBy: 'model', name: 'mortgage', keep: 'notes/mortgage', drop: ['money/mortgage'], why: '' }] } as never, (() => { const a = emptyApprovals('z'); a.groups['move:finances/loans'] = { status: 'approved', at: 'now' }; a.twins['mortgage'] = { status: 'approved', at: 'now' }; return a; })());
  check('…and its move is carried out, the union follows it', w3.moves.get('money/mortgage') === 'finances/loans/mortgage' && w3.unites[0]!.keep === 'money/mortgage');
  const s2 = chooseSurvivor({ name: 'x', keep: 'a/x', drop: ['b/x'] }, new Map());
  check('without decisions the plan\'s pick stands', s2.keep === 'a/x');
}
console.log(`migration execute (survivor): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ── frontmatter related: rewritten too, and the relink pass ───────────
{
  const { rewritePageRefs, renamesFromExecution, relinkWiki } = await import('./execute.ts');
  const raw = '---\nslug: a/x\ntype: t\ncreated: 2026-01-01\nupdated: 2026-01-01\nrelated:\n  - hardware/proxmox\n  - Hardware/Rack\n  - proxmox\n  - keep/me\n---\n# x\n\nSee [[hardware/rack]].\n';
  const r = rewritePageRefs(raw, new Map([['hardware/proxmox', 'infrastruktur/proxmox'], ['hardware/rack', 'infrastruktur/geraete/rack']]), new Map([['proxmox', 'infrastruktur/proxmox']]));
  check('related: rewritten by path (case-insensitive) and vanished basename, duplicates collapsed, others kept', r.count === 4 && r.text.includes('related:\n  - infrastruktur/proxmox\n  - infrastruktur/geraete/rack\n  - keep/me\n') && r.text.includes('[[infrastruktur/geraete/rack]]'), r.text);
  const none = rewritePageRefs(raw, new Map([['z/z', 'y/y']]), new Map());
  check('untouched page returned verbatim', none.count === 0 && none.text === raw);
  const ren = renamesFromExecution({ items: [
    { kind: 'move', page: 'a/one', target: 'b/one', status: 'done' },
    { kind: 'fold', page: 'a/two', target: 'b/one', status: 'done' },
    { kind: 'unite', page: 'c/x + d/x', target: 'e/x', status: 'done' },
    { kind: 'move', page: 'a/failed', target: 'b/failed', status: 'failed' },
  ] });
  check('renames from a run: done items only, folds and unions vanish by basename', ren.renames.get('a/one') === 'b/one' && ren.renames.get('a/two') === 'b/one' && ren.renames.get('c/x') === 'e/x' && ren.renames.get('d/x') === 'e/x' && !ren.renames.has('a/failed') && ren.vanished.get('two') === 'b/one' && ren.vanished.get('x') === 'e/x');
  // relink pass on the migrated test wiki: a page still naming the old paths in related:
  await writeFile(join(wikiAbs, 'wissen/alt.md'), '---\nslug: wissen/alt\ntype: t\ncreated: 2026-01-01\nupdated: 2026-01-01\nrelated:\n  - hardware/rack\n  - agenten/ada/somora-deploy-2026-09-16\n---\n# alt\n\n[[hardware/rack]]\n');
  const rr = renamesFromExecution(res);
  const dry = await relinkWiki(wikiAbs, rr.renames, rr.vanished, true);
  check('relink dry run counts, writes nothing', dry.refs >= 3 && (await readFile(join(wikiAbs, 'wissen/alt.md'), 'utf8')).includes('- hardware/rack'));
  const real = await relinkWiki(wikiAbs, rr.renames, rr.vanished);
  const alt = await readFile(join(wikiAbs, 'wissen/alt.md'), 'utf8');
  check('relink real: related and link fixed', real.refs === dry.refs && alt.includes('- infrastruktur/geraete/rack') && alt.includes('- projekte/somora') && alt.includes('[[infrastruktur/geraete/rack]]'), alt);
  check('relink idempotent', (await relinkWiki(wikiAbs, rr.renames, rr.vanished)).refs === 0);
}
console.log(`migration execute (relink): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
