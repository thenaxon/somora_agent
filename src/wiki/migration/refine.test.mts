// The migration's model step with a fake model: every page the plan is
// unsure about is judged, answers are checked against the wiki
// (unknown folders and pages become "unclear"), grouped for approval —
// and still nothing is written into the wiki.
//
// Run: npx tsx src/wiki/migration/refine.test.mts

import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-refine-home-'));
const { analyzeWiki } = await import('./analyze.ts');
const { refinePlan, parseRefineReply, pagesToJudge, entityIndex, groupDecisions, renderRefinedPlan, buildRefineSystemPrompt } = await import('./refine.ts');
const { readInventory } = await import('./analyze.ts');
const { writePlan, writeRefinedPlan, readRefinedPlan } = await import('./store.ts');
const { emptyStructure } = await import('../structure-file.ts');
const { buildWikiMap } = await import('../map.ts');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
};

const wikiAbs = await mkdtemp(join(tmpdir(), 'somora-refine-wiki-'));
const page = async (rel: string, type: string, body: string): Promise<void> => {
  await mkdir(join(wikiAbs, rel, '..'), { recursive: true });
  await writeFile(join(wikiAbs, `${rel}.md`), `---\nslug: ${rel}\ntype: ${type}\n---\n# ${rel.split('/').pop()}\n${body}\n`);
};
await page('personen/anna', 'person', 'Anna.');
await page('unternehmen/enovom', 'unternehmen', 'Firma.');
await page('projekte/somora', 'projekt', 'Das Projekt.');
await page('hardware/valve-index', 'hardware', 'Ein VR-Headset.');
await page('hardware/rack-umzug-2026', 'projekt', 'Der Umzug des Racks war ein Vorhaben.');
await page('agenten/hans', 'agent', 'Steckbrief.');
await page('agenten/hans/somora-deploy-2026-09-16', 'bericht', 'Deploy lief.');
await page('wissen/gpt-6', 'konzept', 'Ein Modell.');
await page('wissen/enovom-bilanz-2025', 'konzept', 'Bilanz der Firma.');

const structure = emptyStructure('de');
const plan = await analyzeWiki({ wikiAbs, language: 'de', structure });
const inv = await readInventory(wikiAbs);
const judged = pagesToJudge(plan, new Map(inv.pages.map((p) => [p.path, p])));
const paths = judged.map((j) => j.page.path).sort();
check('pages to judge: every page but the agent profile', paths.join(',') === ['agenten/hans/somora-deploy-2026-09-16', 'hardware/rack-umzug-2026', 'hardware/valve-index', 'personen/anna', 'projekte/somora', 'unternehmen/enovom', 'wissen/enovom-bilanz-2025', 'wissen/gpt-6'].join(','), paths.join(','));
check('proposals carried', judged.find((j) => j.page.path === 'hardware/valve-index')?.proposed.target === 'infrastruktur/geraete' && judged.find((j) => j.page.path === 'agenten/hans/somora-deploy-2026-09-16')?.proposed.action === 'fold');
const ent = entityIndex(inv.pages);
check('entity index lists entity pages only', ent.includes('unternehmen/: enovom') && ent.includes('projekte/: somora') && !ent.includes('gpt-6') && !ent.includes('somora-deploy'));
check('system prompt names the four actions', /"keep"/.test(buildRefineSystemPrompt('de')) && buildRefineSystemPrompt('en').includes('knowledge'));

const map = await buildWikiMap({ wikiAbs, language: 'de', structure });
const known = { folders: new Set([...map.folders.map((f) => f.path), ...map.planned.map((p) => p.path)]), pages: new Set(inv.pages.map((p) => p.path)) };
const batch = judged;
const reply = JSON.stringify([
  { page: 'hardware/valve-index', action: 'move', target: 'infrastruktur/geraete', why: 'a device' },
  { page: 'hardware/rack-umzug-2026', action: 'move', target: 'projekte', why: 'a project' },
  { page: 'agenten/hans/somora-deploy-2026-09-16', action: 'fold', target: 'projekte/somora', why: 'dated report' },
  { page: 'wissen/gpt-6', action: 'keep', why: 'knowledge' },
  { page: 'wissen/enovom-bilanz-2025', action: 'fold', target: 'unternehmen/enovom-gmbh', why: 'detail of the company' },
]);
const d = parseRefineReply(`Here you go:\n${reply}\nDone.`, batch, known);
const byPage = new Map(d.map((x) => [x.page, x]));
check('move to a proposed template folder accepted', byPage.get('hardware/valve-index')?.action === 'move' && byPage.get('hardware/valve-index')?.target === 'infrastruktur/geraete');
check('move to an existing folder accepted', byPage.get('hardware/rack-umzug-2026')?.action === 'move' && byPage.get('hardware/rack-umzug-2026')?.target === 'projekte');
check('fold into an existing page accepted', byPage.get('agenten/hans/somora-deploy-2026-09-16')?.action === 'fold' && byPage.get('agenten/hans/somora-deploy-2026-09-16')?.target === 'projekte/somora');
check('fold into a page that does not exist → unclear, corrected', byPage.get('wissen/enovom-bilanz-2025')?.action === 'unclear' && /unknown page/.test(byPage.get('wissen/enovom-bilanz-2025')?.corrected ?? ''));
check('keep', byPage.get('wissen/gpt-6')?.action === 'keep');
const d2 = parseRefineReply('[{"page":"wissen/gpt-6","action":"move","target":"fahrzeuge"}]', batch.filter((j) => j.page.path === 'wissen/gpt-6'), known);
check('move to an unknown folder → unclear', d2[0]!.action === 'unclear' && /unknown folder/.test(d2[0]!.corrected ?? ''));
const d3 = parseRefineReply('garbage', batch.slice(0, 2), known);
check('unreadable reply → every page unclear', d3.every((x) => x.action === 'unclear' && x.corrected === 'missing'));
const d4 = parseRefineReply('[{"page":"wissen/gpt-6","action":"move","target":"wissen"}]', batch.filter((j) => j.page.path === 'wissen/gpt-6'), known);
check('move to own folder = keep', d4[0]!.action === 'keep');

