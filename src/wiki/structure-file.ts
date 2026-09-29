// The structure file — `_struktur.md` / `_structure.md` in the wiki root.
//
// One line per folder: path, purpose, who described it (template, Deep,
// a person), when. It is the wiki's own memory of what its folders
// mean: Deep reads it into the map (src/wiki/map.ts) on every run,
// writes the purpose of a folder it creates, and people edit it in
// Obsidian like any page. Folders that exist on disk but were never
// described show up as "(no description yet)" until the migration or a
// person fills them in. Frontmatter is the data; the body is a
// rendering for readers and is rewritten on every save.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { WikiLanguage } from './language.ts';
import { taxonomyFor } from './taxonomy.ts';

export type FolderOrigin = 'template' | 'deep' | 'user' | 'unknown';

export interface StructureFolder {
  path: string;
  purpose: string;
  origin: FolderOrigin;
  /** ISO date the entry was written. */
  since: string;
}

export interface StructureDuplicate {
  /** Page basename that exists in several folders. */
  name: string;
  paths: string[];
  noted: string;
}

export interface StructureFile {
  language: WikiLanguage;
  /** The taxonomy version this wiki was last migrated to; 0 = never. */
  template_version: number;
  folders: StructureFolder[];
  /** Same-name pages Deep found in several folders — for the migration. */
  duplicates: StructureDuplicate[];
}

export function structureFileName(language: WikiLanguage): string {
  return language === 'en' ? '_structure.md' : '_struktur.md';
}

/** `_struktur.md` / `_structure.md` in any language — skipped by the
 *  index builder and the memory indexer: it describes pages, it is none. */
export function isStructureFileName(name: string): boolean {
  return name === '_struktur.md' || name === '_structure.md';
}

export function emptyStructure(language: WikiLanguage): StructureFile {
  return { language, template_version: 0, folders: [], duplicates: [] };
}

export async function loadStructureFile(wikiAbs: string, language: WikiLanguage): Promise<StructureFile> {
  let raw: string;
  try {
    raw = await readFile(join(wikiAbs, structureFileName(language)), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStructure(language);
    throw err;
  }
  const data = matter(raw).data as Partial<StructureFile>;
  const folders = Array.isArray(data.folders)
    ? data.folders
        .filter((f): f is StructureFolder => !!f && typeof f === 'object' && typeof (f as StructureFolder).path === 'string')
        .map((f) => ({ path: normalizeFolder(f.path), purpose: String(f.purpose ?? ''), origin: (['template', 'deep', 'user', 'unknown'].includes(String(f.origin)) ? f.origin : 'user') as FolderOrigin, since: String(f.since ?? '') }))
    : [];
  const duplicates = Array.isArray(data.duplicates)
    ? data.duplicates.filter((d): d is StructureDuplicate => !!d && typeof d === 'object' && typeof (d as StructureDuplicate).name === 'string').map((d) => ({ name: d.name, paths: Array.isArray(d.paths) ? d.paths.map(String) : [], noted: String(d.noted ?? '') }))
    : [];
  return { language, template_version: Number(data.template_version ?? 0) || 0, folders, duplicates };
}

export async function saveStructureFile(wikiAbs: string, data: StructureFile): Promise<void> {
  const file = join(wikiAbs, structureFileName(data.language));
  const content = matter.stringify(renderBody(data), {
    language: data.language,
    template_version: data.template_version,
    folders: data.folders,
    duplicates: data.duplicates,
  });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

export function normalizeFolder(p: string): string {
  return p.replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');
}

/** Describe a folder; an existing entry is updated only when it had no
 *  purpose or was `unknown` — a person's or the template's wording is
 *  never overwritten by Deep. Returns true when something changed. */
export function describeFolder(data: StructureFile, entry: { path: string; purpose: string; origin: FolderOrigin }, now = new Date()): boolean {
  const path = normalizeFolder(entry.path);
  const existing = data.folders.find((f) => f.path === path);
  if (existing) {
    if (existing.purpose.trim() && existing.origin !== 'unknown') return false;
    existing.purpose = entry.purpose;
    existing.origin = entry.origin;
    existing.since = now.toISOString().slice(0, 10);
    return true;
  }
  data.folders.push({ path, purpose: entry.purpose, origin: entry.origin, since: now.toISOString().slice(0, 10) });
  data.folders.sort((a, b) => a.path.localeCompare(b.path));
  return true;
}

export function noteDuplicate(data: StructureFile, name: string, paths: string[], now = new Date()): boolean {
  const sorted = [...new Set(paths.map(normalizeFolder))].sort();
  const existing = data.duplicates.find((d) => d.name === name);
  if (existing) {
    if (existing.paths.join('|') === sorted.join('|')) return false;
    existing.paths = sorted;
    existing.noted = now.toISOString().slice(0, 10);
    return true;
  }
  data.duplicates.push({ name, paths: sorted, noted: now.toISOString().slice(0, 10) });
  return true;
}

function renderBody(data: StructureFile): string {
  const t = taxonomyFor(data.language);
  const de = data.language === 'de';
  const lines: string[] = [];
  lines.push(de ? '# Struktur dieses Wikis' : '# Structure of this wiki');
  lines.push('');
  lines.push(de
    ? 'Ein Ordner sagt, welche Art von Seite darin liegt. Diese Datei ist die Landkarte, die Deep beim Einordnen neuer Seiten liest — die Sätze hier dürfen von Hand geändert werden (Frontmatter ist die Quelle, dieser Text wird daraus erzeugt).'
    : 'A folder says what kind of page lives in it. This file is the map Deep reads when it files new pages — edit the sentences by hand as you like (the frontmatter is the source; this text is generated from it).');
  lines.push('');
  lines.push(de ? '| Ordner | Zweck | Herkunft | seit |' : '| Folder | Purpose | Origin | since |');
  lines.push('|---|---|---|---|');
  for (const f of data.folders) lines.push(`| ${f.path} | ${f.purpose.replace(/\|/g, '/')} | ${f.origin} | ${f.since} |`);
  if (data.duplicates.length > 0) {
    lines.push('', de ? '## Gleichnamige Seiten in mehreren Ordnern' : '## Same-name pages in several folders', '');
    for (const d of data.duplicates) lines.push(`- ${d.name}: ${d.paths.join(', ')} (${d.noted})`);
  }
  lines.push('', de ? `Vorlage: Version ${data.template_version || '—'} (aktuell ${t.version}).` : `Template: version ${data.template_version || '—'} (current ${t.version}).`);
  return lines.join('\n') + '\n';
}
