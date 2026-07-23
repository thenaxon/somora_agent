// Per-agent memory manager. Public surface for memory operations:
//   - init() / close()                  — lifecycle
//   - reindex(file)                     — read markdown + chunk + embed + store
//   - reindexAll()                      — full sweep over watched roots
//   - search(query, opts)               — hybrid retrieval
//   - listNotes(filter?)                — list memory notes (no content)
//   - getNote(slug)                     — read one note's markdown
//   - writeNote(slug, body, frontmatter?) — create/replace memory note
//   - deleteNote(slug)                  — remove memory note
//
// One instance per (agent, source-set). Server constructs one for each
// agent on first reference and caches it.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import matter from 'gray-matter';
import type { MemoryConfig } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { chunkMarkdown } from './chunking.ts';
import { resolveEmbeddingProvider, type EmbeddingProvider } from './embeddings.ts';
import { hybridSearch, type Hit } from './retrieval.ts';
import {
  closeMemoryDb,
  deleteFile as dbDeleteFile,
  ensureVecTable,
  listAllFiles,
  openMemoryDb,
  pruneOrphanVecRows,
  replaceFileChunks,
  upsertFile,
  type MemoryDb,
} from './storage.ts';
import { MarkdownWatcher, type FileEvent } from './watcher.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Per-entry description budget in the stage-2 wiki overview. */
const WIKI_OVERVIEW_DESC_CHARS = 100;

/** `## Heading` — starts a section of the wiki index. */
const WIKI_INDEX_SECTION_RE = /^##\s+(.+?)\s*$/;

/**
 * A wiki-index list item: `- [[pfad/seite]] — description`.
 *
 * Anchored, and it captures only the FIRST wikilink of the line. Links
 * further along are prose (`… gehört zu [[personen/xy|Renes]] Team`),
 * not pages.
 */
const WIKI_INDEX_ENTRY_RE = /^[-*]\s*(\[\[[^\]|]+(?:\|[^\]]*)?\]\])\s*(?:[—–-]\s*)?(.*)$/;

/** One `## Section` of the wiki index plus the pages listed under it. */
interface WikiIndexSection {
  title: string;
  entries: Array<{ link: string; desc: string }>;
}

/**
 * Parse a Dream-B `index.md` into sections and page entries.
 *
 * The shortener this replaced ran a global `/\[\[[^\]]+\]\]/g` over each
 * line, which counted description prose as pages. On the reference wiki
 * (2026-07-22, 258 pages in 25 sections) that turned a 30-slot budget
 * into 22 distinct pages from 7 sections — `Projekte` (60 pages),
 * `Wissen` (75) and `Infrastruktur` (26) never appeared at all, because
 * the sections are emitted alphabetically and the budget ran out at "B".
 * Matching only the leading link removes the duplicates by construction.
 *
 * Returns [] when the file isn't in this shape; the caller falls back to
 * a plain truncation rather than inventing structure.
 */
