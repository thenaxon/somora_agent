// Wiki-Lint deterministic detectors (Phase 4 / Stufe 5).
//
// Each detector is a pure function: given a snapshot of the wiki tree
// (pages map + index.md content), return an array of findings. No LLM,
// no I/O outside the snapshot. This keeps Dream-C's MVP fast and 100%
// deterministic — semantic checks (contradictions, stale time-relative
// claims) are deferred to a later stage with LLM dispatch.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { logger } from '../server/logger.ts';
import type {
  BrokenWikilinkFinding,
  IndexMissingFinding,
  IndexStaleFinding,
  LintFinding,
  OneWayLinkFinding,
  OrphanPageFinding,
} from './lint-types.ts';

export interface WikiSnapshot {
  /** Map: wiki-path (relative, no .md) → file content (full markdown). */
  pages: Map<string, string>;
  /** Content of index.md, or null if missing. */
  indexContent: string | null;
}

/** Walk the wiki subfolder and load all .md pages into memory. Skips
 *  the logs/ subdir and dotfile dirs. index.md is loaded separately. */
export async function readWikiSnapshot(wikiAbs: string): Promise<WikiSnapshot> {
  const pages = new Map<string, string>();
  let indexContent: string | null = null;

  const indexPath = join(wikiAbs, 'index.md');
  try {
    indexContent = await readFile(indexPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await walkPages(wikiAbs, wikiAbs, pages);
  return { pages, indexContent };
}

async function walkPages(
  root: string,
  current: string,
  out: Map<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'logs' && current === root) continue;
    if (e.name === 'index.md' && current === root) continue;
    const full = join(current, e.name);
    if (e.isDirectory()) {
      await walkPages(root, full, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const rel = relative(root, full).replace(/\.md$/, '');
      try {
        const content = await readFile(full, 'utf8');
        out.set(rel, content);
      } catch (err) {
        logger.warn({ msg: 'dream.lucid.page_unreadable', path: full, err: (err as Error).message });
      }
    }
  }
}

/** Find all `[[token]]` links in the page body. Returns the bare
 *  tokens (no surrounding brackets, no display-text suffix). */
export function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

let nextFindingId = 1;
function newId(): number {
  return nextFindingId++;
}

/** Reset the id counter — call once per lint run so findings within a
 *  single run get sequential ids 1..N. */
export function resetIdCounter(): void {
  nextFindingId = 1;
}

// ─── Check 1: broken wikilinks ──────────────────────────────────────

/** Every `[[X]]` token across all pages that points at a slug not in
 *  the snapshot. One finding per (in-page, broken-target) pair. */
export function detectBrokenWikilinks(snap: WikiSnapshot): BrokenWikilinkFinding[] {
  const out: BrokenWikilinkFinding[] = [];
  const allSlugs = new Set(snap.pages.keys());
  // Wikilinks can use either bare slug ('luca') or full path
  // ('personen/luca'). We accept both — the wiki tree is canonical.
  for (const [page, content] of snap.pages) {
    const links = extractWikilinks(content);
    for (const target of links) {
      if (allSlugs.has(target)) continue;
      // Check if the bare basename matches any slug — common when an
      // agent wrote [[luca]] but the page is actually personen/luca.
      let suggested: string | undefined;
      const matches = [...allSlugs].filter((s) => s.endsWith(`/${target}`));
      if (matches.length === 1) suggested = matches[0];
      out.push({
        id: newId(),
        kind: 'broken_wikilink',
        status: 'pending',
        in_page: page,
        broken_target: target,
        ...(suggested ? { suggested_target: suggested } : {}),
        reason: suggested
          ? `[[${target}]] in ${page} doesn't match any wiki page; closest match is ${suggested}`
          : `[[${target}]] in ${page} points at a non-existent wiki page`,
      });
    }
  }
  return out;
}

// ─── Check 2: orphan pages ──────────────────────────────────────────

/** A page that is NOT linked from any other page AND not listed in
 *  index.md. Could be intentional (deep-archive) but usually means
 *  it slipped through the index regen. */
export function detectOrphanPages(snap: WikiSnapshot): OrphanPageFinding[] {
  const out: OrphanPageFinding[] = [];
  const referenced = new Set<string>();

  // Pages referenced by other pages
  for (const [, content] of snap.pages) {
    for (const target of extractWikilinks(content)) {
      referenced.add(target);
      // Bare-slug → full-path resolution
      for (const slug of snap.pages.keys()) {
        if (slug.endsWith(`/${target}`)) referenced.add(slug);
      }
    }
  }
  // Pages referenced from index.md
  if (snap.indexContent) {
    for (const target of extractWikilinks(snap.indexContent)) {
      referenced.add(target);
      for (const slug of snap.pages.keys()) {
        if (slug.endsWith(`/${target}`)) referenced.add(slug);
      }
    }
  }

  for (const page of snap.pages.keys()) {
    if (referenced.has(page)) continue;
    out.push({
      id: newId(),
      kind: 'orphan_page',
      status: 'pending',
      page,
      reason:
        `${page} exists but is not linked from any other wiki page or from index.md — ` +
        `either user-deleted by mistake (and the page is stale), or genuinely standalone (in which case add it to index.md)`,
    });
  }
  return out;
}

// ─── Check 3: index drift — missing entries ─────────────────────────

/** Pages that exist in the wiki tree but don't appear in index.md. */
export function detectIndexMissing(snap: WikiSnapshot): IndexMissingFinding[] {
  if (!snap.indexContent) return [];
  const out: IndexMissingFinding[] = [];
  const indexLinks = new Set(extractWikilinks(snap.indexContent));
  for (const page of snap.pages.keys()) {
    if (indexLinks.has(page)) continue;
    // bare slug match
    const bare = page.includes('/') ? page.split('/').pop()! : page;
    if (indexLinks.has(bare)) continue;
    out.push({
      id: newId(),
      kind: 'index_missing',
      status: 'pending',
      page,
      reason: `${page} exists in the wiki tree but is not listed in index.md`,
    });
  }
  return out;
}

// ─── Check 4: index drift — stale entries ───────────────────────────

/** index.md links a page that no longer exists in the tree. */
export function detectIndexStale(snap: WikiSnapshot): IndexStaleFinding[] {
  if (!snap.indexContent) return [];
  const out: IndexStaleFinding[] = [];
  const allSlugs = new Set(snap.pages.keys());
  for (const target of extractWikilinks(snap.indexContent)) {
    if (allSlugs.has(target)) continue;
    // bare slug → full-path resolution check
    const matches = [...allSlugs].filter((s) => s.endsWith(`/${target}`));
    if (matches.length > 0) continue;
    out.push({
      id: newId(),
      kind: 'index_stale',
      status: 'pending',
      page: target,
      reason: `index.md references ${target} but no such wiki page exists`,
    });
  }
  return out;
}

// ─── Check 5: one-way cross-references ──────────────────────────────

/** Page A `[[B]]`s, but B doesn't `[[A]]` back. Suggests adding a
 *  backlink. We only flag when the from-page is referenced AT LEAST
 *  TWICE from the to-page's content area to avoid noise. */
export function detectOneWayLinks(snap: WikiSnapshot): OneWayLinkFinding[] {
  const out: OneWayLinkFinding[] = [];
  // links[from] = set of pages from links to
  const links = new Map<string, Set<string>>();
  for (const [from, content] of snap.pages) {
    const targets = extractWikilinks(content);
    const resolved = new Set<string>();
    for (const t of targets) {
      if (snap.pages.has(t)) {
        resolved.add(t);
        continue;
      }
      const matches = [...snap.pages.keys()].filter((s) => s.endsWith(`/${t}`));
      if (matches.length === 1) resolved.add(matches[0]!);
    }
    links.set(from, resolved);
  }
  for (const [from, targets] of links) {
    for (const to of targets) {
      const back = links.get(to);
      if (!back) continue; // page exists with no outgoing links — fine
      if (back.has(from)) continue; // already symmetric
      out.push({
        id: newId(),
        kind: 'one_way_link',
        status: 'pending',
        from_page: from,
        to_page: to,
        reason:
          `${from} links to ${to} but ${to} doesn't link back. Either add a [[${from}]] reference in ${to}, ` +
          `or this is intentional (one-sided relationship) and the finding can be dismissed.`,
      });
    }
  }
  return out;
}

// ─── Combined run ───────────────────────────────────────────────────

export interface DetectorResult {
  findings: LintFinding[];
  pagesScanned: number;
}

/** Run all deterministic detectors against a snapshot. Returns one
 *  combined findings array. Order: broken_wikilink, orphan_page,
 *  index_missing, index_stale, one_way_link. */
export function runAllDetectors(snap: WikiSnapshot): DetectorResult {
  resetIdCounter();
  const findings: LintFinding[] = [
    ...detectBrokenWikilinks(snap),
    ...detectOrphanPages(snap),
    ...detectIndexMissing(snap),
    ...detectIndexStale(snap),
    ...detectOneWayLinks(snap),
  ];
  return {
    findings,
    pagesScanned: snap.pages.size,
  };
}

// ─── Helpers (exported for tests) ───────────────────────────────────

/** Stat helper, used by tests / future timestamp-aware checks. */
export async function pageMtime(wikiAbs: string, slug: string): Promise<number | null> {
  try {
    const st = await stat(join(wikiAbs, `${slug}.md`));
    return st.mtimeMs;
  } catch {
    return null;
  }
}
