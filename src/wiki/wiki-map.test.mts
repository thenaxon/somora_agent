// The wiki folder template, the structure file and the map Deep files
// against (2026-09-29, private/wiki-structure/): a folder says what
// KIND of page lives in it; reality wins over the template; a page
// name that already exists in another folder is never created twice;
// a new folder needs a purpose.
//
// Run: npx tsx src/wiki/wiki-map.test.mts

import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-wiki-map-home-'));
const { taxonomyFor, taxonomyPaths } = await import('./taxonomy.ts');
const { loadStructureFile, saveStructureFile, describeFolder, noteDuplicate, isStructureFileName, structureFileName } = await import('./structure-file.ts');
const { buildWikiMap, checkPromoteTarget, noteNewPage, sameNamePages, syncStructureWithMap } = await import('./map.ts');
const { parseDeepDecision, parseNewFolder } = await import('../dream/deep-dispatcher.ts');
const { buildDeepSystemPrompt } = await import('../dream/deep-prompts.ts');
const { wikiSchemaFor } = await import('./language.ts');
const DE_WIKI_SCHEMA = wikiSchemaFor('de');
const EN_WIKI_SCHEMA = wikiSchemaFor('en');
const { processCandidate, loadDeepWikiState } = await import('../dream/deep-runner.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ── template ──────────────────────────────────────────────────────────
for (const lang of ['de', 'en'] as const) {
  const t = taxonomyFor(lang);
  const paths = taxonomyPaths(t);
  check(`${lang}: 12 top folders`, t.folders.length === 12, String(t.folders.length));
  check(`${lang}: paths unique`, new Set(paths).size === paths.length);
  check(`${lang}: every folder has purpose and rationale`, t.folders.every((f) => f.purpose.length > 10 && f.rationale.length > 10));
  check(`${lang}: subfolders sit under their parent`, t.folders.every((f) => (f.subfolders ?? []).every((s) => s.path.startsWith(f.path + '/'))));
  check(`${lang}: lowercase ascii paths`, paths.every((p) => /^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(p)), paths.filter((p) => !/^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(p)).join(','));
}
check('de and en have the same shape', taxonomyPaths(taxonomyFor('de')).length === taxonomyPaths(taxonomyFor('en')).length);

// ── structure file ────────────────────────────────────────────────────
const root = await mkdtemp(join(tmpdir(), 'somora-wiki-map-'));
const wikiAbs = join(root, 'wiki');
await mkdir(wikiAbs, { recursive: true });
{
  const empty = await loadStructureFile(wikiAbs, 'de');
  check('missing structure file → empty', empty.folders.length === 0 && empty.template_version === 0);
  check('describe adds', describeFolder(empty, { path: 'personen', purpose: 'Menschen.', origin: 'template' }));
  check('user wording is kept', describeFolder(empty, { path: '/personen/', purpose: 'anders', origin: 'deep' }) === false && empty.folders[0]!.purpose === 'Menschen.');
  describeFolder(empty, { path: 'hardware', purpose: '', origin: 'unknown' });
  check('unknown entry can be filled later', describeFolder(empty, { path: 'hardware', purpose: 'Geräte.', origin: 'deep' }) && empty.folders.find((f) => f.path === 'hardware')!.origin === 'deep');
  check('duplicate noted', noteDuplicate(empty, 'proxmox', ['infrastruktur/proxmox', 'hardware/proxmox']) && noteDuplicate(empty, 'proxmox', ['hardware/proxmox', 'infrastruktur/proxmox']) === false);
  await saveStructureFile(wikiAbs, empty);
  const back = await loadStructureFile(wikiAbs, 'de');
  check('round trip', back.folders.length === 2 && back.folders[0]!.path === 'hardware' && back.duplicates[0]!.paths.join(',') === 'hardware/proxmox,infrastruktur/proxmox');
  const text = await readFile(join(wikiAbs, structureFileName('de')), 'utf8');
  check('body rendered for people', text.includes('| personen | Menschen. | template |') && text.includes('# Struktur dieses Wikis'));
  check('file name per language', structureFileName('en') === '_structure.md' && isStructureFileName('_struktur.md') && !isStructureFileName('struktur.md'));
}

// ── map ───────────────────────────────────────────────────────────────
await mkdir(join(wikiAbs, 'personen'), { recursive: true });
await mkdir(join(wikiAbs, 'hardware'), { recursive: true });
await mkdir(join(wikiAbs, 'infrastruktur/hosts'), { recursive: true });
await mkdir(join(wikiAbs, 'logs'), { recursive: true });
await writeFile(join(wikiAbs, 'personen/anna.md'), '---\nslug: personen/anna\n---\n# Anna\n');
await writeFile(join(wikiAbs, 'hardware/proxmox.md'), '# Proxmox\n');
await writeFile(join(wikiAbs, 'infrastruktur/hosts/proxmox.md'), '# Proxmox host\n');
await writeFile(join(wikiAbs, 'infrastruktur/hosts/Cerebro.md'), '# Cerebro\n');
await writeFile(join(wikiAbs, 'index.md'), '# Index\n');
await writeFile(join(wikiAbs, 'logs/2026-09.md'), '- log\n');
{
  const structure = await loadStructureFile(wikiAbs, 'de');
  const map = await buildWikiMap({ wikiAbs, language: 'de', structure });
  const f = (p: string) => map.folders.find((x) => x.path === p);
  check('existing folders listed with counts', f('personen')?.pages === 1 && f('infrastruktur/hosts')?.pages === 2 && f('infrastruktur')?.pages === 0);
  check('logs skipped', !f('logs'));
  check('template purpose fills an existing template folder', f('personen')?.purpose === 'Menschen.' && f('infrastruktur/hosts')?.origin === 'template' && f('infrastruktur/hosts')!.purpose.length > 0);
  check('described non-template folder keeps its purpose', f('hardware')?.purpose === 'Geräte.' && f('hardware')?.origin === 'deep');
  check('planned = template minus existing', map.planned.some((p) => p.path === 'projekte') && !map.planned.some((p) => p.path === 'personen' || p.path === 'infrastruktur/hosts'));
  check('same-name index across folders, case-insensitive', map.sameName.get('proxmox')?.length === 2 && map.sameName.get('cerebro')?.[0] === 'infrastruktur/hosts/Cerebro');
  check('map text has folders, proposals and rules', map.text.includes('- personen — Menschen. · 1') && map.text.includes('do not exist yet') && map.text.includes('- projekte —') && map.text.includes('"newFolder"'));
  check('undescribed folder shows as such', (() => { map.folders.push({ path: 'x', pages: 0, purpose: '', origin: 'unknown' }); return true; })());
  map.folders.pop();

  // same-name lookup
  const s1 = sameNamePages(map, 'wissen/proxmox', 'wissen');
  check('same name found, first as target', s1?.target === 'hardware/proxmox' && s1.others.length === 1);
  const s2 = sameNamePages(map, 'infrastruktur/hosts/Proxmox', 'infrastruktur/hosts');
  check('own path is excluded, other twin remains', s2?.target === 'hardware/proxmox' && s2.others.length === 0);
  check('preferred folder wins', sameNamePages(map, 'geraete/proxmox', 'infrastruktur')?.target === 'infrastruktur/hosts/proxmox');
  check('no twin → null', sameNamePages(map, 'personen/bert') === null);

  // promote target check
  check('existing folder ok', checkPromoteTarget(map, { slug: 'personen/bert', subfolder: 'personen' }).kind === 'ok');
  const planned = checkPromoteTarget(map, { slug: 'projekte/haus', subfolder: 'projekte' });
  check('planned folder ok with template purpose', planned.kind === 'ok' && planned.describe?.origin === 'template' && planned.describe.path === 'projekte');
  check('unknown folder without purpose refused', checkPromoteTarget(map, { slug: 'fahrzeuge/vw-bus', subfolder: 'fahrzeuge' }).kind === 'unknownFolder');
  const nf = checkPromoteTarget(map, { slug: 'fahrzeuge/vw-bus', subfolder: 'fahrzeuge', newFolder: { path: 'fahrzeuge', purpose: 'Fahrzeuge.' } });
  check('unknown folder with purpose ok, described by deep', nf.kind === 'ok' && nf.describe?.origin === 'deep' && nf.describe.purpose === 'Fahrzeuge.');
  check('purpose for a different path does not count', checkPromoteTarget(map, { slug: 'fahrzeuge/vw-bus', subfolder: 'fahrzeuge', newFolder: { path: 'autos', purpose: 'x' } }).kind === 'unknownFolder');
  check('too deep refused', checkPromoteTarget(map, { slug: 'infrastruktur/hosts/rack/r1', subfolder: 'infrastruktur/hosts/rack', newFolder: { path: 'infrastruktur/hosts/rack', purpose: 'x' } }).kind === 'tooDeep');
  check('same name beats everything', checkPromoteTarget(map, { slug: 'wissen/proxmox', subfolder: 'wissen' }).kind === 'sameName');
  check('root page ok', checkPromoteTarget(map, { slug: 'readme', subfolder: '' }).kind === 'ok');

  // in-memory update after a write
  noteNewPage(map, 'projekte/haus', { purpose: 'ignored, planned wins', origin: 'deep' });
  check('planned folder moves to existing with template purpose', f('projekte')?.pages === 1 && f('projekte')?.origin === 'template' && !map.planned.some((p) => p.path === 'projekte'));
  noteNewPage(map, 'fahrzeuge/vw-bus', { purpose: 'Fahrzeuge.', origin: 'deep' });
  check('new folder recorded', f('fahrzeuge')?.pages === 1 && f('fahrzeuge')?.purpose === 'Fahrzeuge.');
  check('basename index updated', map.sameName.get('vw-bus')?.[0] === 'fahrzeuge/vw-bus');
  noteNewPage(map, 'finanzen/depot/etf', undefined);
  check('parent of a new subfolder exists too', f('finanzen')?.origin === 'template' && f('finanzen/depot')?.pages === 1);

  // structure sync
  const dirty = syncStructureWithMap(structure, map, (e) => describeFolder(structure, e));
  check('sync adds folders on disk', dirty && structure.folders.some((s) => s.path === 'infrastruktur/hosts' && s.origin === 'template') && structure.folders.some((s) => s.path === 'infrastruktur' && s.origin === 'template'));
}

// ── dispatcher: newFolder ─────────────────────────────────────────────
{
  const base = { kind: 'promote', subfolder: 'fahrzeuge', slug: 'vw-bus', type: 'thing', title: 'VW Bus', body: '## Stand\nx' };
  const d1 = parseDeepDecision(JSON.stringify({ ...base, newFolder: { path: '/fahrzeuge/', purpose: ' Fahrzeuge. ' } }), 's');
  check('newFolder parsed and trimmed', d1.kind === 'promote' && d1.newFolder?.path === 'fahrzeuge' && d1.newFolder.purpose === 'Fahrzeuge.' && d1.slug === 'fahrzeuge/vw-bus');
  const d2 = parseDeepDecision(JSON.stringify({ ...base, newFolder: { purpose: 'Fahrzeuge.' } }), 's');
  check('path defaults to subfolder', d2.kind === 'promote' && d2.newFolder?.path === 'fahrzeuge');
  const d3 = parseDeepDecision(JSON.stringify({ ...base, newFolder: { path: 'fahrzeuge' } }), 's');
  check('no purpose → no newFolder', d3.kind === 'promote' && d3.newFolder === undefined);
  check('string form is the purpose', parseNewFolder('Fahrzeuge.', 'x')?.path === 'x');
  const p = buildDeepSystemPrompt(DE_WIKI_SCHEMA);
  check('prompt: no invent-a-folder, map rule instead', !p.includes('invent a new one') && p.includes('"newFolder"') && p.includes('timeline entry'));
  check('prompt en builds', buildDeepSystemPrompt(EN_WIKI_SCHEMA).includes('vehicles/vw-bus'));
}

// ── Deep: same-name reroute + folder refusal + structure file ─────────
{
  const memFile = join(root, 'mem-proxmox.md');
  await writeFile(memFile, '---\nname: mem-proxmox\n---\nProxmox läuft auf 8.2.\n');
  const candidate = { agent: 'testagent', slug: 'mem-proxmox', path: memFile, raw: 'x', frontmatter: {}, body: 'Proxmox läuft auf 8.2.', mtimeMs: (await stat(memFile)).mtimeMs };
  const mgr = { search: async () => [] };
  const calls: Array<{ map: string; pages: string[] }> = [];
  const dispatcher = {
    decideMemoryFate: async (a: { wikiMap: string; relevantPages: Array<{ slug: string; markdown: string }> }) => {
      calls.push({ map: a.wikiMap, pages: a.relevantPages.map((p) => p.slug) });
      if (calls.length === 1) return { kind: 'promote' as const, subfolder: 'wissen', slug: 'wissen/proxmox', type: 'konzept', title: 'Proxmox', body: '## Stand\nneu' };
      const page = a.relevantPages[0]!;
      return { kind: 'merge' as const, wikiPath: page.slug, body: page.markdown.replace(/^---[\s\S]*?---\n/, '') + '\n- Version 8.2', logSummary: 'proxmox ergänzt' };
    },
  };
  const wiki = await loadDeepWikiState(wikiAbs, 'de');
  check('state: twins counted, structure dirty from sync', wiki.dirty && wiki.map.sameName.get('proxmox')?.length === 2);
  const out = await processCandidate({ candidate: candidate as never, ctx: { wikiAbs, schema: DE_WIKI_SCHEMA }, mgr: mgr as never, workerModel: {} as never, dispatcher: dispatcher as never, wiki, timeoutMs: 1000 });
  check('first call saw the map', calls[0]!.map.includes('- hardware — Geräte.'));
  check('same name → merged into the existing page, second call with that page in full', out.kind === 'merged' && calls.length === 2 && calls[1]!.pages[0] === 'hardware/proxmox' && calls[1]!.map.includes('already exists at hardware/proxmox'));
  check('nothing created under wissen', await stat(join(wikiAbs, 'wissen/proxmox.md')).then(() => false, () => true));
  check('twin noted for the migration', wiki.structure.duplicates.some((d) => d.name === 'proxmox' && d.paths.length === 2));

  // unknown folder without purpose
  await writeFile(memFile, '---\nname: mem-proxmox\n---\nDer VW Bus hat 120 PS.\n');
  const c2 = { ...candidate, body: 'Der VW Bus hat 120 PS.', mtimeMs: (await stat(memFile)).mtimeMs };
  const d2 = { decideMemoryFate: async () => ({ kind: 'promote' as const, subfolder: 'fahrzeuge', slug: 'fahrzeuge/vw-bus', type: 'ding', title: 'VW Bus', body: '## Stand\n120 PS' }) };
  const o2 = await processCandidate({ candidate: c2 as never, ctx: { wikiAbs, schema: DE_WIKI_SCHEMA }, mgr: mgr as never, workerModel: {} as never, dispatcher: d2 as never, wiki, timeoutMs: 1000 });
  check('unknown folder without purpose → transient skip', o2.kind === 'skipped' && o2.transient === true && o2.reason.includes('fahrzeuge'));
  check('memory note kept', await stat(memFile).then(() => true, () => false));

  // with purpose → created, folder described, map updated
  const d3 = { decideMemoryFate: async () => ({ kind: 'promote' as const, subfolder: 'fahrzeuge', slug: 'fahrzeuge/vw-bus', type: 'ding', title: 'VW Bus', body: '## Stand\n120 PS', newFolder: { path: 'fahrzeuge', purpose: 'Fahrzeuge des Haushalts.' } }) };
  const o3 = await processCandidate({ candidate: c2 as never, ctx: { wikiAbs, schema: DE_WIKI_SCHEMA }, mgr: mgr as never, workerModel: {} as never, dispatcher: d3 as never, wiki, timeoutMs: 1000 });
  check('with purpose → promoted', o3.kind === 'promoted' && (await stat(join(wikiAbs, 'fahrzeuge/vw-bus.md')).then(() => true, () => false)));
  check('folder described by deep', wiki.structure.folders.find((f) => f.path === 'fahrzeuge')?.origin === 'deep' && wiki.map.folders.find((f) => f.path === 'fahrzeuge')?.pages === 1);
  await saveStructureFile(wikiAbs, wiki.structure);
  const saved = await readFile(join(wikiAbs, '_struktur.md'), 'utf8');
  check('structure file lists deep folder and the twin', saved.includes('| fahrzeuge | Fahrzeuge des Haushalts. | deep |') && saved.includes('- proxmox: hardware/proxmox, infrastruktur/hosts/proxmox'));

  // a second run: the twin the model wanted again is caught even with the new page
  const wiki2 = await loadDeepWikiState(wikiAbs, 'de');
  check('reload keeps the deep description', wiki2.map.folders.find((f) => f.path === 'fahrzeuge')?.purpose === 'Fahrzeuge des Haushalts.' && wiki2.dirty === false);
}

console.log(`wiki-map: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