const groups = groupDecisions(d);
check('groups: moves first, then folds, keeps, unclear', groups[0]!.action === 'move' && groups.map((g) => g.action).join(',') === 'move,move,fold,keep,unclear', groups.map((g) => g.key).join(' '));

// full run with a fake model over two batches
const calls: string[] = [];
const refined = await refinePlan({
  plan, planId: 'test-2', wikiAbs, language: 'de', map, model: { providerName: 'fake', modelId: 'judge' } as never, batchSize: 3,
  ask: async ({ user }) => {
    calls.push(user);
    const pages = [...user.matchAll(/<page path="([^"]+)"/g)].map((m) => m[1]!);
    if (calls.length === 2) throw new Error('model down');
    return JSON.stringify(pages.map((p) => ({ page: p, action: 'keep', why: 'fine' })));
  },
});
check('three batches, one failed, every page answered', refined.batchesTotal === 3 && refined.batchesFailed === 1 && refined.pagesJudged === 8 && refined.decisions.filter((x) => x.corrected === 'batch failed').length === 3);
check('prompt carries the map, the entity names and the first lines', calls[0]!.includes('<wiki_map>') && calls[0]!.includes('<entity_pages>') && calls[0]!.includes('Ein VR-Headset.') && calls[0]!.includes('proposal="move → infrastruktur/geraete"'));
check('twins carried over', Array.isArray(refined.twins));
await writePlan(plan, 'test-2');
const w = await writeRefinedPlan('test-2', refined, 'de');
const back = await readRefinedPlan('test-2');
check('refined plan round trip', back?.pagesJudged === 8 && w.markdown.endsWith('refined.md'));
const md = renderRefinedPlan(refined, 'de');
check('markdown lists the failed batch and the keeps by folder', md.includes('(1 fehlgeschlagen)') && md.includes('## Bleibt in') && md.includes('## Unklar'));
const top = (await readdir(wikiAbs)).filter((n) => n.startsWith('_') || n.startsWith('.'));
check('wiki untouched', top.length === 0, top.join(','));

console.log(`migration refine: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ── new name on a move, keep only where described ─────────────────────
{
  const known2 = { ...known, described: new Set(['infrastruktur/geraete', 'projekte', 'wissen', 'personen', 'unternehmen', 'agenten']) };
  const b = batch.filter((j) => j.page.path === 'hardware/rack-umzug-2026' || j.page.path === 'wissen/gpt-6');
  const d5 = parseRefineReply(JSON.stringify([
    { page: 'hardware/rack-umzug-2026', action: 'move', target: 'projekte', name: 'Rack-Umzug 2026', why: 'x' },
    { page: 'wissen/gpt-6', action: 'keep', why: 'k' },
  ]), b, known2);
  check('a name that is not a slug is dropped', d5[0]!.action === 'move' && d5[0]!.name === undefined);
  const d6 = parseRefineReply(JSON.stringify([{ page: 'hardware/rack-umzug-2026', action: 'move', target: 'projekte', name: 'rack-umzug', why: 'x' }]), b.slice(0, 1), known2);
  check('a slug name is kept', d6[0]!.name === 'rack-umzug');
  const d7 = parseRefineReply(JSON.stringify([{ page: 'hardware/rack-umzug-2026', action: 'keep', why: 'k' }]), b.slice(0, 1), known2);
  check('keep in an undescribed folder → unclear', d7[0]!.action === 'unclear' && d7[0]!.corrected === 'keep in undescribed folder');
  const d8 = parseRefineReply(JSON.stringify([{ page: 'hardware/rack-umzug-2026', action: 'move', target: 'hardware', name: 'rack-umzug', why: 'rename in place' }]), b.slice(0, 1), known2);
  check('move to own folder with a new name is a move', d8[0]!.action === 'move' && d8[0]!.target === 'hardware' && d8[0]!.name === 'rack-umzug');
  check('keep in a described folder stays', d5[1]!.action === 'keep');
}
console.log(`migration refine (names): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
