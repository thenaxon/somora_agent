// Wiki-context loaders for REM (Session→Memory dedup) and Deep
// (Memory→Wiki decision).
//
// Both load wiki pages relevant to a query (session text for REM,
// memory body for Deep). Recall-driven via embedding+BM25 search
// over source='wiki' chunks. Deep additionally loads index.md as
// always-on topology header so the LLM sees what subfolders exist
// even when no specific page matches.
//
// As of v2.2 the stub-pattern is gone — no per-memory pointers to
// wiki pages. All wiki-context comes from recall.

import type { MemoryManager } from '../memory/manager.ts';
import { logger } from '../server/logger.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

export interface ReferencedWikiPage {
  slug: string; // wiki path without .md (e.g. 'personen/luca')
  markdown: string;
  source: 'recall';
}

/** REM context: top-N wiki pages relevant to a session's user-text. */
export async function loadReferencedWiki(args: {
  agent: string;
  mgr: MemoryManager;
  /** Combined user-text from the session range, for the recall query. */
  recallQuery: string;
  /** Absolute path to <vault>/<wiki-subfolder>. */
  wikiAbs: string | null;
  /** Hard cap on number of wiki pages returned. */
  limit?: number;
}): Promise<ReferencedWikiPage[]> {
  if (!args.wikiAbs) return [];
  return await recallTopWikiPages({
    mgr: args.mgr,
    query: args.recallQuery,
    limit: args.limit ?? 20,
  });
}

/** Deep context: index.md (topology) + top-N wiki pages relevant
 *  to the memory body. Used by the unified Deep prompt to decide
 *  Skip/Promote/Merge in one LLM call. */
export async function loadDeepWikiContext(args: {
  mgr: MemoryManager;
  /** Memory body text — used as the embedding query for relevant pages. */
  memoryQuery: string;
  /** Absolute path to <vault>/<wiki-subfolder>. */
  wikiAbs: string;
  /** Top-N wiki pages to include as full bodies. Default 8. */
  topN?: number;
}): Promise<{ indexSummary: string; relevantPages: ReferencedWikiPage[] }> {
  const topN = args.topN ?? 8;

  // 1. Load index.md as topology header.
  let indexSummary = '';
  try {
    const indexRaw = await readFile(join(args.wikiAbs, 'index.md'), 'utf8');
    // Strip the verbose "Letzte Updates" tail when index gets large —
    // we want stable topology, not changelog noise. Cap at 4 KB.
    indexSummary =
      indexRaw.length > 4000
        ? indexRaw.slice(0, 4000) + '\n\n…(index truncated)'
        : indexRaw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ msg: 'dream.wiki_ctx.index_read_failed', err: (err as Error).message });
    }
    indexSummary = '(no index.md yet — first Deep run will create one)';
  }

  // 2. Recall top-N relevant pages.
  const relevantPages = await recallTopWikiPages({
    mgr: args.mgr,
    query: args.memoryQuery,
    limit: topN,
  });

  return { indexSummary, relevantPages };
}

async function recallTopWikiPages(args: {
  mgr: MemoryManager;
  query: string;
  limit: number;
}): Promise<ReferencedWikiPage[]> {
  if (args.query.trim().length === 0 || args.limit <= 0) return [];
  const seen = new Map<string, ReferencedWikiPage>();
  try {
    const hits = await args.mgr.search(args.query, {
      limit: Math.max(args.limit * 3, 20),
      minScore: 0.3,
      sources: ['wiki'],
    });
    for (const h of hits) {
      if (seen.has(h.slug)) continue;
      if (seen.size >= args.limit) break;
      try {
        const wikiRaw = await readFile(h.filePath, 'utf8');
        seen.set(h.slug, { slug: h.slug, markdown: wikiRaw, source: 'recall' });
      } catch (err) {
        logger.debug({
          msg: 'dream.wiki_ctx.recall_hit_read_failed',
          slug: h.slug,
          err: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger.warn({ msg: 'dream.wiki_ctx.recall_failed', err: (err as Error).message });
  }
  const out = [...seen.values()];
  // Truncate super-large pages so the prompt stays manageable.
  for (const p of out) {
    if (p.markdown.length > 8000) {
      const parsed = matter(p.markdown);
      const truncated = parsed.content.slice(0, 6000) + '\n\n…(truncated)';
      p.markdown = matter.stringify(truncated, parsed.data);
    }
  }
  return out;
}
