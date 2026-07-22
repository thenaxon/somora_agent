// Read-only wiki index for the Web UI's Wiki Explorer.
//
// Walks the configured wiki root, extracts per-page metadata and the
// `[[wikilink]]` graph, and serves tree / page / graph / backlink views
// from an in-process cache. Nothing here writes to disk — the wiki is
// owned by Deep/Lucid, and the explorer is a viewer.
//
// Why a separate scanner rather than the memory index: that index stores
// *chunks* for retrieval (embeddings + FTS), not page identity or link
// edges. Rebuilding the graph from chunk rows would mean reassembling
// pages from fragments. A direct walk over ~260 files takes single-digit
// milliseconds and stays honest about what's on disk.
//
// Cache strategy: every request re-stats the tree (cheap) and re-parses
// only files whose mtime or size moved. A page edited in Obsidian shows
// up on the next request without a restart and without a watcher.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import matter from 'gray-matter';
import { logger } from '../server/logger.ts';

/** One wiki page as the explorer sees it. */
export interface WikiPageMeta {
  /** Path relative to the wiki root without `.md`, e.g. `personen/rene`. */
  slug: string;
  /** Absolute path on disk. */
  file: string;
  /** First `# H1`, else the frontmatter title, else the filename. */
  title: string;
  /** First non-empty prose line, clipped. Used as tree/graph tooltip. */
  description: string;
  /** Top-level folder, `''` for pages sitting directly in the root. */
  folder: string;
  mtimeMs: number;
  size: number;
  /** Outgoing edges that resolved to a real page, deduped. */
  links: string[];
  /** Link targets that matched no page. Kept so the UI can show them
   *  as broken instead of silently dropping them. */
  unresolved: string[];
  /** Frontmatter `related:` entries that resolved, deduped. */
  related: string[];
}

export interface WikiTreeDir {
  type: 'dir';
  name: string;
  path: string;
  children: WikiTreeNode[];
}

export interface WikiTreePage {
  type: 'page';
  name: string;
  slug: string;
  title: string;
  description: string;
  mtimeMs: number;
}

export type WikiTreeNode = WikiTreeDir | WikiTreePage;

export interface WikiGraphNode {
  id: string;
  label: string;
  folder: string;
  /** Outgoing + incoming edge count across the WHOLE wiki, not just the
   *  returned subgraph — so a local view can still show that a node is
   *  a hub. */
  degree: number;
}

export interface WikiGraphEdge {
  from: string;
  to: string;
  type: 'wikilink' | 'related';
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  edges: WikiGraphEdge[];
  /** True when a global graph was clipped by the node cap. */
  truncated: boolean;
}

export interface WikiIndex {
  root: string;
  builtAt: number;
  pages: Map<string, WikiPageMeta>;
  /** slug → slugs that link TO it. */
  backlinks: Map<string, string[]>;
  /** lowercase basename → slugs, for Obsidian-style short links. */
  byBasename: Map<string, string[]>;
  /** Wall-clock of the last on-disk stat sweep (see RESCAN_TTL_MS). */
  scannedAt: number;
}

/** Directories never walked — Obsidian internals and VCS noise. */
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

/** `[[target]]`, `[[target|alias]]`, `[[target#heading]]`.
 *
 *  Newlines are excluded from every group on purpose. Dream-B clips page
 *  descriptions in index.md without respecting link boundaries, which
 *  leaves half-open `[[foo…` fragments behind; a newline-tolerant regex
 *  swallows the rest of the file into one bogus "target". */
const WIKILINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;

/** Machine-generated pages kept out of the graph. `index.md` links to
 *  every page by construction — including it turns the global graph
 *  into a star around one node and adds 250 edges that say nothing
 *  about how the knowledge actually connects. It stays readable in the
 *  tree; it just isn't a relationship. */
const GRAPH_EXCLUDED_SLUGS = new Set(['index']);

/** How long a scan is trusted before re-stating the tree. The reference
 *  wiki lives on a CIFS mount where 262 stats cost ~550 ms, and a wiki
 *  window fires tree + page + graph in one breath. Edits still appear
 *  within this window plus one request. */
const RESCAN_TTL_MS = 10_000;

/** Hard cap on nodes returned for a global graph. The reference wiki is
 *  258 pages; the cap exists so a 5000-page vault degrades into
 *  "the most connected 400" instead of freezing the browser. */
const GLOBAL_GRAPH_MAX_NODES = 400;