function parseWikiIndex(raw: string): WikiIndexSection[] {
  const sections: WikiIndexSection[] = [];
  let current: WikiIndexSection | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    const heading = WIKI_INDEX_SECTION_RE.exec(trimmed);
    if (heading) {
      current = { title: heading[1]!, entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const entry = WIKI_INDEX_ENTRY_RE.exec(trimmed);
    if (entry) current.entries.push({ link: entry[1]!, desc: entry[2]!.trim() });
  }
  return sections.filter((s) => s.entries.length > 0);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max).trimEnd()}…`;
}

/**
 * Shorten a wiki `index.md` to fit `maxChars`. Pure — exported so the
 * stage ladder is testable without a MemoryManager instance.
 *
 * Four stages, each a strictly lower information density than the last,
 * but every one of them covering the WHOLE wiki:
 *
 *   1. index.md verbatim                          (small wiki)
 *   2. sections + pages + clipped descriptions
 *   3. sections + bare page links
 *   4. section names + page counts                (very large wiki)
 *
 * Stage 4 is a taxonomy, not a sample, and that is the point. Knowing
 * "there is a Projekte section with 60 pages" is what makes an agent
 * reach for `memory_search`; a partial list of page names implies the
 * listed pages are all there is, which is worse than no overview.
 */
export function renderWikiOverview(
  raw: string,
  opts: { maxChars: number; topNSlugs: number },
): string {
  // Stage 1 — fits as-is.
  if (raw.length <= opts.maxChars) return raw.trimEnd();

  const sections = parseWikiIndex(raw);
  if (sections.length === 0) {
    // Index isn't in the conventional Dream-B shape. Hard-truncate
    // instead of guessing: the head of the file is at least structured
    // markdown, which is more use than a bag of extracted tokens.
    return `${raw.slice(0, opts.maxChars).trimEnd()}\n…`;
  }

  // Stage 2 — everything, descriptions clipped.
  const withDesc = sections
    .map((s) =>
      [
        `## ${s.title}`,
        ...s.entries.map(
          (e) => `- ${e.link}${e.desc ? ` — ${clip(e.desc, WIKI_OVERVIEW_DESC_CHARS)}` : ''}`,
        ),
      ].join('\n'),
    )
    .join('\n\n');
  if (withDesc.length <= opts.maxChars) return withDesc;

  // Stage 3 — every page still named, descriptions dropped.
  const bare = sections
    .map((s) => `## ${s.title}\n${s.entries.map((e) => e.link).join(' ')}`)
    .join('\n\n');
  if (bare.length <= opts.maxChars) return bare;

  // Stage 4 — taxonomy + counts. topNSlugs caps how many sections
  // survive; the largest ones win, then they're re-sorted by name so the
  // block reads like the index it stands in for.
  const total = sections.reduce((n, s) => n + s.entries.length, 0);
  const ranked = [...sections]
    .sort((a, b) => b.entries.length - a.entries.length)
    .slice(0, opts.topNSlugs)
    .sort((a, b) => a.title.localeCompare(b.title));
  const dropped = sections.length - ranked.length;
  const taxonomy = [
    `# Wiki sections (${total} pages)`,
    ...ranked.map((s) => `- ${s.title} (${s.entries.length})`),
    ...(dropped > 0 ? [`- … and ${dropped} smaller sections`] : []),
  ].join('\n');
  return taxonomy.length <= opts.maxChars
    ? taxonomy
    : `${taxonomy.slice(0, opts.maxChars).trimEnd()}\n…`;
}

export interface ObsidianSource {
  vaultPath: string;
}

/**
 * Server-global wiki layer (Phase 4) — a designated subfolder inside the
 * vault that Dream-B writes to and all agents share. Files here index
 * with `source: 'wiki'` instead of `source: 'vault'` so retrieval can
 * apply a higher boost. See `private/wiki-design.md`.
 */
export interface WikiSource {
  /** Absolute path to <vault>/<wikiSubfolder>. */
  absPath: string;
}

/** Source label written to the chunks table and surfaced in hits. */
export type ChunkSource = 'memory' | 'vault' | 'wiki';

export interface ManagerOptions {
  agent: string;
  config: MemoryConfig;
  /** Optional Obsidian read-source. */
  obsidian?: ObsidianSource;
  /** Optional somora-wiki layer (a subfolder of the vault). Only set
   *  when config.wiki.enabled is true and obsidian is configured. */
  wiki?: WikiSource;
  /** Optional per-source score multipliers for retrieval. Wired up
   *  from config.wiki.search when wiki is enabled. */
  searchBoosts?: { wiki: number; memory: number; vault: number };
}

export interface NoteSummary {
  slug: string;
  source: ChunkSource;
  path: string;
  description?: string;
  tags?: string[];
  updatedAt: number;
}

export class MemoryManager {
  private memDb: MemoryDb | null = null;
  private embedder: EmbeddingProvider | null = null;
  private watcher: MarkdownWatcher | null = null;
  private agent: string;
  private cfg: MemoryConfig;
  private obsidian?: ObsidianSource;
  private wiki?: WikiSource;
  private searchBoosts?: { wiki: number; memory: number; vault: number };
  private lastEmbedderRetry = 0;

