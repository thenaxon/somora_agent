// Hybrid retrieval: vector cosine via sqlite-vec + BM25 via FTS5.
// Score fusion is min-max normalisation per modality, then weighted sum
// (DECISION #26 default 0.7 vec / 0.3 bm25, configurable).
//
// FTS-only fallback: if memory.db has no vec table (sqlite-vec not loaded),
// the vector half is silently skipped and BM25 is the only signal. The
// caller doesn't need to know.

import type { MemoryDb } from './storage.ts';

export interface SourceBoosts {
  /** Multiplier on the fused score per source. Higher = ranked first.
   *  All multipliers are positive. Unknown source defaults to 1.0. */
  wiki: number;
  memory: number;
  vault: number;
}

export interface RetrievalConfig {
  vectorWeight: number;
  bm25Weight: number;
  maxResults: number;
  minScore: number;
  /** Optional per-source multiplier applied to the fused score before
   *  top-k cut. When undefined, no boost is applied. Wired up by the
   *  caller from `config.wiki.search.*` when `config.wiki.enabled`. */
  sourceBoosts?: SourceBoosts;
  /** Optional hard filter — only return hits from these sources.
   *  Empty/undefined means "all sources" (default behavior). */
  sourceFilter?: ReadonlyArray<string>;
}

export interface Hit {
  chunkId: number;
  filePath: string;
  source: string;
  slug: string;
  text: string;
  startLine: number;
  endLine: number;
  /** Final fused score in [0,1]. */
  score: number;
  /** Per-modality components (debugging / logging). */
  vecScore: number;
  bm25Score: number;
}

/**
 * Run a hybrid query. `queryEmbedding` may be null — then only BM25 fires
 * (e.g. if embedding provider is unavailable).
 */
