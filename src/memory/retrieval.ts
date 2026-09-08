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
  /** Final fused score. The weighted vec/bm25 fusion lands in [0,1],
   *  but per-source boosts (sourceBoosts, e.g. wiki 1.4) MULTIPLY it
   *  afterwards — boosted hits legitimately exceed 1.0. It is a RANK
   *  within this query's candidates (min-max normalised), so
   *  `autoInject.minScore` compares against it, but a similarity
   *  judgment (rem.dedup.similarityThreshold) must not — see
   *  cosineFromVecScore(). */
  score: number;
  /** Raw per-modality components. `vecScore` is 1/(1+distance),
   *  un-normalised — the only absolute signal in here. */
  vecScore: number;
  bm25Score: number;
}

/**
 * One database to search, optionally restricted to some of its sources.
 *
 * Since the shared index (2026-09) a query spans two DBs: the agent's
 * own `memory.db` (its memory notes — restricted to `source='memory'`,
 * because an agent DB from before the split still carries inert
 * vault/wiki rows) and `~/.somora/index/shared.db` (vault + wiki, one
 * copy per instance). The restriction is applied INSIDE the candidate
 * queries (`rowid IN (…)` for vec0, `AND source IN (…)` for FTS), not
 * after the fact — otherwise the top-k of an old agent DB would be
 * 98 % wiki rows that get filtered away, leaving no memory candidates.
 */
export interface SearchTarget {
  memDb: MemoryDb;
  /** Only candidates with one of these sources are taken from this DB.
   *  Undefined = every row. */
  sources?: ReadonlyArray<string>;
}

/** Candidate key: chunk ids are per-DB, so a key needs the target index. */
type Key = string;
const keyOf = (target: number, chunkId: number): Key => `${target}:${chunkId}`;

/**
 * Run a hybrid query. `queryEmbedding` may be null — then only BM25 fires
 * (e.g. if embedding provider is unavailable).
 *
 * `target` is one DB (the pre-2026-09 shape, kept for callers and tests)
 * or a list of targets whose candidates are fused as ONE pool: the
 * min-max normalisation and the top-k cut run over all of them together,
 * exactly as they ran over one DB before the split.
 */