let cache: WikiIndex | null = null;
let building: Promise<WikiIndex> | null = null;

/** Drop the cache. Called by the refresh route. */
export function invalidateWikiIndex(): void {
  cache = null;
}

/**
 * Build or refresh the index for `root`.
 *
 * Concurrent callers share one build — without the `building` latch a
 * burst of tree/page/graph requests from a freshly-opened window would
 * each walk the tree.
 */
export async function getWikiIndex(root: string): Promise<WikiIndex> {
  if (cache && cache.root === root) {
    if (Date.now() - cache.scannedAt < RESCAN_TTL_MS) return cache;
    return refreshIndex(cache);
  }
  if (building) return building;
  building = buildIndex(root).finally(() => {
    building = null;
  });
  return building;
}

async function buildIndex(root: string): Promise<WikiIndex> {
  const started = Date.now();
  const files = await walk(root, root);
  const pages = new Map<string, WikiPageMeta>();
  for (const f of files) {
    const meta = await parsePage(root, f.file, f.mtimeMs, f.size);
    if (meta) pages.set(meta.slug, meta);
  }
  const index: WikiIndex = {
    root,
    builtAt: Date.now(),
    scannedAt: Date.now(),
    pages,
    backlinks: new Map(),
    byBasename: new Map(),
  };
  linkUp(index);
  cache = index;
  logger.info({
    msg: 'wiki.explorer.indexed',
    root,
    pages: pages.size,
    ms: Date.now() - started,
  });
  return index;
}

/**
 * Re-stat the tree and re-parse only what moved. Returns the same index
 * object when nothing changed, so callers can rely on identity for
 * cheap change detection.
 */
async function refreshIndex(index: WikiIndex): Promise<WikiIndex> {
  const files = await walk(index.root, index.root);
  index.scannedAt = Date.now();
  const seen = new Set<string>();
  let changed = false;
  for (const f of files) {
    const slug = toSlug(index.root, f.file);
    seen.add(slug);
    const known = index.pages.get(slug);
    if (known && known.mtimeMs === f.mtimeMs && known.size === f.size) continue;
    const meta = await parsePage(index.root, f.file, f.mtimeMs, f.size);
    if (meta) {
      index.pages.set(meta.slug, meta);
      changed = true;
    }
  }
  for (const slug of [...index.pages.keys()]) {
    if (!seen.has(slug)) {
      index.pages.delete(slug);
      changed = true;
    }
  }
  if (changed) {
    linkUp(index);
    index.builtAt = Date.now();
    logger.debug({ msg: 'wiki.explorer.refreshed', pages: index.pages.size });
  }
  return index;
}

async function walk(
  root: string,
  dir: string,
): Promise<Array<{ file: string; mtimeMs: number; size: number }>> {
  const out: Array<{ file: string; mtimeMs: number; size: number }> = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(root, abs)));
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith('.md')) continue;
    try {
      const st = await stat(abs);
      out.push({ file: abs, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // Vanished between readdir and stat — skip it.
    }
  }
  return out;
}

function toSlug(root: string, file: string): string {
  return relative(root, file).replace(/\.md$/i, '').split(sep).join('/');
}

async function parsePage(
  root: string,
  file: string,
  mtimeMs: number,
  size: number,
): Promise<WikiPageMeta | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const slug = toSlug(root, file);
  const parsed = matter(raw);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const body = parsed.content;

  const h1 = /^#\s+(.+)$/m.exec(body);
  const title =
    h1?.[1]?.trim() ||
    (typeof fm.title === 'string' && fm.title.trim()) ||
    slug.split('/').pop() ||
    slug;

  const rawLinks: string[] = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim();
    if (target) rawLinks.push(target);
  }
  const related = Array.isArray(fm.related)
    ? fm.related.filter((r): r is string => typeof r === 'string')
    : [];

  return {
    slug,
    file,
    title,
    description: firstProseLine(body),
    folder: slug.includes('/') ? slug.split('/')[0]! : '',
    mtimeMs,
    size,
    // Resolution needs the full page set, so it happens in linkUp().
    // These carry the raw targets until then.
    links: rawLinks,
    unresolved: [],
    related,
  };
}

/** First line of running prose, skipping headings, lists, frontmatter
 *  leftovers and wikilink-only lines. Clipped for tooltips. */