export function hybridSearch(
  memDb: MemoryDb,
  queryText: string,
  queryEmbedding: Float32Array | null,
  cfg: RetrievalConfig,
): Hit[] {
  // Each modality returns up to k * 4 candidates so the fusion has room to
  // promote items that one side missed. We trim to `maxResults` at the end.
  const recall = Math.max(cfg.maxResults * 4, 20);

  const vecHits = queryEmbedding && memDb.hasVec
    ? runVectorSearch(memDb, queryEmbedding, recall)
    : [];
  const bm25Hits = runBm25Search(memDb, queryText, recall);

  // Build a combined map keyed by chunk id with both raw scores.
  const merged = new Map<number, { vec: number; bm25: number }>();
  for (const h of vecHits) {
    merged.set(h.chunkId, { vec: h.score, bm25: 0 });
  }
  for (const h of bm25Hits) {
    const cur = merged.get(h.chunkId) ?? { vec: 0, bm25: 0 };
    cur.bm25 = h.score;
    merged.set(h.chunkId, cur);
  }
  if (merged.size === 0) return [];

  // Min-max normalize each modality independently. Avoids one signal
  // dominating because of raw-score scale differences.
  const normalize = (key: 'vec' | 'bm25'): Map<number, number> => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of merged.values()) {
      const x = v[key];
      if (x === 0) continue; // never present in this modality
      if (x < min) min = x;
      if (x > max) max = x;
    }
    const out = new Map<number, number>();
    if (!Number.isFinite(min) || max === min) {
      // Either nothing in this modality, or all identical — neutral 0.
      for (const id of merged.keys()) out.set(id, 0);
      // If all identical AND non-zero, treat as 1 so the modality contributes
      if (Number.isFinite(min) && max === min) {
        for (const [id, v] of merged) if (v[key] !== 0) out.set(id, 1);
      }
      return out;
    }
    for (const [id, v] of merged) {
      out.set(id, v[key] === 0 ? 0 : (v[key] - min) / (max - min));
    }
    return out;
  };
  const vecNorm = normalize('vec');
  const bm25Norm = normalize('bm25');

  const totalWeight = cfg.vectorWeight + cfg.bm25Weight || 1;

  // If source-boosts OR source-filter is configured, materialize source
  // per fused chunkId BEFORE sort. One query covers both features.
  const needSources = Boolean(cfg.sourceBoosts) || Boolean(cfg.sourceFilter?.length);
  const sourceById = needSources
    ? loadSourcesForIds(memDb, [...merged.keys()])
    : null;

  const filterSet = cfg.sourceFilter?.length ? new Set(cfg.sourceFilter) : null;

  const fused: Array<{ id: number; score: number; vec: number; bm25: number }> = [];
  for (const [id, raw] of merged) {
    if (filterSet && sourceById) {
      const src = sourceById.get(id);
      if (!src || !filterSet.has(src)) continue;
    }
    const vScore = vecNorm.get(id) ?? 0;
    const bScore = bm25Norm.get(id) ?? 0;
    let score = (cfg.vectorWeight * vScore + cfg.bm25Weight * bScore) / totalWeight;
    if (sourceById && cfg.sourceBoosts) {
      const src = sourceById.get(id);
      const boost =
        src === 'wiki' ? cfg.sourceBoosts.wiki :
        src === 'memory' ? cfg.sourceBoosts.memory :
        src === 'vault' ? cfg.sourceBoosts.vault :
        1.0;
      score *= boost;
    }
    fused.push({ id, score, vec: raw.vec, bm25: raw.bm25 });
  }
  fused.sort((a, b) => b.score - a.score);

  // Materialize chunk metadata for the survivors only.
  const ids = fused
    .filter((f) => f.score >= cfg.minScore)
    .slice(0, cfg.maxResults)
    .map((f) => f.id);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = memDb.db
    .prepare(
      `SELECT id, file_path, source, slug, text, start_line, end_line
       FROM chunks WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: number;
    file_path: string;
    source: string;
    slug: string;
    text: string;
    start_line: number;
    end_line: number;
  }>;
  const byId = new Map(rows.map((r) => [r.id, r]));

  return fused
    .filter((f) => f.score >= cfg.minScore)
    .slice(0, cfg.maxResults)
    .filter((f) => byId.has(f.id))
    .map((f) => {
      const r = byId.get(f.id)!;
      return {
        chunkId: r.id,
        filePath: r.file_path,
        source: r.source,
        slug: r.slug,
        text: r.text,
        startLine: r.start_line,
        endLine: r.end_line,
        score: f.score,
        vecScore: f.vec,
        bm25Score: f.bm25,
      };
    });
}

function runVectorSearch(
  memDb: MemoryDb,
  embedding: Float32Array,
  k: number,
): Array<{ chunkId: number; score: number }> {
  // sqlite-vec returns `distance` (lower = closer). Convert to a similarity
  // score in (0, 1] so fusion can weight it like BM25.
  const rows = memDb.db
    .prepare(
      `SELECT rowid, distance FROM chunks_vec
       WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(embedding, k) as Array<{ rowid: number | bigint; distance: number }>;
  return rows.map((r) => ({ chunkId: Number(r.rowid), score: 1 / (1 + r.distance) }));
}

function loadSourcesForIds(memDb: MemoryDb, ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = memDb.db
    .prepare(`SELECT id, source FROM chunks WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: number; source: string }>;
  for (const r of rows) out.set(r.id, r.source);
  return out;
}

function runBm25Search(
  memDb: MemoryDb,
  query: string,
  k: number,
): Array<{ chunkId: number; score: number }> {
  // FTS5 returns negative `bm25(...)` scores (lower = better). We negate
  // so higher = better and treat as the raw modality score.
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  try {
    const rows = memDb.db
      .prepare(
        `SELECT chunks.id AS id, bm25(chunks_fts) AS bm25
         FROM chunks_fts
         JOIN chunks ON chunks.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY bm25 LIMIT ?`,
      )
      .all(sanitized, k) as Array<{ id: number; bm25: number }>;
    return rows.map((r) => ({ chunkId: r.id, score: -r.bm25 }));
  } catch {
    // FTS5 syntax-rejects malformed queries (e.g. unbalanced quotes after
    // sanitization). Treat as zero hits rather than crashing.
    return [];
  }
}

/**
 * Build a safe FTS5 MATCH query from free-form text. Strategy: tokenize on
 * whitespace, drop FTS5-special characters, OR-join the surviving tokens.
 * No prefix matching by default — keeps recall conservative; we can revisit
 * if synonym-recall is too narrow.
 */
function sanitizeFtsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return '';
  // Wrap each token in double-quotes to avoid FTS5 reserved-word issues
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}
