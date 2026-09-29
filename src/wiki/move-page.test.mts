// wiki_move's core: the file moves, the slug follows, links are
// rewritten, and a folder the map does not know is refused.
// Run: npx tsx src/wiki/move-page.test.mts
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-move-home-'));
const { movePage } = await import('./move-page.ts');
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) pass++;
  else {
    fail++;
    console.error(`FAIL: ${n} ${d}`);
  }
};
const wikiAbs = await mkdtemp(join(tmpdir(), 'somora-move-wiki-'));
const page = async (rel: string, body: string): Promise<void> => {
  await mkdir(join(wikiAbs, rel, '..'), { recursive: true });
  await writeFile(join(wikiAbs, `${rel}.md`), `---\nslug: ${rel}\ntype: konzept\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# ${rel.split('/').pop()}\n\n${body}\n`);
};
await page('wissen/cameras', 'Die Kameras.');
await page('orte/haus', 'Siehe [[wissen/cameras]] und [[cameras|die Kameras]] und [[wissen/cameras#Netz]].');
await page('personen/anna', 'Anna.');
await writeFile(join(wikiAbs, 'index.md'), '- [[wissen/cameras]]\n');

const r = await movePage({ wikiAbs, language: 'de', from: 'wissen/cameras', to: 'infrastruktur/geraete/reolink-kameras', now: new Date('2026-09-29T12:00:00Z') });
check('moved into a template folder that did not exist yet', (await stat(join(wikiAbs, 'infrastruktur/geraete/reolink-kameras.md')).then(() => true, () => false)) && !(await stat(join(wikiAbs, 'wissen/cameras.md')).then(() => true, () => false)));
check('slug and updated follow', (await readFile(join(wikiAbs, 'infrastruktur/geraete/reolink-kameras.md'), 'utf8')).includes('slug: infrastruktur/geraete/reolink-kameras') && (await readFile(join(wikiAbs, 'infrastruktur/geraete/reolink-kameras.md'), 'utf8')).includes("updated: '2026-09-29'"));
const haus = await readFile(join(wikiAbs, 'orte/haus.md'), 'utf8');
check('full-path links rewritten, bare name left, heading kept', haus.includes('[[infrastruktur/geraete/reolink-kameras]] und [[cameras|die Kameras]] und [[infrastruktur/geraete/reolink-kameras#Netz]]'), haus);
check('index rewritten too, counts', (await readFile(join(wikiAbs, 'index.md'), 'utf8')).includes('reolink-kameras') && r.linksRewritten === 3 && r.pagesTouched === 2);
const err = async (from: string, to: string): Promise<string> => movePage({ wikiAbs, language: 'de', from, to }).then(() => '', (e) => (e as Error).message);
check('unknown folder refused', /neither an existing folder/.test(await err('personen/anna', 'fahrzeuge/anna')));
check('existing target refused', /already exists/.test(await err('personen/anna', 'infrastruktur/geraete/reolink-kameras')));
check('missing source refused', /does not exist/.test(await err('personen/bert', 'personen/berta')));
check('bad path refused', /not a wiki path/.test(await err('personen/anna', 'personen/Anna Neu')));
check('rename within a folder', (await movePage({ wikiAbs, language: 'de', from: 'personen/anna', to: 'personen/anna-klein' })).to === 'personen/anna-klein');
console.log(`move page: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
{
  await page('orte/keller', 'Keller.');
  await writeFile(join(wikiAbs, 'orte/keller.md'), (await readFile(join(wikiAbs, 'orte/keller.md'), 'utf8')).replace('type: konzept\n', 'type: konzept\nrelated:\n  - personen/anna-klein\n'));
  await movePage({ wikiAbs, language: 'de', from: 'personen/anna-klein', to: 'personen/anna' });
  check('move rewrites related: too', (await readFile(join(wikiAbs, 'orte/keller.md'), 'utf8')).includes('- personen/anna\n'));
}
console.log(`move page (related): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
