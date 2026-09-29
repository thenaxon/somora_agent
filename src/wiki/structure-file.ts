// The structure file — `_struktur.md` / `_structure.md` in the wiki root.
//
// One table row per folder: path, purpose, who described it (template,
// Deep, a person), when. It is the wiki's own memory of what its
// folders mean: Deep reads it into the map (src/wiki/map.ts) on every
// run, writes the purpose of a folder it creates, and people edit it
// in Obsidian like any page. Folders that exist on disk but were never
// described have an empty purpose until the migration or a person
// fills it in. The table IS the data (parsed back on load); the
// frontmatter holds only the language and the template version.

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

const ORIGINS: readonly FolderOrigin[] = ['template', 'deep', 'user', 'unknown'];
const asOrigin = (v: unknown): FolderOrigin => (ORIGINS.includes(String(v) as FolderOrigin) ? (String(v) as FolderOrigin) : 'user');

/**
 * The table in the body is the source of truth — Obsidian shows a
 * frontmatter list of objects as raw JSON in yellow (2026-09-29), and a
 * person edits a sentence in a table, not in YAML. The first version
 * kept the data in the frontmatter; a file written that way is still
 * read when its body has no table rows.
 */
export async function loadStructureFile(wikiAbs: string, language: WikiLanguage): Promise<StructureFile> {
  let raw: string;
  try {
    raw = await readFile(join(wikiAbs, structureFileName(language)), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStructure(language);
    throw err;
  }
  return parseStructureFile(raw, language);
}

/** Exported for tests. */
export function parseStructureFile(raw: string, language: WikiLanguage): StructureFile {
  const parsed = matter(raw);
  const data = parsed.data as Partial<StructureFile>;
  const out: StructureFile = { language, template_version: Number(data.template_version ?? 0) || 0, folders: [], duplicates: [] };
  const seen = new Set<string>();
  for (const line of parsed.content.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const path = normalizeFolder(cells[0]!.replace(/`/g, ''));
    if (!path || /^-+$/.test(path) || seen.has(path)) continue;
    // The header row: its first cell is a word, not a path — but a
    // top folder is a word too, so the header is told by its origin
    // column, which is never a real origin.
    const origin = String(cells[2]);
    if (!ORIGINS.includes(origin as FolderOrigin) && origin !== '') continue;
    seen.add(path);
    out.folders.push({ path, purpose: cells[1]!, origin: origin ? asOrigin(origin) : 'user', since: cells[3]! });
  }
  const dupRe = /^- (\S+): (.+?)(?: \((\d{4}-\d{2}-\d{2})\))?$/;
  let inDup = false;
  for (const line of parsed.content.split('\n')) {
    if (line.startsWith('## ')) inDup = /gleichnamige|same-name/i.test(line);
    if (!inDup) continue;
    const m = dupRe.exec(line.trim());
    if (m) out.duplicates.push({ name: m[1]!, paths: m[2]!.split(',').map((x) => normalizeFolder(x.trim())).filter(Boolean), noted: m[3] ?? '' });
  }
  // Fallback: the first format kept the rows in the frontmatter.
  if (out.folders.length === 0 && Array.isArray(data.folders)) {
    for (const f of data.folders as unknown[]) {
      if (!f || typeof f !== 'object' || typeof (f as StructureFolder).path !== 'string') continue;
      const e = f as StructureFolder;
      out.folders.push({ path: normalizeFolder(e.path), purpose: String(e.purpose ?? ''), origin: asOrigin(e.origin), since: String(e.since ?? '') });
    }
  }
  if (out.duplicates.length === 0 && Array.isArray(data.duplicates)) {
    for (const d of data.duplicates as unknown[]) {
      if (!d || typeof d !== 'object' || typeof (d as StructureDuplicate).name !== 'string') continue;
      const e = d as StructureDuplicate;
      out.duplicates.push({ name: e.name, paths: Array.isArray(e.paths) ? e.paths.map(String) : [], noted: String(e.noted ?? '') });
    }
  }
  out.folders.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function saveStructureFile(wikiAbs: string, data: StructureFile): Promise<void> {
  const file = join(wikiAbs, structureFileName(data.language));
  const content = matter.stringify(renderBody(data), {
    language: data.language,
    template_version: data.template_version,
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
    ? 'Ein Ordner sagt, welche Art von Seite darin liegt. Diese Tabelle ist die Landkarte, die Deep beim Einordnen neuer Seiten liest. Die Sätze in der Spalte „Zweck" dürfen von Hand geändert werden; die Spalten Ordner, Herkunft und seit lässt man stehen.'
    : 'A folder says what kind of page lives in it. This table is the map Deep reads when it files new pages. Edit the sentences in the "Purpose" column by hand as you like; leave the Folder, Origin and since columns as they are.');
  lines.push('');
  lines.push(de ? '| Ordner | Zweck | Herkunft | seit |' : '| Folder | Purpose | Origin | since |');
  lines.push('|---|---|---|---|');
  for (const f of data.folders) lines.push(`| ${f.path} | ${f.purpose.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ')} | ${f.origin} | ${f.since} |`);
  if (data.duplicates.length > 0) {
    lines.push('', de ? '## Gleichnamige Seiten in mehreren Ordnern' : '## Same-name pages in several folders', '');
    for (const d of data.duplicates) lines.push(`- ${d.name}: ${d.paths.join(', ')} (${d.noted})`);
  }
  lines.push('', de ? `Vorlage: Version ${data.template_version || '—'} (aktuell ${t.version}).` : `Template: version ${data.template_version || '—'} (current ${t.version}).`);
  return lines.join('\n') + '\n';
}
