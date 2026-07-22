// Tests for the read-only wiki explorer (2026-07-22).
//
// Run: npx tsx src/wiki/explorer.test.mts
//
// The properties that matter here are the ones a viewer gets wrong in
// ways nobody notices: a link resolved to the wrong page reads as a real
// relationship, and a slug that escapes the wiki root reads as a feature
// until someone points it at /etc.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTree,
  getPage,
  getWikiIndex,
  globalGraph,
  invalidateWikiIndex,
  localGraph,
  resolveLinkTargets,
  type WikiTreeNode,
} from './explorer.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

async function page(root: string, slug: string, body: string): Promise<void> {
  const file = join(root, `${slug}.md`);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, body, 'utf8');
}

/** A small wiki that exercises every resolution rule. */
async function scenario(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'somora-wiki-'));
  await page(root, 'index', '# Index\n\n- [[projekte/somora]]\n- [[personen/rene]]\n');
  await page(
    root,
    'projekte/somora',
    '# somora\n\nEin Gateway von [[personen/rene]].\nSiehe [[Personen/Rene]] und [[wissen/tls]].\nUnd [[gibtsnicht]].\n',
  );
  await page(root, 'personen/rene', '# Rene\n\nBaut [[projekte/somora]].\n');
  await page(root, 'wissen/tls', '# TLS\n\nNur Text, keine Links.\n');
  // Same basename in two folders — a short link to it is ambiguous.
  await page(root, 'projekte/doppelt', '# Doppelt A\n\ntext\n');
  await page(root, 'wissen/doppelt', '# Doppelt B\n\ntext\n');
  await page(root, 'wissen/kurzlink', '# Kurz\n\nZeigt auf [[tls]] und auf [[doppelt]].\n');
  // Frontmatter-only relation, no inline wikilink.
  await page(
    root,
    'konzepte/verwandt',
    '---\nrelated:\n  - wissen/tls\n---\n\n# Verwandt\n\ntext\n',
  );
  return root;
}

