// The migration plan on a small grown wiki: rule moves, twins, dated
// reports folded into their project, per-page reviews — and not one
// write into the wiki.
//
// Run: npx tsx src/wiki/migration/analyze.test.mts

import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-migration-home-'));
const { analyzeWiki, renderPlan, ruleTarget } = await import('./analyze.ts');
const { writePlan, MIGRATION_ROOT } = await import('./store.ts');
const { emptyStructure } = await import('../structure-file.ts');
const { taxonomyFor, taxonomyPaths } = await import('../taxonomy.ts');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
};

const wikiAbs = await mkdtemp(join(tmpdir(), 'somora-migration-wiki-'));
const page = async (rel: string, type = 'konzept', body = 'x'): Promise<void> => {
  await mkdir(join(wikiAbs, rel, '..'), { recursive: true });
  await writeFile(join(wikiAbs, `${rel}.md`), `---\nslug: ${rel}\ntype: ${type}\n---\n# ${rel.split('/').pop()}\n${body}\n`);
};
await writeFile(join(wikiAbs, 'index.md'), '# Index\n');
await mkdir(join(wikiAbs, 'logs'), { recursive: true });
await writeFile(join(wikiAbs, 'logs/2026-09.md'), '- x\n');
await page('personen/anna', 'person');
await page('aktien/nvidia', 'aktie');
await page('hardware/proxmox', 'hardware', 'gross '.repeat(50));
await page('infrastruktur/proxmox', 'infrastruktur');
await page('projekte/somora', 'projekt');
await page('projekte/somora/roadmap', 'konzept');
await page('agenten/hans', 'agent');
await page('agenten/hans/somora-deploy-2026-09-16', 'bericht');
await page('agenten/hans/notiz-ohne-datum', 'konzept');
await page('wissen/gpt-6', 'konzept');
await page('wissen/somora-turns-2026-08-01', 'konzept');
await page('angebote/beamer', 'angebot');
await page('readme', 'konzept');

const t = taxonomyFor('de');
const tp = new Set(taxonomyPaths(t));
check('rule: alias', ruleTarget('aktien', t, tp) === 'finanzen/depot' && ruleTarget('hardware/cerebro', t, tp) === 'infrastruktur/geraete');
check('rule: template path stays', ruleTarget('personen', t, tp) === 'personen' && ruleTarget('wissen/konzepte', t, tp) === 'wissen/konzepte');
check('rule: none', ruleTarget('angebote', t, tp) === null && ruleTarget('agenten/hans', t, tp) === null);
check('en aliases exist', Object.keys(taxonomyFor('en').aliases).length > 20 && taxonomyFor('en').aliases.stocks === 'finances/portfolio');
check('every alias target is a template path', Object.values(t.aliases).every((v) => tp.has(v)) && Object.values(taxonomyFor('en').aliases).every((v) => new Set(taxonomyPaths(taxonomyFor('en'))).has(v)));

const plan = await analyzeWiki({ wikiAbs, language: 'de', structure: emptyStructure('de'), now: new Date('2026-09-29T12:00:00Z') });
const of = <K extends (typeof plan.items)[number]['kind']>(kind: K) => plan.items.filter((i): i is Extract<(typeof plan.items)[number], { kind: K }> => i.kind === kind);
check('pages counted, logs and index skipped', plan.pagesTotal === 13, String(plan.pagesTotal));
const moves = of('move_folder');
check('rule move aktien → finanzen/depot', moves.some((m) => m.from === 'aktien' && m.to === 'finanzen/depot' && m.pages[0] === 'aktien/nvidia'));
check('twin page is judged as well (the survivor may need a move)', moves.some((m) => m.pages.includes('hardware/proxmox')));
const twins = of('unite_twins');
check('twins: keep the copy in the template folder', twins.length === 1 && twins[0]!.keep === 'infrastruktur/proxmox' && twins[0]!.drop[0] === 'hardware/proxmox');
const reports = of('fold_report');
check('dated report folded into its project by name', reports.some((r) => r.page === 'agenten/hans/somora-deploy-2026-09-16' && r.into === 'projekte/somora'));
check('dated knowledge page is a report too', reports.some((r) => r.page === 'wissen/somora-turns-2026-08-01' && r.into === 'projekte/somora'));
const reviews = of('review_pages');
check('agent folder reviewed without the report', reviews.some((r) => r.folder === 'agenten/hans' && r.pages.length === 1 && r.pages[0] === 'agenten/hans/notiz-ohne-datum'));
check('wissen reviewed without the dated page', reviews.some((r) => r.folder === 'wissen' && r.pages.length === 1));
check('project sub-pages reviewed', reviews.some((r) => r.folder === 'projekte/somora'));
check('unknown folder reviewed, not moved', reviews.some((r) => r.folder === 'angebote') && !moves.some((m) => m.from === 'angebote'));
check('agent profile page stays untouched', !plan.items.some((i) => i.kind !== 'review_pages' && JSON.stringify(i).includes('"agenten/hans"')) && !reviews.some((r) => r.folder === 'agenten'));
check('person page reviewed too, not moved', reviews.some((r) => r.folder === 'personen' && r.pages[0] === 'personen/anna') && !plan.items.some((i) => i.kind !== 'review_pages' && JSON.stringify(i).includes('personen/anna')));
check('root page unclear', of('unclear').some((u) => u.pages.includes('readme')));
check('summary adds up', plan.summary.move_folder.pages === 2 && plan.summary.unite_twins.pages === 2 && plan.summary.fold_report.items === 2);

const md = renderPlan(plan);
check('markdown: title, table, sections', md.startsWith('# Migrationsplan') && md.includes('| Ordner nach Regel verschieben | 2 | 2 | rule |') && md.includes('`aktien/` → `finanzen/depot/`'));
const w = await writePlan(plan, 'test-1');
check('plan written under SOMORA_HOME', w.dir.startsWith(MIGRATION_ROOT) && (await readdir(w.dir)).sort().join(',') === 'plan.json,plan.md');
// nothing written into the wiki
const top = (await readdir(wikiAbs)).filter((n) => n.startsWith('_') || n.startsWith('.'));
check('wiki untouched', top.length === 0, top.join(','));

console.log(`migration analyze: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