  constructor(opts: ManagerOptions) {
    this.agent = opts.agent;
    this.cfg = opts.config;
    this.obsidian = opts.obsidian;
    this.wiki = opts.wiki;
    this.searchBoosts = opts.searchBoosts;
  }

  get memoryRoot(): string {
    // Flat layout: user-facing notes live directly under memory/<slug>.md.
    // Automation-generated stuff (future Dream-findings, internal caches)
    // lives in dot-prefixed subdirs (`memory/.dreams/`, `memory/.cache/`)
    // which the watcher and walker skip by convention.
    return join(SOMORA_HOME, 'agents', this.agent, 'memory');
  }
  get dbPath(): string {
    return join(SOMORA_HOME, 'agents', this.agent, 'memory.db');
  }

  async init(): Promise<void> {
    if (this.memDb) return;
    await mkdir(this.memoryRoot, { recursive: true });
    this.memDb = openMemoryDb(this.dbPath);

    // Lazy-init embedder. If it fails (model download blocked, ONNX
    // missing, transient network), we degrade to FTS-only — but
    // ensureEmbedder() will retry on subsequent searches so we recover
    // automatically once the underlying issue is resolved.
    await this.ensureEmbedder();

    await this.reindexAll();

    const roots = [this.memoryRoot];
    if (this.obsidian?.vaultPath) roots.push(this.obsidian.vaultPath);
    const ignored = this.buildIgnored();
    this.watcher = new MarkdownWatcher({
      roots,
      ignored,
      onEvent: (e) => this.handleFileEvent(e),
    });
    this.watcher.start();
  }

  private buildIgnored(): Array<(path: string) => boolean> {
    // chokidar 5 evaluates `ignored` against absolute paths. A naive
    // dotfile-regex like `/(^|[\\/])\../` blocks the entire ~/.somora tree
    // because `.somora` itself contains a dot. We therefore go function-
    // based and only exclude components RELATIVE to a watched root.
    const memRoot = this.memoryRoot;
    const vault = this.obsidian?.vaultPath;
    const roots = [memRoot, ...(vault ? [vault] : [])];

    return [
      (path: string) => {
        // Never exclude the watched root itself.
        if (roots.includes(path)) return false;
        for (const root of roots) {
          if (path.startsWith(root + '/')) {
            const rel = path.slice(root.length + 1);
            const parts = rel.split('/');
            // Skip dot-prefixed components below the root (.dreams, .cache,
            // .obsidian/, .trash/, .git/, …)
            if (parts.some((c) => c.startsWith('.'))) return true;
            return false;
          }
        }
        return false;
      },
    ];
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
    if (this.memDb) {
      closeMemoryDb(this.memDb);
      this.memDb = null;
    }
  }

  private requireDb(): MemoryDb {
    if (!this.memDb) throw new Error('MemoryManager not initialized — call init() first');
    return this.memDb;
  }

  /**
   * Make sure the embedder is loaded. Throttled so a permanent failure
   * (e.g. broken model alias) doesn't hammer retries on every search;
   * but a transient failure (network blip during first-ever download,
   * config change between turns) recovers within ~60s.
   */
  private async ensureEmbedder(): Promise<boolean> {
    if (this.embedder) return true;
    if (!this.memDb) return false;
    const now = Date.now();
    if (now - this.lastEmbedderRetry < 60_000) return false;
    this.lastEmbedderRetry = now;
    try {
      const provider = await resolveEmbeddingProvider(this.cfg.embedding);
      ensureVecTable(this.memDb, provider.dim, provider.name);
      this.embedder = provider;
      logger.info({
        msg: 'memory.embedder_ready',
        agent: this.agent,
        model: provider.name,
        dim: provider.dim,
      });
      return true;
    } catch (err) {
      logger.warn({
        msg: 'memory.embedder_unavailable',
        agent: this.agent,
        err: (err as Error).message,
        hint: 'falling back to FTS-only retrieval; will retry in 60s on next search',
      });
      this.embedder = null;
      return false;
    }
  }

