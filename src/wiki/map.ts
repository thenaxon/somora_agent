// The wiki map — what Deep sees instead of the first 4 KB of index.md.
//
// Every run: the folders that EXIST (from disk, with page counts and the
// purpose the structure file knows), then the folders the template
// still proposes (empty so far), then the rules. Reality wins: a folder
// a person or Deep created is listed as it is; the template only fills
// gaps. Also built here: the index of page basenames across the whole
// wiki, for the same-name check before a page is created.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WikiLanguage } from './language.ts';
import type { StructureFile } from './structure-file.ts';
import { taxonomyFor, taxonomyPaths, type WikiTaxonomy } from './taxonomy.ts';

export interface MapFolder {
  path: string;
  pages: number;
  purpose: string;
  origin: 'template' | 'deep' | 'user' | 'unknown';
}

export interface WikiMap {
  folders: MapFolder[];
  /** Template folders that do not exist on disk yet. */
  planned: Array<{ path: string; purpose: string }>;
  /** basename (lowercase, without .md) → wiki paths (without .md). */
  sameName: Map<string, string[]>;
  text: string;
}

const SKIP_DIRS = new Set(['logs', 'templates', 'attachments']);

/** Walk the wiki: folders up to two levels, page counts, basename index. */
export async function scanWiki(wikiAbs: string): Promise<{ folders: Map<string, number>; sameName: Map<string, string[]> }> {
  const folders = new Map<string, number>();
  const sameName = new Map<string, string[]>();
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(join(wikiAbs, rel));
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await stat(join(wikiAbs, relPath));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) && depth === 0) continue;
        if (!folders.has(relPath)) folders.set(relPath, 0);
        if (depth < 2) await walk(relPath, depth + 1);
      } else if (name.toLowerCase().endsWith('.md')) {
        if (rel) folders.set(rel, (folders.get(rel) ?? 0) + 1);
        const base = name.slice(0, -3).toLowerCase();
        const list = sameName.get(base) ?? [];
        list.push(relPath.slice(0, -3));
        sameName.set(base, list);
      }
    }
  };
  await walk('', 0);
  return { folders, sameName };
}

export async function buildWikiMap(args: { wikiAbs: string; language: WikiLanguage; structure: StructureFile; taxonomy?: WikiTaxonomy }): Promise<WikiMap> {
  const taxonomy = args.taxonomy ?? taxonomyFor(args.language);
  const scanned = await scanWiki(args.wikiAbs);
  const described = new Map(args.structure.folders.map((f) => [f.path, f]));
  const templatePurpose = new Map<string, string>();
  for (const f of taxonomy.folders) {
    templatePurpose.set(f.path, f.purpose);
    for (const s of f.subfolders ?? []) templatePurpose.set(s.path, s.purpose);
  }
  const folders: MapFolder[] = [...scanned.folders.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, pages]) => {
      const d = described.get(path);
      if (d && d.purpose.trim()) return { path, pages, purpose: d.purpose, origin: d.origin };
      const tp = templatePurpose.get(path);
      if (tp) return { path, pages, purpose: tp, origin: 'template' };
      return { path, pages, purpose: '', origin: 'unknown' };
    });
  const existing = new Set(folders.map((f) => f.path));
  const planned = taxonomyPaths(taxonomy)
    .filter((p) => !existing.has(p))
    .map((p) => ({ path: p, purpose: templatePurpose.get(p) ?? '' }));
  const text = renderMap(folders, planned);
  return { folders, planned, sameName: scanned.sameName, text };
}

