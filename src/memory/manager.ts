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
  replaceFileChunks,
  upsertFile,
  type MemoryDb,
} from './storage.ts';
import { MarkdownWatcher, type FileEvent } from './watcher.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

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

    logger.info({ msg: 'memory.reindex_done', agent: this.agent, indexed, skipped });
    return { indexed, skipped };
  }

  private async indexFile(path: string, source: ChunkSource): Promise<'indexed' | 'skipped'> {
    const memDb = this.requireDb();
    const buf = await readFile(path);
    const stats = await stat(path);
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
    const { changed } = upsertFile(memDb, {
      path,
      source,
      hash,
      mtime: stats.mtimeMs,
      size: stats.size,
    });
    if (!changed) return 'skipped';

    const text = buf.toString('utf8');
    const chunks = chunkMarkdown(text, this.cfg.chunking);
    if (chunks.length === 0) {
      replaceFileChunks(memDb, path, [], null);
      return 'indexed';
    }
    // Slug is path relative to the source-root (memory: memoryRoot;
    // wiki: wiki absPath so subfolder name is stripped; vault: vaultPath).
    // Hit-format uses `[source/slug]` so the slug should be stable across
    // sources without redundant prefixes.
    //
    // Wiki preserves `/` separators (e.g. `personen/luca`) to match the
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

    const modelName = this.embedder?.name ?? 'fts-only';
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
   * Read and shorten the wiki's index.md for the auto-inject overview
   * block. Returns null if wiki is not enabled, has no index.md yet,
   * or would not fit within the budget.
   *
   * Shortening strategy: if raw index is ≤ maxChars, return verbatim.
   * Otherwise drop snippet/description text after each `[[link]]`,
   * keeping just the bare wikilink list per section. If still too
   * long, truncate to topNSlugs across sections.
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
    if (raw.length <= opts.maxChars) return raw.trimEnd();

    // Strip everything except section headers (## ...) and bare
    // [[wikilink]] tokens. This is a best-effort shortener — Dream-B's
    // index.md format is conventionalised but we don't hard-couple here.
    const lines = raw.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('# ') || trimmed.startsWith('## ')) {
        out.push(trimmed);
        continue;
      }
      // Match all [[…]] tokens; keep the line if it has any
      const links = trimmed.match(/\[\[[^\]]+\]\]/g);
      if (links?.length) {
        out.push(`- ${links.join(' ')}`);
      }
    }
    let shortened = out.join('\n');
    if (shortened.length > opts.maxChars) {
      // Last resort: keep first N [[…]] tokens overall
      const links = shortened.match(/\[\[[^\]]+\]\]/g) ?? [];
      const kept = links.slice(0, opts.topNSlugs);
      shortened = `# Wiki overview (truncated to top ${kept.length})\n\n${kept.join(' ')}`;
    }
    return shortened.trimEnd();
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
   * Resolve a recall reference like "memory/auto", "wiki/personen/luca",
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
  // matches the design-doc reference format `[wiki/personen/luca]` and
  // aligns with Obsidian Wikilinks `[[personen/luca]]` that Dream-B will
  // emit. Without this, references and Wikilinks would diverge and
  // confuse the agent.
  const parts = rel.replace(/\.md$/i, '').split(/[/\\]/).filter((s) => s.length > 0);
  return opts?.keepSeparators ? parts.join('/') : parts.join('--');
}