  private classifySource(path: string): ChunkSource | null {
    if (path.startsWith(this.memoryRoot)) return 'memory';
    // Wiki check goes BEFORE vault since the wiki subfolder lives
    // inside the vault. Order matters: vaultPath would also match.
    if (this.wiki && path.startsWith(this.wiki.absPath)) return 'wiki';
    if (this.obsidian && path.startsWith(this.obsidian.vaultPath)) {
      return 'vault';
    }
    return null;
  }

  private async handleFileEvent(e: FileEvent): Promise<void> {
    const source = this.classifySource(e.path);
    if (!source) return;
    if (e.kind === 'unlink') {
      dbDeleteFile(this.requireDb(), e.path);
      logger.info({ msg: 'memory.unindex', agent: this.agent, path: e.path });
      return;
    }
    try {
      await this.indexFile(e.path, source);
    } catch (err) {
      logger.warn({
        msg: 'memory.index_failed',
        agent: this.agent,
        path: e.path,
        err: (err as Error).message,
      });
    }
  }

  /** Walk a directory and yield .md file paths. */
  private async *walkMarkdown(root: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const full = join(root, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        yield* this.walkMarkdown(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        yield full;
      }
    }
  }

  async reindexAll(): Promise<{ indexed: number; skipped: number }> {
    const memDb = this.requireDb();
    let indexed = 0;
    let skipped = 0;

    const seen = new Set<string>();
    // Walk memory and vault. Files inside the wiki-subfolder are tagged
    // 'wiki' via classifySource — not via a separate walk root, since
    // the wiki lives inside the vault and would otherwise be visited
    // twice. classifySource checks wiki BEFORE vault.
    const roots: string[] = [this.memoryRoot];
    if (this.obsidian?.vaultPath) roots.push(this.obsidian.vaultPath);
    for (const root of roots) {
      for await (const path of this.walkMarkdown(root)) {
        seen.add(path);
        const source = this.classifySource(path);
        if (!source) continue;
        try {
          const r = await this.indexFile(path, source);
          if (r === 'indexed') indexed++;
          else skipped++;
        } catch (err) {
          logger.warn({
            msg: 'memory.reindex_file_failed',
            path,
            err: (err as Error).message,
          });
        }
      }
    }

    // Drop rows for files that vanished between runs
    for (const f of listAllFiles(memDb)) {
      if (!seen.has(f.path)) {
        dbDeleteFile(memDb, f.path);
        logger.info({ msg: 'memory.unindex_stale', path: f.path });
      }
    }

    // Sweep leftover vector rows whose chunk is gone (ghosts left by a
    // prior FTS-only process that deleted chunks it couldn't purge from
    // chunks_vec). Safe no-op unless the vec extension is loaded.
    const prunedVec = pruneOrphanVecRows(memDb);
    if (prunedVec > 0) {
      logger.info({ msg: 'memory.vec_orphans_pruned', agent: this.agent, pruned: prunedVec });
    }

    logger.info({ msg: 'memory.reindex_done', agent: this.agent, indexed, skipped });
    return { indexed, skipped };
  }