function renderMap(folders: MapFolder[], planned: Array<{ path: string; purpose: string }>): string {
  const lines: string[] = ['<wiki_map>'];
  lines.push('Existing folders (path — what lives there · pages):');
  if (folders.length === 0) lines.push('- (no folders yet)');
  for (const f of folders) lines.push(`- ${f.path} — ${f.purpose || '(no description yet)'} · ${f.pages}`);
  if (planned.length > 0) {
    lines.push('', 'Folders the template proposes that do not exist yet (create one by filing a page into it):');
    for (const p of planned) lines.push(`- ${p.path} — ${p.purpose}`);
  }
  // The rules are model-facing and therefore English, like every prompt
  // somora produces; the folder purposes above are content and stay in
  // the wiki's language.
  lines.push('', 'Rules:');
  lines.push(
    '- A folder says what KIND of page lives in it — never what a page is about. Topics live in the page, its links and index.md.',
    '- A dated work report is not a page of its own but a timeline entry on the project or entity page it concerns.',
    '- At most one level of subfolders.',
  );
  lines.push(
    '- File a page into an existing or proposed folder above. Only when none fits, create a new one: give "subfolder" the new path and add "newFolder": {"path": "<the same path>", "purpose": "<one sentence, in the wiki language, what kind of page lives there>"} — the description is kept and shown here from the next run on. A new folder without a purpose is refused.',
  );
  lines.push('</wiki_map>');
  return lines.join('\n');
}

/**
 * Same-name check before a page is created: pages with the target's
 * basename in OTHER folders. `preferredFolder` (the folder the model
 * chose) picks one when several exist. Returns null when none.
 */
export function sameNamePages(map: Pick<WikiMap, 'sameName'>, targetPath: string, preferredFolder?: string): { target: string; others: string[] } | null {
  const base = targetPath.replace(/^\/+/, '').replace(/\.md$/i, '').split('/').pop()!.toLowerCase();
  const all = (map.sameName.get(base) ?? []).filter((p) => p.toLowerCase() !== targetPath.replace(/^\/+/, '').replace(/\.md$/i, '').toLowerCase());
  if (all.length === 0) return null;
  const pref = preferredFolder ? all.find((p) => p.startsWith(preferredFolder.replace(/\/+$/, '') + '/')) : undefined;
  const target = pref ?? all[0]!;
  return { target, others: all.filter((p) => p !== target) };
}

/** A page was created: keep the in-memory map current for the rest of
 *  the run (folder counts, basename index) without another disk walk. */
export function noteNewPage(map: WikiMap, wikiPath: string, purposeIfNew?: { purpose: string; origin: MapFolder['origin'] }): void {
  const rel = wikiPath.replace(/^\/+/, '').replace(/\.md$/i, '');
  const parts = rel.split('/');
  const base = parts[parts.length - 1]!.toLowerCase();
  const list = map.sameName.get(base) ?? [];
  if (!list.includes(rel)) list.push(rel);
  map.sameName.set(base, list);
  if (parts.length < 2) return;
  const folder = parts.slice(0, -1).join('/');
  const f = map.folders.find((x) => x.path === folder);
  if (f) {
    f.pages++;
    return;
  }
  const planned = map.planned.find((p) => p.path === folder);
  map.planned = map.planned.filter((p) => p.path !== folder);
  map.folders.push({
    path: folder,
    pages: 1,
    purpose: planned?.purpose ?? purposeIfNew?.purpose ?? '',
    origin: planned ? 'template' : purposeIfNew?.origin ?? 'unknown',
  });
  map.folders.sort((a, b) => a.path.localeCompare(b.path));
  // Every parent folder of a new subfolder exists after the write.
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(0, i).join('/');
    if (!map.folders.some((x) => x.path === parent)) {
      const pl = map.planned.find((p) => p.path === parent);
      map.planned = map.planned.filter((p) => p.path !== parent);
      map.folders.push({ path: parent, pages: 0, purpose: pl?.purpose ?? '', origin: pl ? 'template' : 'unknown' });
    }
  }
}

/**
 * Where a promote wants to write, checked against the map:
 *  - `sameName`: a page with that basename exists in another folder →
 *    the caller merges into it instead of creating a twin.
 *  - `unknownFolder`: the folder neither exists nor is proposed by the
 *    template, and the model gave no purpose → refused.
 *  - `tooDeep`: more than one level below a top folder → refused.
 *  - `ok`: with the folder entry to record when the folder is new.
 */
export type PromoteTargetCheck =
  | { kind: 'ok'; folder: string; describe?: { path: string; purpose: string; origin: 'template' | 'deep' } }
  | { kind: 'sameName'; target: string; others: string[] }
  /** The new name extends an entity page's name (`enovom-kapitalruecklage`
   *  next to `unternehmen/enovom`): usually a detail of that entity. */
  | { kind: 'subTopic'; target: string; prefix: string }
  | { kind: 'unknownFolder'; folder: string }
  | { kind: 'tooDeep'; folder: string };