export function hybridSearch(
  target: MemoryDb | SearchTarget[],
  queryText: string,
  /** One query vector, or several — a chunk's vector score is then the
   *  BEST over them. Auto-inject passes [message-only, message⊕history]
   *  so a page the question names outright keeps its score even when
   *  the conversation was about something else, while a follow-up
   *  without a topic word still finds its page through the history. */
  queryEmbedding: Float32Array | Float32Array[] | null,
  cfg: RetrievalConfig,
): Hit[] {
  const targets: SearchTarget[] = Array.isArray(target) ? target : [{ memDb: target }];
  const queryEmbeddings: Float32Array[] = queryEmbedding
    ? Array.isArray(queryEmbedding) ? queryEmbedding : [queryEmbedding]
    : [];
  // Each modality returns up to k * 4 candidates so the fusion has room to
  // promote items that one side missed. We trim to `maxResults` at the end.
  const recall = Math.max(cfg.maxResults * 4, 20);

  // Candidates per modality across ALL targets, cut to `recall` by raw
  // score — the same pool size a single DB produced. Without the cut two
  // DBs would contribute 2×recall candidates, the min-max normalisation
  // would see a different minimum, and rankings would shift for no
  // reason (measured 2026-09-08: 109 of 150 baseline cells moved before
  // the cut, on identical content). Vector scores are comparable across
  // DBs (same embedder), so the cut reproduces the single-DB top-k
  // exactly; BM25 is corpus-relative, so there it is the closest analogue.
  type Cand = { target: number; chunkId: number; score: number };
  const vecPool: Cand[] = [];
  const bm25Pool: Cand[] = [];
  targets.forEach((t, ti) => {
    if (queryEmbeddings.length > 0 && t.memDb.hasVec) {
      // Several query vectors: best score per chunk wins.
      const best = new Map<number, number>();
      for (const emb of queryEmbeddings) {
        for (const h of runVectorSearch(t.memDb, emb, recall, t.sources)) {
          const cur = best.get(h.chunkId);
          if (cur === undefined || h.score > cur) best.set(h.chunkId, h.score);
        }
      }
      for (const [chunkId, score] of best) vecPool.push({ target: ti, chunkId, score });
    }
    for (const h of runBm25Search(t.memDb, queryText, recall, t.sources)) {
      bm25Pool.push({ target: ti, chunkId: h.chunkId, score: h.score });
    }
  });
  const byScore = (a: Cand, b: Cand) => b.score - a.score;
  const vecHits =
    targets.length > 1 || queryEmbeddings.length > 1 ? vecPool.sort(byScore).slice(0, recall) : vecPool;
  const bm25Hits = targets.length > 1 ? bm25Pool.sort(byScore).slice(0, recall) : bm25Pool;

  // Build a combined map keyed by (target, chunk id) with both raw scores.
  const merged = new Map<Key, { target: number; chunkId: number; vec: number; bm25: number }>();
  for (const h of vecHits) {
    merged.set(keyOf(h.target, h.chunkId), { target: h.target, chunkId: h.chunkId, vec: h.score, bm25: 0 });
  }
  for (const h of bm25Hits) {
    const k = keyOf(h.target, h.chunkId);
    const cur = merged.get(k) ?? { target: h.target, chunkId: h.chunkId, vec: 0, bm25: 0 };
    cur.bm25 = h.score;
    merged.set(k, cur);
  }
  if (merged.size === 0) return [];

  // Min-max normalize each modality independently. Avoids one signal
  // dominating because of raw-score scale differences.
  const normalize = (key: 'vec' | 'bm25'): Map<Key, number> => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of merged.values()) {
      const x = v[key];
      if (x === 0) continue; // never present in this modality
      if (x < min) min = x;
      if (x > max) max = x;
    }
    const out = new Map<Key, number>();
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
  // per fused candidate BEFORE sort. One query per DB covers both features.
  const needSources = Boolean(cfg.sourceBoosts) || Boolean(cfg.sourceFilter?.length);
  const sourceByKey = new Map<Key, string>();
  if (needSources) {
    targets.forEach((t, ti) => {
      const ids = [...merged.values()].filter((m) => m.target === ti).map((m) => m.chunkId);
      for (const [id, src] of loadSourcesForIds(t.memDb, ids)) sourceByKey.set(keyOf(ti, id), src);
    });
  }

  const filterSet = cfg.sourceFilter?.length ? new Set(cfg.sourceFilter) : null;

  const fused: Array<{ key: Key; target: number; id: number; score: number; vec: number; bm25: number }> = [];
  for (const [key, raw] of merged) {
    if (filterSet) {
      const src = sourceByKey.get(key);
      if (!src || !filterSet.has(src)) continue;
    }
    const vScore = vecNorm.get(key) ?? 0;
    const bScore = bm25Norm.get(key) ?? 0;
    let score = (cfg.vectorWeight * vScore + cfg.bm25Weight * bScore) / totalWeight;
    if (cfg.sourceBoosts) {
      const src = sourceByKey.get(key);
      const boost =
        src === 'wiki' ? cfg.sourceBoosts.wiki :
        src === 'memory' ? cfg.sourceBoosts.memory :
        src === 'vault' ? cfg.sourceBoosts.vault :
        1.0;
      score *= boost;
    }
    fused.push({ key, target: raw.target, id: raw.chunkId, score, vec: raw.vec, bm25: raw.bm25 });
  }
  fused.sort((a, b) => b.score - a.score);

  // Materialize chunk metadata for the survivors only. Over-fetch a few
  // candidates beyond maxResults so dedupeNestedHits() below can drop a
  // nested chunk and still hand back a full page.
  const survivors = fused.filter((f) => f.score >= cfg.minScore).slice(0, cfg.maxResults * NESTED_OVERFETCH);
  if (survivors.length === 0) return [];

  type Row = {
    id: number;
    file_path: string;
    source: string;
    slug: string;
    text: string;
    start_line: number;
    end_line: number;
  };
  const byKey = new Map<Key, Row>();
  targets.forEach((t, ti) => {
    const ids = survivors.filter((f) => f.target === ti).map((f) => f.id);
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const rows = t.memDb.db
      .prepare(
        `SELECT id, file_path, source, slug, text, start_line, end_line
         FROM chunks WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Row[];
    for (const r of rows) byKey.set(keyOf(ti, r.id), r);
  });

  const hits = survivors
    .filter((f) => byKey.has(f.key))
    .map((f) => {
      const r = byKey.get(f.key)!;
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
  return dedupeNestedHits(hits).slice(0, cfg.maxResults);
}

/** How many candidates beyond maxResults hybridSearch materializes so
 *  dedupeNestedHits() has something to backfill from. */
const NESTED_OVERFETCH = 3;

/**
 * Collapse hits whose line range lies INSIDE another hit's range from
 * the same file. Adjacent chunks share a deliberate paragraph of overlap
 * (chunking.overlapTokens) and both may legitimately match — those are
 * kept. What is dropped is full containment: an index built before the
 * 2026-09-01 chunker fix holds pairs like 17-18 ⊂ 17-33 and 35-60 ⊂ 35-68
 * for one file, and both halves of a pair scored above minScore for the
 * same query, so the memory block carried the same section twice.
 *
 * Rule: among nested hits keep the WIDER range (more of the section for
 * the same tokens) and give it the better of the two scores, so a wide
 * chunk that ranked just below its narrow twin does not lose its place.
 * Input is expected in descending-score order; output preserves that
 * order, re-sorted only where a score was lifted.
 */
export function dedupeNestedHits(hits: Hit[]): Hit[] {
  const kept: Hit[] = [];
  for (const h of hits) {
    let absorbed = false;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i]!;
      if (k.filePath !== h.filePath) continue;
      const hInsideK = h.startLine >= k.startLine && h.endLine <= k.endLine;
      const kInsideH = k.startLine >= h.startLine && k.endLine <= h.endLine;
      if (!hInsideK && !kInsideH) continue;
      absorbed = true;
      if (kInsideH && !hInsideK) {
        // h is the wider one — it replaces k, inheriting k's better score.
        kept[i] = { ...h, score: Math.max(h.score, k.score) };
      }
      // else: h lies inside k (or ranges are identical) → drop h.
      break;
    }
    if (!absorbed) kept.push(h);
  }
  return kept.sort((a, b) => b.score - a.score);
}

function runVectorSearch(
  memDb: MemoryDb,
  embedding: Float32Array,
  k: number,
  sources?: ReadonlyArray<string>,
): Array<{ chunkId: number; score: number }> {
  // sqlite-vec returns `distance` (lower = closer). Convert to a similarity
  // score in (0, 1] so fusion can weight it like BM25.
  //
  // The optional source restriction is a `rowid IN (subquery)` on the KNN
  // itself (supported by vec0 since 0.1.x; probed 2026-09-08 on 0.1.9):
  // the k nearest rows AMONG the allowed sources, not the k nearest
  // overall filtered afterwards.
  const rows = sources && sources.length > 0
    ? (memDb.db
        .prepare(
          `SELECT rowid, distance FROM chunks_vec
           WHERE embedding MATCH ?
             AND rowid IN (SELECT id FROM chunks WHERE source IN (${sources.map(() => '?').join(',')}))
           ORDER BY distance LIMIT ?`,
        )
        .all(embedding, ...sources, k) as Array<{ rowid: number | bigint; distance: number }>)
    : (memDb.db
        .prepare(
          `SELECT rowid, distance FROM chunks_vec
           WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(embedding, k) as Array<{ rowid: number | bigint; distance: number }>);
  return rows.map((r) => ({ chunkId: Number(r.rowid), score: 1 / (1 + r.distance) }));
}

/**
 * Absolute cosine similarity behind a hit's raw `vecScore`.
 *
 * `vecScore` is `1 / (1 + d)` with `d` the vec0 distance — L2 (the
 * table is created without `distance_metric`, so sqlite-vec's default)
 * over unit-length embeddings (embeddings.ts normalizes). For unit
 * vectors `d² = 2 − 2·cos`, hence `cos = 1 − d²/2`. Identical text →
 * 1.0, unrelated → ~0, opposite → −1.
 *
 * Why this exists: the fused `score` is min-max normalised WITHIN one
 * query's candidate set, so the best vector hit is always 1.0 no matter
 * how far away it is, and the source boost then makes it 0.98 (wiki)
 * or 0.85 (memory) — constants, not similarities. Anything that needs
 * "how alike is this really" (REM dedup) must use this, not `score`.
 */
export function cosineFromVecScore(vecScore: number): number {
  if (!(vecScore > 0)) return 0;
  const d = 1 / vecScore - 1;
  const cos = 1 - (d * d) / 2;
  return Math.max(-1, Math.min(1, cos));
}

/** Inverse of cosineFromVecScore — what runVectorSearch would have
 *  produced for a chunk at that cosine similarity. Tests use it to
 *  build hits with an explicit similarity. */
export function vecScoreFromCosine(cos: number): number {
  const c = Math.max(-1, Math.min(1, cos));
  const d = Math.sqrt(Math.max(0, 2 - 2 * c));
  return 1 / (1 + d);
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
  sources?: ReadonlyArray<string>,
): Array<{ chunkId: number; score: number }> {
  // FTS5 returns negative `bm25(...)` scores (lower = better). We negate
  // so higher = better and treat as the raw modality score.
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];
  try {
    const sourceClause = sources && sources.length > 0
      ? ` AND chunks.source IN (${sources.map(() => '?').join(',')})`
      : '';
    const rows = memDb.db
      .prepare(
        `SELECT chunks.id AS id, bm25(chunks_fts) AS bm25
         FROM chunks_fts
         JOIN chunks ON chunks.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?${sourceClause}
         ORDER BY bm25 LIMIT ?`,
      )
      .all(sanitized, ...(sources && sources.length > 0 ? sources : []), k) as Array<{ id: number; bm25: number }>;
    return rows.map((r) => ({ chunkId: r.id, score: -r.bm25 }));
  } catch {
    // FTS5 syntax-rejects malformed queries (e.g. unbalanced quotes after
    // sanitization). Treat as zero hits rather than crashing.
    return [];
  }
}