function firstProseLine(body: string): string {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#') || t.startsWith('-') || t.startsWith('*') || t.startsWith('>')) continue;
    if (t.startsWith('|') || t.startsWith('```')) continue;
    const plain = t.replace(WIKILINK_RE, (_m, target: string, alias?: string) => alias ?? target);
    return plain.length > 200 ? `${plain.slice(0, 200).trimEnd()}…` : plain;
  }
  return '';
}

/**
 * Resolve raw link targets to slugs and compute backlinks.
 *
 * Resolution order, first match wins:
 *   1. exact slug            `[[personen/rene-siegl]]`
 *   2. case-insensitive slug
 *   3. unique basename       `[[rene-siegl]]`  (Obsidian's short form)
 *
 * A basename that matches several pages stays unresolved rather than
 * picking one arbitrarily — a wrong edge in the graph is worse than a
 * missing one, because it reads as a real relationship.
 */
function linkUp(index: WikiIndex): void {
  const bySlugLower = new Map<string, string>();
  index.byBasename = new Map();
  for (const slug of index.pages.keys()) {
    bySlugLower.set(slug.toLowerCase(), slug);
    const base = (slug.split('/').pop() ?? slug).toLowerCase();
    const list = index.byBasename.get(base) ?? [];
    list.push(slug);
    index.byBasename.set(base, list);
  }

  const resolve = (target: string): string | null => {
    const clean = target.replace(/\.md$/i, '').replace(/^\/+/, '');
    if (index.pages.has(clean)) return clean;
    const lower = bySlugLower.get(clean.toLowerCase());
    if (lower) return lower;
    const byBase = index.byBasename.get(clean.split('/').pop()!.toLowerCase());
    if (byBase && byBase.length === 1) return byBase[0]!;
    return null;
  };

  const backlinks = new Map<string, Set<string>>();
  for (const page of index.pages.values()) {
    const resolved = new Set<string>();
    const unresolved = new Set<string>();
    for (const target of page.links) {
      const hit = resolve(target);
      if (hit && hit !== page.slug) resolved.add(hit);
      else if (!hit) unresolved.add(target);
    }
    const relatedResolved = new Set<string>();
    for (const target of page.related) {
      const hit = resolve(target);
      if (hit && hit !== page.slug) relatedResolved.add(hit);
    }
    page.links = [...resolved].sort();
    page.unresolved = [...unresolved].sort();
    page.related = [...relatedResolved].sort();
    for (const to of [...resolved, ...relatedResolved]) {
      const set = backlinks.get(to) ?? new Set<string>();
      set.add(page.slug);
      backlinks.set(to, set);
    }
  }
  index.backlinks = new Map([...backlinks].map(([k, v]) => [k, [...v].sort()]));
}

// ─── Public views ────────────────────────────────────────────────────

export function buildTree(index: WikiIndex): WikiTreeNode[] {
  const rootNodes: WikiTreeNode[] = [];
  const dirs = new Map<string, WikiTreeDir>();

  const ensureDir = (path: string): WikiTreeDir => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const parts = path.split('/');
    const node: WikiTreeDir = {
      type: 'dir',
      name: parts[parts.length - 1]!,
      path,
      children: [],
    };
    dirs.set(path, node);
    if (parts.length === 1) rootNodes.push(node);
    else ensureDir(parts.slice(0, -1).join('/')).children.push(node);
    return node;
  };

  for (const page of [...index.pages.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const parts = page.slug.split('/');
    const leaf: WikiTreePage = {
      type: 'page',
      name: `${parts[parts.length - 1]!}.md`,
      slug: page.slug,
      title: page.title,
      description: page.description,
      mtimeMs: page.mtimeMs,
    };
    if (parts.length === 1) rootNodes.push(leaf);
    else ensureDir(parts.slice(0, -1).join('/')).children.push(leaf);
  }

  const sortNodes = (nodes: WikiTreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      const an = a.type === 'dir' ? a.name : a.title;
      const bn = b.type === 'dir' ? b.name : b.title;
      return an.localeCompare(bn);
    });
    for (const n of nodes) if (n.type === 'dir') sortNodes(n.children);
  };
  sortNodes(rootNodes);
  return rootNodes;
}

export function getPage(
  index: WikiIndex,
  slug: string,
): { meta: WikiPageMeta; backlinks: WikiPageMeta[] } | null {
  const meta = index.pages.get(slug);
  if (!meta) return null;
  const backlinks = (index.backlinks.get(slug) ?? [])
    .map((s) => index.pages.get(s))
    .filter((p): p is WikiPageMeta => Boolean(p));
  return { meta, backlinks };
}