export function checkPromoteTarget(map: WikiMap, decision: { slug: string; subfolder: string; newFolder?: { path: string; purpose: string } }, opts: { ignoreSubTopic?: boolean } = {}): PromoteTargetCheck {
  const rel = decision.slug.replace(/^\/+/, '').replace(/\.md$/i, '');
  const parts = rel.split('/');
  const folder = parts.slice(0, -1).join('/');
  if (parts.length > 3) return { kind: 'tooDeep', folder };
  const same = sameNamePages(map, rel, decision.subfolder);
  if (same) return { kind: 'sameName', target: same.target, others: same.others };
  const sub = opts.ignoreSubTopic ? null : subTopicOf(map, rel);
  if (sub) return { kind: 'subTopic', target: sub.target, prefix: sub.prefix };
  if (!folder) return { kind: 'ok', folder };
  const existing = map.folders.find((f) => f.path === folder);
  if (existing) {
    // An existing folder nobody has described yet: the model's purpose,
    // when it gave one for exactly this folder, fills the gap.
    if (!existing.purpose && decision.newFolder && decision.newFolder.path === folder) {
      return { kind: 'ok', folder, describe: { path: folder, purpose: decision.newFolder.purpose, origin: 'deep' } };
    }
    return { kind: 'ok', folder };
  }
  const planned = map.planned.find((p) => p.path === folder);
  if (planned) return { kind: 'ok', folder, describe: { path: folder, purpose: planned.purpose, origin: 'template' } };
  if (decision.newFolder && decision.newFolder.path === folder && decision.newFolder.purpose.trim()) {
    return { kind: 'ok', folder, describe: { path: folder, purpose: decision.newFolder.purpose.trim(), origin: 'deep' } };
  }
  return { kind: 'unknownFolder', folder };
}

/** Folders whose pages are entities a detail can belong to. */
const ENTITY_TOPS = new Set(['personen', 'people', 'unternehmen', 'companies', 'projekte', 'projects', 'orte', 'places', 'infrastruktur', 'infrastructure', 'besitz', 'possessions', 'agenten', 'agents']);

/**
 * An entity page whose name the new page's name extends: `<name>-…`
 * with `<name>` at least four characters (2026-09-29, Rene: the note
 * on enovom's capital reserve became `projekte/enovom-kapitalruecklage-…`
 * while `unternehmen/enovom` existed). The longest such name wins. Null
 * when there is none — a page in a knowledge or event folder never
 * counts, its name is a topic, not an entity.
 */
export function subTopicOf(map: Pick<WikiMap, 'sameName'>, targetPath: string): { target: string; prefix: string } | null {
  const base = targetPath.replace(/^\/+/, '').replace(/\.md$/i, '').split('/').pop()!.toLowerCase();
  let best: { target: string; prefix: string } | null = null;
  for (const [name, paths] of map.sameName) {
    if (name.length < 4 || !base.startsWith(name + '-')) continue;
    const entity = paths.find((p) => ENTITY_TOPS.has(p.split('/')[0] ?? '') && p.split('/').length >= 2);
    if (!entity) continue;
    if (!best || name.length > best.prefix.length) best = { target: entity, prefix: name };
  }
  return best;
}

/**
 * Bring the structure file up to date with what is on disk: every
 * folder the walk found gets an entry (the template's purpose when the
 * path is a template path, otherwise an empty `unknown` entry a person
 * or the migration fills in). Returns true when something was added.
 */
export function syncStructureWithMap(structure: StructureFile, map: WikiMap, describe: (entry: { path: string; purpose: string; origin: MapFolder['origin'] }) => boolean): boolean {
  let dirty = false;
  for (const f of map.folders) {
    if (structure.folders.some((s) => s.path === f.path)) continue;
    if (describe({ path: f.path, purpose: f.purpose, origin: f.purpose ? f.origin : 'unknown' })) dirty = true;
  }
  return dirty;
}
