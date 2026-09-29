// Moving one wiki page — the piece the review loop lacked (2026-09-29):
// a finding "this page is in the wrong folder" was not actionable with
// wiki_edit / wiki_create / wiki_delete. A move renames the file,
// updates the frontmatter `slug`, and points every [[link]] in the wiki
// at the new place. The target folder must be one the map knows —
// existing, or proposed by the template — so a move cannot reinvent
// the sprawl the migration removed.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WikiLanguage } from './language.ts';
import { buildWikiMap } from './map.ts';
import { relinkWiki } from './migration/execute.ts';
import { loadStructureFile } from './structure-file.ts';
import { buildWikiPage, parseWikiPage } from './templates.ts';

export interface MoveResult {
  from: string;
  to: string;
  linksRewritten: number;
  pagesTouched: number;
}

const norm = (p: string): string => p.replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');

export async function movePage(args: { wikiAbs: string; language: WikiLanguage; from: string; to: string; now?: Date }): Promise<MoveResult> {
  const from = norm(args.from);
  const to = norm(args.to);
  if (!from || !to) throw new Error('move: both paths are required');
  if (from === to) throw new Error('move: source and target are the same');
  if (!/^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/i.test(to)) throw new Error(`move: '${to}' is not a wiki path (lowercase, kebab-case, folders with /)`);
  const fromAbs = join(args.wikiAbs, `${from}.md`);
  const toAbs = join(args.wikiAbs, `${to}.md`);
  if (!(await stat(fromAbs).then((s) => s.isFile(), () => false))) throw new Error(`move: page '${from}' does not exist`);
  if (await stat(toAbs).then(() => true, () => false)) throw new Error(`move: a page already exists at '${to}'`);
  const folder = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
  if (folder) {
    const structure = await loadStructureFile(args.wikiAbs, args.language);
    const map = await buildWikiMap({ wikiAbs: args.wikiAbs, language: args.language, structure });
    const known = new Set([...map.folders.map((f) => f.path), ...map.planned.map((p) => p.path)]);
    if (!known.has(folder)) throw new Error(`move: '${folder}/' is neither an existing folder nor one the template proposes — pick a folder from the wiki map`);
  }
  const raw = await readFile(fromAbs, 'utf8');
  const page = parseWikiPage(raw);
  page.frontmatter.slug = to;
  page.frontmatter.updated = (args.now ?? new Date()).toISOString().slice(0, 10);
  await mkdir(dirname(toAbs), { recursive: true });
  const tmp = `${toAbs}.tmp-${process.pid}`;
  await writeFile(tmp, buildWikiPage(page), 'utf8');
  await rename(tmp, toAbs);
  await rename(fromAbs, `${fromAbs}.moved-${process.pid}`).catch(() => undefined);
  await (await import('node:fs/promises')).unlink(`${fromAbs}.moved-${process.pid}`).catch(() => undefined);
  // Links and `related:` entries naming the old place; a bare [[name]]
  // still resolves after a move, so it is left alone.
  const r = await relinkWiki(args.wikiAbs, new Map([[from, to]]), new Map());
  return { from, to, linksRewritten: r.refs, pagesTouched: r.pages };
}