export async function readPageMarkdown(meta: WikiPageMeta): Promise<string> {
  return readFile(meta.file, 'utf8');
}

function degreeOf(index: WikiIndex, slug: string): number {
  const out = index.pages.get(slug)?.links.length ?? 0;
  return out + (index.backlinks.get(slug)?.length ?? 0);
}

function toNode(index: WikiIndex, slug: string): WikiGraphNode {
  const p = index.pages.get(slug);
  return {
    id: slug,
    label: p?.title ?? slug,
    folder: p?.folder ?? '',
    degree: degreeOf(index, slug),
  };
}

/**
 * Neighbourhood of one page: the page, everything it points at, and
 * everything pointing at it. Edges among the neighbours are included
 * too — without them the local graph is a star and says nothing about
 * how the neighbours relate to each other.
 */
export function localGraph(index: WikiIndex, slug: string): WikiGraph | null {
  if (!index.pages.has(slug)) return null;
  const page = index.pages.get(slug)!;
  const members = new Set<string>([slug]);
  for (const to of page.links) if (!GRAPH_EXCLUDED_SLUGS.has(to)) members.add(to);
  for (const to of page.related) if (!GRAPH_EXCLUDED_SLUGS.has(to)) members.add(to);
  for (const from of index.backlinks.get(slug) ?? []) {
    if (!GRAPH_EXCLUDED_SLUGS.has(from)) members.add(from);
  }

  const edges: WikiGraphEdge[] = [];
  for (const from of members) {
    const p = index.pages.get(from);
    if (!p) continue;
    for (const to of p.links) if (members.has(to)) edges.push({ from, to, type: 'wikilink' });
    for (const to of p.related) if (members.has(to)) edges.push({ from, to, type: 'related' });
  }
  return {
    nodes: [...members].map((s) => toNode(index, s)),
    edges: dedupeEdges(edges),
    truncated: false,
  };
}

/**
 * The whole wiki. Capped at the most-connected GLOBAL_GRAPH_MAX_NODES
 * pages; `truncated` tells the UI to say so rather than presenting a
 * partial graph as complete.
 */
export function globalGraph(index: WikiIndex): WikiGraph {
  const all = [...index.pages.keys()].filter((s) => !GRAPH_EXCLUDED_SLUGS.has(s));
  const truncated = all.length > GLOBAL_GRAPH_MAX_NODES;
  const kept = truncated
    ? all
        .map((s) => ({ s, d: degreeOf(index, s) }))
        .sort((a, b) => b.d - a.d || a.s.localeCompare(b.s))
        .slice(0, GLOBAL_GRAPH_MAX_NODES)
        .map((x) => x.s)
    : all;
  const members = new Set(kept);
  const edges: WikiGraphEdge[] = [];
  for (const from of members) {
    const p = index.pages.get(from);
    if (!p) continue;
    for (const to of p.links) if (members.has(to)) edges.push({ from, to, type: 'wikilink' });
    for (const to of p.related) if (members.has(to)) edges.push({ from, to, type: 'related' });
  }
  return {
    nodes: [...members].map((s) => toNode(index, s)),
    edges: dedupeEdges(edges),
    truncated,
  };
}

function dedupeEdges(edges: WikiGraphEdge[]): WikiGraphEdge[] {
  const seen = new Set<string>();
  const out: WikiGraphEdge[] = [];
  for (const e of edges) {
    const key = `${e.from} ${e.to} ${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Resolve a `[[target]]` the way the reader needs it: same rules as the
 * index, exposed for the page route so the UI can turn an arbitrary
 * link into a slug without duplicating the logic in TypeScript on the
 * client.
 */
export function resolveLinkTargets(
  index: WikiIndex,
  targets: string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const t of targets) {
    const clean = t.replace(/\.md$/i, '').replace(/^\/+/, '');
    if (index.pages.has(clean)) {
      out[t] = clean;
      continue;
    }
    const lower = [...index.pages.keys()].find((s) => s.toLowerCase() === clean.toLowerCase());
    if (lower) {
      out[t] = lower;
      continue;
    }
    const byBase = index.byBasename.get(clean.split('/').pop()!.toLowerCase());
    out[t] = byBase && byBase.length === 1 ? byBase[0]! : null;
  }
  return out;
}