  private async indexFile(path: string, source: ChunkSource): Promise<'indexed' | 'skipped'> {
    const memDb = this.requireDb();
    const buf = await readFile(path);
    const stats = await stat(path);
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    // Hash check WITHOUT committing — the file row (hash) is written only
    // AFTER the chunks landed. Committing the hash first left a poisoned
    // state on partial failure: hash new + chunks stale → hash-match skips
    // the file forever and the stale chunks never heal.
    const existing = memDb.db
      .prepare(`SELECT hash FROM files WHERE path = ?`)
      .get(path) as { hash: string } | undefined;
    if (existing && existing.hash === hash) {
      // Defensive self-heal: a file row may exist with the current hash
      // while the chunks for it are missing — initial index crashed
      // mid-walk, a schema migration dropped the chunks table without
      // bumping mtimes, or someone manually wiped chunks. Returning
      // 'skipped' on hash-match alone would leave that file stuck
      // forever (next run keeps seeing the same hash). Verify a chunk
      // actually exists; if not, fall through to rebuild. Discovered
      // 2026-05-21 on buffet (238 files indexed, 0 chunks).
      const firstChunk = memDb.db
        .prepare(`SELECT id FROM chunks WHERE file_path = ? LIMIT 1`)
        .get(path) as { id: number } | undefined;
      if (firstChunk) {
        // Second self-heal: chunks indexed while the embedder was down
        // (or before one was configured) have no vec rows. Hash-match
        // skipped them forever → hybrid search stayed silently BM25-only
        // for those files. Embeddings are all-or-none per file, so
        // point-probing the first chunk's rowid suffices (vec0 supports
        // rowid point queries, same pattern as the delete path).
        const wantsVec = Boolean(this.embedder && memDb.hasVec);
        const hasVecRow = wantsVec
          ? memDb.db
              .prepare(`SELECT rowid FROM chunks_vec WHERE rowid = ?`)
              .get(BigInt(firstChunk.id))
          : null;
        if (!wantsVec || hasVecRow) return 'skipped';
        logger.info({ msg: 'memory.reembed_missing_vec', path });
      }
    }

    const text = buf.toString('utf8');
    const chunks = chunkMarkdown(text, this.cfg.chunking);
    if (chunks.length === 0) {
      // One transaction: file row (FK parent) + chunk wipe commit or roll
      // back together — see the comment on the main path below.
      memDb.db.transaction(() => {
        upsertFile(memDb, { path, source, hash, mtime: stats.mtimeMs, size: stats.size });
        replaceFileChunks(memDb, path, [], null);
      })();
      return 'indexed';
    }
    // Slug is path relative to the source-root (memory: memoryRoot;
    // wiki: wiki absPath so subfolder name is stripped; vault: vaultPath).
    // Hit-format uses `[source/slug]` so the slug should be stable across
    // sources without redundant prefixes.
    //
    // Wiki preserves `/` separators (e.g. `personen/anna`) to match the
    // Wikilinks Dream-B writes; vault and memory keep the historic `--`
    // convention so existing references don't break.
    const slug = source === 'memory'
      ? slugFromPath(path, this.memoryRoot)
      : source === 'wiki'
      ? slugFromPath(path, this.wiki!.absPath, { keepSeparators: true })
      : slugFromPath(path, this.obsidian!.vaultPath);

    let embeddings: Float32Array[] | null = null;
    if (this.embedder && memDb.hasVec) {
      try {
        embeddings = await this.embedder.embed(chunks.map((c) => c.text));
      } catch (err) {
        logger.warn({
          msg: 'memory.embed_failed',
          path,
          err: (err as Error).message,
        });
        embeddings = null;
      }
    }

    // Record the embedder name only when embeddings were actually written —
    // an embed failure falls back to FTS-only rows, and the model column
    // should say so (the vec self-heal above re-embeds them next pass).
    const modelName = embeddings ? this.embedder!.name : 'fts-only';
    // File row + chunk replacement in ONE transaction (replaceFileChunks'
    // inner transaction becomes a savepoint). The file row must come first
    // — chunks.file_path has a FK on files(path) — and atomicity is what
    // prevents the poisoned hash-new/chunks-stale state on crash: either
    // both commit or the old hash stays and the next pass redoes the file.
    memDb.db.transaction(() => {
      upsertFile(memDb, { path, source, hash, mtime: stats.mtimeMs, size: stats.size });
      replaceFileChunks(
        memDb,
        path,
        chunks.map((c) => ({
          file_path: path,
          source,
          slug,
          start_line: c.startLine,
          end_line: c.endLine,
          hash,
          model: modelName,
          text: c.text,
        })),
        embeddings,
      );
    })();
    return 'indexed';
  }

  // ── Public query surface ──────────────────────────────────────────────

