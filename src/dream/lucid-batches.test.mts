// Lucid cuts the wiki into calls by size: a grown wiki with many small
// folders and a migrated one with three big folders both end up in
// batches under the limit, every page in exactly one batch, a page
// larger than the limit alone, and each batch sees its siblings by name.
//
// Run: npx tsx src/dream/lucid-batches.test.mts

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-lucid-batches-'));
const { planLucidBatches, batchLabel, siblingList, pageOpening, folderOf } = await import('./lucid-batches.ts');
const { buildBatchUserMessage, buildCrossSubfolderUserMessage } = await import('./lucid-runner.ts');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
};
const page = (path: string, chars: number): { wikiPath: string; markdown: string } => ({ wikiPath: path, markdown: `---\nslug: ${path}\n---\n# ${path.split('/').pop()}\n\n${'x'.repeat(Math.max(0, chars - 40))}\n` });

// grown: 71 folders × a few small pages
const grown = [] as ReturnType<typeof page>[];
for (let f = 0; f < 71; f++) for (let p = 0; p < 3; p++) grown.push(page(`ordner${String(f).padStart(2, '0')}/seite-${p}`, 2000));
grown.push(page('readme', 500));
const g = planLucidBatches(grown, 100_000);
check('grown: one batch per folder, root pages batched too', g.length === 72 && g.every((b) => b.of === 1) && g.some((b) => b.folder === '(root)' && b.pages[0]!.wikiPath === 'readme'));
check('grown: every page once', g.reduce((n, b) => n + b.pages.length, 0) === grown.length);

// migrated: three big folders, one giant page, subfolders
const migrated = [] as ReturnType<typeof page>[];
for (let p = 0; p < 65; p++) migrated.push(page(`projekte/p-${String(p).padStart(2, '0')}`, 8000));
migrated.push(page('projekte/somora', 105_000));
for (let p = 0; p < 30; p++) migrated.push(page(`infrastruktur/hosts/h-${p}`, 6000));
for (let p = 0; p < 20; p++) migrated.push(page(`infrastruktur/geraete/g-${p}`, 6000));
for (let p = 0; p < 5; p++) migrated.push(page(`personen/x-${p}`, 1000));
const m = planLucidBatches(migrated, 100_000);
check('migrated: no batch over the limit except a single giant page', m.every((b) => b.chars <= 100_000 || b.pages.length === 1));
check('migrated: giant page travels alone', m.some((b) => b.pages.length === 1 && b.pages[0]!.wikiPath === 'projekte/somora'));
const pj = m.filter((b) => b.folder === 'projekte');
check('migrated: projekte cut into parts, numbered', pj.length >= 6 && pj.every((b) => b.of === pj.length) && pj.map((b) => b.part).join(',') === pj.map((_, i) => i + 1).join(','));
check('migrated: subfolders are their own batches', m.some((b) => b.folder === 'infrastruktur/hosts' && b.of === 2) && m.some((b) => b.folder === 'infrastruktur/geraete' && b.of === 2));
check('migrated: every page once', m.reduce((n, b) => n + b.pages.length, 0) === migrated.length);
check('labels', batchLabel(pj[0]!) === `projekte (1/${pj.length})` && batchLabel(m.find((b) => b.folder === 'personen')!) === 'personen');
check('order reproducible', m.map((b) => b.folder).join(',') === [...m.map((b) => b.folder)].sort((a, b) => a.localeCompare(b)).join(','));

// siblings + message
const first = pj[0]!;
const sib = siblingList(first, migrated);
check('siblings: rest of the top folder by name, not the batch itself', sib.includes('[[projekte/somora]]') && !sib.includes(`[[${first.pages[0]!.wikiPath}]]`) && !sib.includes('infrastruktur/'));
const hosts = m.find((b) => b.folder === 'infrastruktur/hosts')!;
check('siblings: subfolder batch sees the whole top folder', siblingList(hosts, migrated).includes('[[infrastruktur/geraete/g-0]]'));
const msg = buildBatchUserMessage('<wiki_map>\nMAP\n</wiki_map>', first, migrated);
check('message: folder, part, map, siblings, pages; no index', msg.includes(`Folder under review: projekte/ — part 1 of ${pj.length}`) && msg.includes('<wiki_map>') && msg.includes('<sibling_pages folder="projekte">') && msg.includes(`<wiki_page slug="${first.pages[0]!.wikiPath}">`) && !msg.includes('<wiki_index>'));
check('message size stays near the batch size', msg.length < first.chars + 40_000, String(msg.length));

// cross pass shrinks openings to fit
const by = new Map<string, ReturnType<typeof page>[]>();
for (const p of migrated) by.set(folderOf(p.wikiPath).split('/')[0]!, [...(by.get(folderOf(p.wikiPath).split('/')[0]!) ?? []), p]);
const big = buildCrossSubfolderUserMessage('<wiki_map>\nMAP\n</wiki_map>', by, 1_000_000);
const small = buildCrossSubfolderUserMessage('<wiki_map>\nMAP\n</wiki_map>', by, 12_000);
check('cross pass: map instead of index, headers for every page', big.includes('<wiki_map>') && !big.includes('<wiki_index>') && big.includes('[[projekte/somora]]') && big.includes('[[personen/x-4]]'));
check('cross pass: openings shortened when the limit is tight', small.length < big.length);
check('opening: frontmatter and title stripped', pageOpening('---\nslug: a\n---\n# Title\n\n## Stand\nErster Satz. Zweiter.\n', 12) === 'Erster Satz.…');

console.log(`lucid batches: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