// ─────────────────────────────────────────────────────────── resolution
{
  invalidateWikiIndex();
  const root = await scenario();
  const idx = await getWikiIndex(root);

  check('alle Seiten gefunden', idx.pages.size === 8, `${idx.pages.size}`);

  const somora = idx.pages.get('projekte/somora')!;
  check('exakter Slug aufgeloest', somora.links.includes('personen/rene'));
  check(
    'Gross-/Kleinschreibung egal',
    somora.links.filter((l) => l === 'personen/rene').length === 1,
    'case-variant must dedupe onto the same slug, not add a second edge',
  );
  check('unbekanntes Ziel bleibt unaufgeloest', somora.unresolved.includes('gibtsnicht'));
  check('kein Selbstverweis', !somora.links.includes('projekte/somora'));

  const kurz = idx.pages.get('wissen/kurzlink')!;
  check('eindeutiger Basename aufgeloest', kurz.links.includes('wissen/tls'));
  check(
    'mehrdeutiger Basename bleibt unaufgeloest',
    kurz.unresolved.includes('doppelt') &&
      !kurz.links.includes('projekte/doppelt') &&
      !kurz.links.includes('wissen/doppelt'),
    'guessing one of two same-named pages invents a relationship',
  );

  const verwandt = idx.pages.get('konzepte/verwandt')!;
  check('frontmatter related aufgeloest', verwandt.related.includes('wissen/tls'));

  // Backlinks
  const rene = getPage(idx, 'personen/rene')!;
  check(
    'Backlinks enthalten Verweisende',
    rene.backlinks.some((b) => b.slug === 'projekte/somora') &&
      rene.backlinks.some((b) => b.slug === 'index'),
    JSON.stringify(rene.backlinks.map((b) => b.slug)),
  );

  const tlsBack = getPage(idx, 'wissen/tls')!.backlinks.map((b) => b.slug);
  check(
    'related zaehlt als Backlink',
    tlsBack.includes('konzepte/verwandt'),
    JSON.stringify(tlsBack),
  );

  // Titles come from the H1, not the filename.
  check('Titel aus H1', idx.pages.get('projekte/doppelt')!.title === 'Doppelt A');

  await rm(root, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────── tree
{
  invalidateWikiIndex();
  const root = await scenario();
  const idx = await getWikiIndex(root);
  const tree = buildTree(idx);

  const names = tree.map((n) => (n.type === 'dir' ? n.name : n.slug));
  check('Ordner vor Seiten', tree[0]?.type === 'dir', JSON.stringify(names));
  check('Root-Seite auf oberster Ebene', names.includes('index'), JSON.stringify(names));

  const projekte = tree.find((n) => n.type === 'dir' && n.name === 'projekte');
  check('Ordner projekte existiert', Boolean(projekte));
  if (projekte?.type === 'dir') {
    check('Ordner enthaelt seine Seiten', projekte.children.length === 2);
    check(
      'Kinder sind Seiten mit Slug',
      projekte.children.every((c) => c.type === 'page' && c.slug.startsWith('projekte/')),
    );
  }

  const countPages = (nodes: WikiTreeNode[]): number =>
    nodes.reduce((n, x) => n + (x.type === 'page' ? 1 : countPages(x.children)), 0);
  check('Baum enthaelt jede Seite genau einmal', countPages(tree) === idx.pages.size);

  await rm(root, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────── graph
{
  invalidateWikiIndex();
  const root = await scenario();
  const idx = await getWikiIndex(root);

  const g = globalGraph(idx);
  check('index aus dem globalen Graph raus', !g.nodes.some((n) => n.id === 'index'));
  check(
    'keine Kante beruehrt index',
    !g.edges.some((e) => e.from === 'index' || e.to === 'index'),
    'index.md links to every page by construction — it is a table of contents, not a relationship',
  );
  check('globaler Graph nicht gekuerzt bei 8 Seiten', g.truncated === false);

  const lg = localGraph(idx, 'personen/rene')!;
  const ids = new Set(lg.nodes.map((n) => n.id));
  check('lokaler Graph enthaelt die Seite selbst', ids.has('personen/rene'));
  check('enthaelt ausgehende Nachbarn', ids.has('projekte/somora'));
  check('index auch lokal ausgeschlossen', !ids.has('index'));
  check(
    'Kanten zwischen Nachbarn sind dabei',
    lg.edges.some((e) => e.from === 'projekte/somora' && e.to === 'personen/rene'),
  );
  check(
    'keine Kante zeigt aus dem Graph heraus',
    lg.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
  );

  check('unbekannte Seite -> null', localGraph(idx, 'gibtsnicht') === null);

  await rm(root, { recursive: true, force: true });
}

// ─────────────────────────────────────────── clipped-link regression
{
  invalidateWikiIndex();
  const root = await mkdtemp(join(tmpdir(), 'somora-wiki-clip-'));
  await page(root, 'ziel', '# Ziel\n\ntext\n');
  // Dream-B clips index descriptions without respecting link boundaries,
  // leaving a half-open `[[foo…` behind. A newline-tolerant regex would
  // swallow the rest of the file into one bogus target.
  await page(
    root,
    'kaputt',
    '# Kaputt\n\n- [[ziel]] — Beschreibung mit [[personen/abgeschnitten…\n- [[ziel]] — noch eine\n',
  );
  const idx = await getWikiIndex(root);
  const k = idx.pages.get('kaputt')!;
  check('abgeschnittener Link frisst nicht den Rest', k.links.includes('ziel'));
  check(
    'kein mehrzeiliges Phantom-Ziel',
    k.unresolved.every((u) => !u.includes('\n')),
    JSON.stringify(k.unresolved),
  );
  await rm(root, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────── path safety
{
  invalidateWikiIndex();
  const root = await scenario();
  const idx = await getWikiIndex(root);
  for (const evil of [
    '../../../etc/passwd',
    '/etc/passwd',
    'projekte/../../../../etc/hosts',
    './../../secret',
  ]) {
    check(`kein Zugriff via '${evil}'`, getPage(idx, evil) === null);
  }
  check('unbekannter Slug -> null', getPage(idx, 'gibtsnicht') === null);
  await rm(root, { recursive: true, force: true });
}

// ─────────────────────────────────────────────── link-target resolution
{
  invalidateWikiIndex();
  const root = await scenario();
  const idx = await getWikiIndex(root);
  const r = resolveLinkTargets(idx, [
    'projekte/somora',
    'Personen/Rene',
    'tls',
    'doppelt',
    'gibtsnicht',
    'wissen/tls.md',
  ]);
  check('exakt', r['projekte/somora'] === 'projekte/somora');
  check('case-insensitive', r['Personen/Rene'] === 'personen/rene');
  check('eindeutiger Basename', r['tls'] === 'wissen/tls');
  check('mehrdeutig -> null', r['doppelt'] === null);
  check('unbekannt -> null', r['gibtsnicht'] === null);
  check('.md-Endung toleriert', r['wissen/tls.md'] === 'wissen/tls');
  await rm(root, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────── refresh
{
  invalidateWikiIndex();
  const root = await scenario();
  await getWikiIndex(root);
  // A page edited in Obsidian must show up without a restart. The TTL
  // gate is bypassed by invalidating, which is what /wiki/refresh does.
  await page(root, 'wissen/tls', '# TLS neu\n\nJetzt mit [[personen/rene]].\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(join(root, 'index.md'), old, old);
  invalidateWikiIndex();
  const idx2 = await getWikiIndex(root);
  check('geaenderter Titel uebernommen', idx2.pages.get('wissen/tls')!.title === 'TLS neu');
  check('neue Kante erkannt', idx2.pages.get('wissen/tls')!.links.includes('personen/rene'));
  check(
    'neuer Backlink erkannt',
    (idx2.backlinks.get('personen/rene') ?? []).includes('wissen/tls'),
  );
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