  async search(
    query: string,
    opts?: {
      limit?: number;
      minScore?: number;
      /** Restrict to specific sources. Undefined or 'all' = no filter. */
      sources?: ChunkSource[] | 'all';
    },
  ): Promise<Hit[]> {
    const memDb = this.requireDb();
    // Best-effort retry — recovers from a degraded init the next time the
    // user actually searches.
    await this.ensureEmbedder();
    const limit = opts?.limit ?? this.cfg.autoInject.maxResults;
    const minScore = opts?.minScore ?? this.cfg.autoInject.minScore;
    const sourceFilter =
      opts?.sources && opts.sources !== 'all' && opts.sources.length > 0
        ? opts.sources
        : undefined;
    let queryEmbedding: Float32Array | null = null;
    if (this.embedder) {
      try {
        const [emb] = await this.embedder.embed([query]);
        queryEmbedding = emb ?? null;
      } catch (err) {
        logger.warn({ msg: 'memory.query_embed_failed', err: (err as Error).message });
      }
    }
    return hybridSearch(memDb, query, queryEmbedding, {
      vectorWeight: this.cfg.hybrid.vectorWeight,
      bm25Weight: this.cfg.hybrid.bm25Weight,
      maxResults: limit,
      minScore,
      ...(this.searchBoosts ? { sourceBoosts: this.searchBoosts } : {}),
      ...(sourceFilter ? { sourceFilter } : {}),
    });
  }

