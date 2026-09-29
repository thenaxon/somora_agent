// How Lucid cuts the wiki into calls — by size, not by folder.
//
// Why (2026-09-29): Lucid used to send one call per top-level folder
// with every page in full. On a grown wiki that meant 71 small calls;
// after the migration onto the template it meant three calls of 300 to
// 540 KB (projekte, infrastruktur, wissen) — past what a worker reads
// in one message. Now a batch is as many pages of one folder (the
// page's own folder, subfolders included) as fit `maxChars`; a page
// larger than that travels alone. A grown wiki gets the same many
// small batches as before, a migrated one gets its big folders in
// parts. Pure functions, no I/O.

export interface LucidPage {
  wikiPath: string;
  markdown: string;
}

export interface LucidBatch {
  /** The folder the pages live in (`infrastruktur/hosts`; `(root)` for pages in the wiki root). */
  folder: string;
  /** 1-based part number within the folder and the number of parts. */
  part: number;
  of: number;
  pages: LucidPage[];
  chars: number;
}

export const folderOf = (wikiPath: string): string => {
  const i = wikiPath.lastIndexOf('/');
  return i < 0 ? '(root)' : wikiPath.slice(0, i);
};

/**
 * Pack the pages into batches of at most `maxChars` markdown characters
 * per folder. Order: folders alphabetically, pages alphabetically, so a
 * run is reproducible and a folder's parts are contiguous.
 */
export function planLucidBatches(pages: LucidPage[], maxChars: number): LucidBatch[] {
  const byFolder = new Map<string, LucidPage[]>();
  for (const p of pages) {
    const f = folderOf(p.wikiPath);
    byFolder.set(f, [...(byFolder.get(f) ?? []), p]);
  }
  const out: LucidBatch[] = [];
  for (const folder of [...byFolder.keys()].sort()) {
    const list = [...byFolder.get(folder)!].sort((a, b) => a.wikiPath.localeCompare(b.wikiPath));
    const parts: LucidPage[][] = [];
    let cur: LucidPage[] = [];
    let size = 0;
    for (const p of list) {
      const n = p.markdown.length;
      if (cur.length > 0 && size + n > maxChars) {
        parts.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(p);
      size += n;
    }
    if (cur.length > 0) parts.push(cur);
    parts.forEach((part, i) => out.push({ folder, part: i + 1, of: parts.length, pages: part, chars: part.reduce((s, p) => s + p.markdown.length, 0) }));
  }
  return out;
}

export const batchLabel = (b: LucidBatch): string => (b.of > 1 ? `${b.folder} (${b.part}/${b.of})` : b.folder);

/** The first sentence-ish of a page body, for sibling lists and the cross pass. */
export function pageOpening(markdown: string, chars = 160): string {
  const body = markdown.replace(/^---[\s\S]*?---\n/, '').replace(/^#\s.+\n/m, '');
  const text = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ');
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

/**
 * What a batch sees beside its pages: the other pages of the same top
 * folder as one line each, so a contradiction with a sibling that is in
 * another part is still visible by name. Bounded: at most `maxLines`.
 */
export function siblingList(batch: LucidBatch, all: LucidPage[], maxLines = 200): string {
  const top = batch.folder === '(root)' ? '(root)' : batch.folder.split('/')[0]!;
  const inBatch = new Set(batch.pages.map((p) => p.wikiPath));
  const lines = all
    .filter((p) => (batch.folder === '(root)' ? folderOf(p.wikiPath) === '(root)' : p.wikiPath.startsWith(top + '/')) && !inBatch.has(p.wikiPath))
    .sort((a, b) => a.wikiPath.localeCompare(b.wikiPath))
    .slice(0, maxLines)
    .map((p) => `- [[${p.wikiPath}]] — ${pageOpening(p.markdown, 80)}`);
  return lines.join('\n');
}