/**
 * Blend a query embedding with a context embedding: `(1-w)·q + w·c`,
 * re-normalised to unit length (the embedder emits unit vectors and
 * vec0 distances assume them). `w` = 0 returns `q` untouched. Used by
 * auto-inject so the current message decides and the recent history
 * only nudges — instead of one embedding of everything concatenated,
 * where two long previous answers outweigh a short question.
 */
export function blendEmbeddings(q: Float32Array, c: Float32Array | null, w: number): Float32Array {
  if (!c || !(w > 0)) return q;
  if (c.length !== q.length) return q;
  const wc = Math.min(1, w);
  const out = new Float32Array(q.length);
  let norm = 0;
  for (let i = 0; i < q.length; i++) {
    const v = (1 - wc) * q[i]! + wc * c[i]!;
    out[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return q;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

/**
 * Words that carry no retrieval signal in an OR-joined FTS5 query.
 * German and English function words plus chat filler. Without this,
 * "ok was kannst du mir über walter so erzählen" ranked pages by how
 * often they say "was", "du", "mir", "so" — every page — and the one
 * term that mattered drowned. Applied only to the BM25 query; the
 * embedding sees the full text. When every token is a stopword the
 * filter steps aside so the query is not empty.
 */
export const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  // German
  'aber', 'alle', 'allem', 'allen', 'aller', 'alles', 'als', 'also', 'am', 'an', 'ander', 'andere',
  'anderem', 'anderen', 'anderer', 'anderes', 'auch', 'auf', 'aus', 'bei', 'bin', 'bis', 'bist',
  'da', 'damit', 'dann', 'das', 'dass', 'daß', 'dem', 'den', 'der', 'des', 'dich', 'die', 'dies',
  'diese', 'diesem', 'diesen', 'dieser', 'dieses', 'dir', 'doch', 'dort', 'du', 'durch', 'ein',
  'eine', 'einem', 'einen', 'einer', 'eines', 'er', 'es', 'etwas', 'euch', 'euer', 'eure', 'für',
  'gegen', 'gewesen', 'hab', 'habe', 'haben', 'hat', 'hatte', 'hatten', 'hier', 'hin', 'hinter',
  'ich', 'ihm', 'ihn', 'ihnen', 'ihr', 'ihre', 'ihrem', 'ihren', 'ihrer', 'ihres', 'im', 'in',
  'indem', 'ins', 'ist', 'ja', 'jede', 'jedem', 'jeden', 'jeder', 'jedes', 'jetzt', 'kann',
  'kannst', 'kein', 'keine', 'keinem', 'keinen', 'keiner', 'keines', 'können', 'könnte', 'machen',
  'mal', 'man', 'mehr', 'mein', 'meine', 'meinem', 'meinen', 'meiner', 'meines', 'mich', 'mir',
  'mit', 'muss', 'musst', 'nach', 'nein', 'nicht', 'nichts', 'noch', 'nun', 'nur', 'ob', 'oder',
  'ohne', 'ok', 'okay', 'sag', 'sagen', 'schon', 'sehr', 'sei', 'sein', 'seine', 'seinem',
  'seinen', 'seiner', 'seines', 'sich', 'sie', 'sind', 'so', 'solche', 'soll', 'sollte', 'sondern',
  'sonst', 'über', 'um', 'und', 'uns', 'unser', 'unsere', 'unter', 'viel', 'vom', 'von', 'vor',
  'war', 'waren', 'warst', 'was', 'weg', 'weil', 'weiter', 'welche', 'welchem', 'welchen',
  'welcher', 'welches', 'wenn', 'wer', 'werde', 'werden', 'wie', 'wieder', 'will', 'wir', 'wird',
  'wirst', 'wo', 'wollen', 'wollte', 'würde', 'würden', 'zu', 'zum', 'zur', 'zwar', 'zwischen',
  'bitte', 'danke', 'eigentlich', 'einfach', 'erzähl', 'erzählen', 'erzähle', 'gerade', 'genau',
  'gibt', 'glaub', 'glaube', 'halt', 'irgendwie', 'kurz', 'naja', 'quasi', 'sowas', 'überhaupt',
  'vielleicht', 'wirklich', 'zb', 'solltest', 'sollten', 'weißt', 'weisst', 'wissen', 'meinst',
  'meinen', 'denkst', 'denke', 'findest', 'finde', 'stimmt', 'passt', 'gut', 'nochmal', 'eh',
  'hm', 'hmm', 'hmmm', 'aha', 'ach', 'na', 'nur', 'dazu', 'davon', 'darüber', 'daran', 'dafür',
  'dabei', 'darauf', 'daraus', 'deshalb', 'trotzdem', 'sicher', 'klar', 'gerne', 'gern',
  'natürlich', 'also', 'jetzt', 'heute', 'morgen', 'gestern', 'immer', 'nie', 'wieder',
  'selbst', 'eben', 'sogar', 'ganz', 'echt', 'total', 'ziemlich', 'mehr', 'weniger', 'lieber',
  'gleich', 'bald', 'oft', 'fast', 'etwa', 'circa',
  'yes', 'yeah', 'ok', 'okay', 'thanks', 'thank', 'sure', 'right', 'really', 'actually', 'maybe',
  'know', 'think', 'mean', 'said', 'say', 'get', 'got', 'go', 'going', 'like', 'want', 'need',
  // English
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'let', 'me', 'more', 'most', 'my',
  'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours',
  'out', 'over', 'own', 'please', 'same', 'she', 'should', 'so', 'some', 'such', 'tell', 'than',
  'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'us', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours',
]);

/**
 * Hard cap on OR-terms in one FTS5 MATCH. The query cost grows roughly
 * quadratically with the term count (measured on a 1.3k-chunk index:
 * 5k chars of text → 174 ms, 50k → 17 s, 275k → not finished after
 * 150 s), and better-sqlite3 runs it synchronously on the event loop —
 * a /reset over a long session froze the whole server for minutes
 * (2026-09-03). 64 distinct terms keep the MATCH O(1) in the input
 * length; beyond that more terms only dilute the OR anyway.
 */
export const FTS_MAX_TERMS = 64;

/**
 * Build a safe FTS5 MATCH query from free-form text. Strategy: tokenize on
 * whitespace, drop FTS5-special characters, de-duplicate, keep the first
 * FTS_MAX_TERMS distinct tokens, OR-join them. No prefix matching by
 * default — keeps recall conservative; we can revisit if synonym-recall
 * is too narrow.
 */
/** The tokens of `text` that carry retrieval signal (≥ 2 chars, not a
 *  stopword, de-duplicated). Zero for "das solltest du aber wissen oder?"
 *  — auto-inject uses the count to decide how much the history may
 *  steer the query. */
export function contentTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2 || seen.has(raw) || FTS_STOPWORDS.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function sanitizeFtsQuery(input: string, maxTerms: number = FTS_MAX_TERMS): string {
  const seen = new Set<string>();
  const tokens: string[] = [];
  const dropped: string[] = [];
  for (const raw of input.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2 || seen.has(raw)) continue;
    seen.add(raw);
    if (FTS_STOPWORDS.has(raw)) {
      dropped.push(raw);
      continue;
    }
    tokens.push(raw);
    if (tokens.length >= maxTerms) break;
  }
  // Nothing but stopwords ("was war das nochmal?"): better a noisy
  // match than none — fall back to the unfiltered tokens.
  if (tokens.length === 0) tokens.push(...dropped.slice(0, maxTerms));
  if (tokens.length === 0) return '';
  // Wrap each token in double-quotes to avoid FTS5 reserved-word issues
  return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}