  async listNotes(filter?: {
    tag?: string;
    /** Restrict to one or more sources. Default: 'memory' (preserves
     *  pre-Phase-4 behavior). Pass 'all' for the full union. */
    sources?: ChunkSource[] | 'all';
    /** Filter by slug-prefix. Useful for browsing a wiki subfolder
     *  ("personen/") or a vault directory. */
    pathPrefix?: string;
  }): Promise<NoteSummary[]> {
    const memDb = this.requireDb();
    const sources: ChunkSource[] =
      !filter?.sources
        ? ['memory']
        : filter.sources === 'all'
        ? ['memory', 'wiki', 'vault']
        : filter.sources;

    const out: NoteSummary[] = [];
    for (const source of sources) {
      const files = listAllFiles(memDb, source);
      for (const f of files) {
        try {
          const slug =
            source === 'memory'
              ? slugFromPath(f.path, this.memoryRoot)
              : source === 'wiki'
              ? slugFromPath(f.path, this.wiki!.absPath, { keepSeparators: true })
              : slugFromPath(f.path, this.obsidian!.vaultPath);
          if (filter?.pathPrefix && !slug.startsWith(filter.pathPrefix)) continue;
          const raw = await readFile(f.path, 'utf8');
          const parsed = matter(raw);
          const tags = Array.isArray(parsed.data.tags) ? (parsed.data.tags as string[]) : undefined;
          if (filter?.tag && (!tags || !tags.includes(filter.tag))) continue;
          out.push({
            slug,
            source,
            path: f.path,
            description: typeof parsed.data.description === 'string' ? parsed.data.description : undefined,
            tags,
            updatedAt: f.mtime,
          });
        } catch {
          // Skip unreadable files; don't error the whole list.
        }
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Read and shorten the wiki's index.md into the topology overview that
   * run-turn snapshots into the session's system prompt. Returns null if
   * the wiki is disabled or has no index.md yet.
   *
   * Shortening ladder lives in `renderWikiOverview`.
   */
  async getWikiOverview(opts: {
    maxChars: number;
    topNSlugs: number;
  }): Promise<string | null> {
    if (!this.wiki) return null;
    const indexPath = join(this.wiki.absPath, 'index.md');
    let raw: string;
    try {
      raw = await readFile(indexPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return renderWikiOverview(raw, opts);
  }

  async getNote(slug: string): Promise<{ path: string; markdown: string } | null> {
    if (!SLUG_RE.test(slug)) return null;
    const path = join(this.memoryRoot, `${slug}.md`);
    try {
      const raw = await readFile(path, 'utf8');
      return { path, markdown: raw };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Create or replace a memory note. `created` is preserved across rewrites;
   * `updated` is always refreshed. Caller-provided frontmatter merges over
   * existing values. Throws if `opts.mustExist` is set and the file isn't there.
   */
  async writeNote(
    slug: string,
    body: string,
    frontmatter?: Record<string, unknown>,
    opts?: { mustExist?: boolean },
  ): Promise<{ path: string; created: boolean; mode: 'overwrite' }> {
    if (!SLUG_RE.test(slug)) {
      throw new Error(`invalid slug '${slug}' — must match ${SLUG_RE.source}`);
    }
    const path = join(this.memoryRoot, `${slug}.md`);

    let existingRaw: string | null = null;
    let existing: Record<string, unknown> = {};
    let exists = false;
    try {
      existingRaw = await readFile(path, 'utf8');
      existing = matter(existingRaw).data ?? {};
      exists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (opts?.mustExist && !exists) {
      throw new Error(`note '${slug}' does not exist — use memory_write to create`);
    }

    // v2.2: stub-pattern is gone. memory_write on an existing memory
    // slug just rewrites the file (caller-controlled). After Deep
    // consolidates a topic into the wiki, the source memory file is
    // DELETED — so a follow-up memory_write on the same slug is a
    // legitimate fresh write that Deep will pick up next run.

    const now = new Date().toISOString();
    const fm: Record<string, unknown> = {
      created: existing.created ?? now,
      ...existing,
      ...frontmatter,
      updated: now,
    };
    const fmYaml = matter.stringify(body.trimEnd() + '\n', fm);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fmYaml, 'utf8');
    // Watcher will pick up the change and reindex via debounced handler;
    // we don't reindex synchronously here.
    return { path, created: !exists, mode: 'overwrite' };
  }

  /**
   * Resolve a recall reference like "memory/auto", "wiki/personen/anna",
   * or "vault/Notizen/Foo--Bar" back to the full file content. Uses the
   * chunks table for path lookup so we don't have to reverse-slugify
   * (collision-safe). All three sources route through the same query.
   */
  async getByReference(reference: string): Promise<{
    reference: string;
    source: ChunkSource;
    slug: string;
    path: string;
    markdown: string;
    frontmatter: Record<string, unknown> | null;
  } | null> {
    const slashIdx = reference.indexOf('/');
    if (slashIdx < 0) return null;
    const source = reference.slice(0, slashIdx);
    const slug = reference.slice(slashIdx + 1);
    if (source !== 'memory' && source !== 'vault' && source !== 'wiki') return null;

    const memDb = this.requireDb();
    const row = memDb.db
      .prepare(`SELECT file_path FROM chunks WHERE source = ? AND slug = ? LIMIT 1`)
      .get(source, slug) as { file_path: string } | undefined;
    if (!row) return null;

    let raw: string;
    try {
      raw = await readFile(row.file_path, 'utf8');
    } catch {
      return null;
    }
    const parsed = matter(raw);
    const fm = parsed.data ?? {};
    return {
      reference,
      source: source as ChunkSource,
      slug,
      path: row.file_path,
      markdown: raw,
      frontmatter: Object.keys(fm).length > 0 ? (fm as Record<string, unknown>) : null,
    };
  }

  async deleteNote(slug: string): Promise<boolean> {
    if (!SLUG_RE.test(slug)) return false;
    const path = join(this.memoryRoot, `${slug}.md`);
    try {
      await unlink(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
}

function slugFromPath(path: string, root: string, opts?: { keepSeparators?: boolean }): string {
  const rel = relative(root, path);
  // Strip .md extension; replace path separators with `--` so a vault note
  // at `projects/somora/idea.md` becomes slug `projects--somora--idea`.
  //
  // Wiki source overrides via `keepSeparators: true` to preserve `/` —
  // matches the design-doc reference format `[wiki/personen/anna]` and
  // aligns with Obsidian Wikilinks `[[personen/anna]]` that Dream-B will
  // emit. Without this, references and Wikilinks would diverge and
  // confuse the agent.
  const parts = rel.replace(/\.md$/i, '').split(/[/\\]/).filter((s) => s.length > 0);
  return opts?.keepSeparators ? parts.join('/') : parts.join('--');
}
