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
  /** Paths relative to vaultPath that the indexer must skip entirely. */
  excludePaths?: string[];
}

export interface ManagerOptions {
  agent: string;
  config: MemoryConfig;
  /** Optional Obsidian read-source. */
  obsidian?: ObsidianSource;
}

export interface NoteSummary {
  slug: string;
  source: 'memory' | 'vault';
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
  private lastEmbedderRetry = 0;

  constructor(opts: ManagerOptions) {
    this.agent = opts.agent;
    this.cfg = opts.config;
    this.obsidian = opts.obsidian;
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

  private buildIgnored(): Array<string | RegExp> {
    const ignored: Array<string | RegExp> = [/(^|[\\/])\../]; // dotfiles
    if (this.obsidian?.excludePaths) {
      for (const p of this.obsidian.excludePaths) {
        ignored.push(join(this.obsidian.vaultPath, p));
        ignored.push(join(this.obsidian.vaultPath, p) + '/**');
      }
    }
    return ignored;
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

  private classifySource(path: string): 'memory' | 'vault' | null {
    if (path.startsWith(this.memoryRoot)) return 'memory';
    if (this.obsidian && path.startsWith(this.obsidian.vaultPath)) {
      // Filter out excluded subpaths defensively (chokidar should already
      // skip them, but Obsidian users sometimes add paths after init).
      const rel = relative(this.obsidian.vaultPath, path);
      for (const ex of this.obsidian.excludePaths ?? []) {
        if (rel === ex || rel.startsWith(ex + '/')) return null;
      }
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
        // Honor obsidian excludes during full-sweep walk
        if (this.obsidian && full.startsWith(this.obsidian.vaultPath)) {
          const rel = relative(this.obsidian.vaultPath, full);
          if ((this.obsidian.excludePaths ?? []).some((ex) => rel === ex || rel.startsWith(ex + '/'))) {
            continue;
          }
        }
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
    const sources: Array<{ root: string; source: 'memory' | 'vault' }> = [
      { root: this.memoryRoot, source: 'memory' },
    ];
    if (this.obsidian?.vaultPath) {
      sources.push({ root: this.obsidian.vaultPath, source: 'vault' });
    }
    for (const { root, source } of sources) {
      for await (const path of this.walkMarkdown(root)) {
        seen.add(path);
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

  private async indexFile(path: string, source: 'memory' | 'vault'): Promise<'indexed' | 'skipped'> {
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
    const slug = source === 'memory'
      ? slugFromPath(path, this.memoryRoot)
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

  async search(query: string, opts?: { limit?: number; minScore?: number }): Promise<Hit[]> {
    const memDb = this.requireDb();
    // Best-effort retry — recovers from a degraded init the next time the
    // user actually searches.
    await this.ensureEmbedder();
    const limit = opts?.limit ?? this.cfg.autoInject.maxResults;
    const minScore = opts?.minScore ?? this.cfg.autoInject.minScore;
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
    });
  }

  async listNotes(filter?: { tag?: string }): Promise<NoteSummary[]> {
    const memDb = this.requireDb();
    const files = listAllFiles(memDb, 'memory');
    const out: NoteSummary[] = [];
    for (const f of files) {
      try {
        const raw = await readFile(f.path, 'utf8');
        const parsed = matter(raw);
        const tags = Array.isArray(parsed.data.tags) ? (parsed.data.tags as string[]) : undefined;
        if (filter?.tag && (!tags || !tags.includes(filter.tag))) continue;
        out.push({
          slug: slugFromPath(f.path, this.memoryRoot),
          source: 'memory',
          path: f.path,
          description: typeof parsed.data.description === 'string' ? parsed.data.description : undefined,
          tags,
          updatedAt: f.mtime,
        });
      } catch {
        // Skip unreadable files; don't error the whole list.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
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

  async writeNote(slug: string, body: string, frontmatter?: Record<string, unknown>): Promise<{ path: string }> {
    if (!SLUG_RE.test(slug)) {
      throw new Error(`invalid slug '${slug}' — must match ${SLUG_RE.source}`);
    }
    const path = join(this.memoryRoot, `${slug}.md`);
    const now = new Date().toISOString();
    const fm = { created: now, ...frontmatter, updated: now } as Record<string, unknown>;
    const fmYaml = matter.stringify(body.trimEnd() + '\n', fm);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fmYaml, 'utf8');
    // Watcher will pick up the change and reindex via debounced handler;
    // we don't reindex synchronously here.
    return { path };
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

function slugFromPath(path: string, root: string): string {
  const rel = relative(root, path);
  // Strip .md extension; replace path separators with `--` so a vault note
  // at `projects/somora/idea.md` becomes slug `projects--somora--idea`.
  return rel
    .replace(/\.md$/i, '')
    .split(/[/\\]/)
    .filter((s) => s.length > 0)
    .join('--');
}
