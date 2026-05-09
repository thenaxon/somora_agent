// Unified wiki-context loader for REM (Session→Memory dedup) and Deep
// (Memory→Wiki decision).
//
// Both phases need to see what's already in the wiki to make sane
// decisions:
//   - REM: "did the user just say something I already have in the wiki?"
//   - Deep: "is this memory file already covered by a wiki page?"
//
// The shape is identical: index.md as topology header + top-N
// embedding-matched wiki pages with full bodies. The query just
// differs (session user-text for REM, memory-body for Deep).
//
// As of v2.2 the stub-pattern is gone — no per-memory pointers to
// wiki pages. All wiki-context comes from recall.
//
// See `private/dream-system-v2.md` § "Phase REM" / "Phase Deep".

import type { MemoryManager } from '../memory/manager.ts';
import { logger } from '../server/logger.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

export interface ReferencedWikiPage {
  /** Wiki path without .md (e.g. 'personen/luca'). */
  slug: string;
  markdown: string;
}

export interface WikiContext {
  /** index.md content (capped at 4 KB). Always present. Empty/placeholder
   *  string when no index.md exists yet. */
  indexSummary: string;
  /** Top-N wiki pages relevant to the query, full body (page-cap 8 KB). */
  relevantPages: ReferencedWikiPage[];
}

export async function loadWikiContext(args: {
  mgr: MemoryManager;
  /** Embedding query — session user-text for REM, memory body for Deep. */
  query: string;
  /** Absolute path to <vault>/<wiki-subfolder>. Null disables the loader. */
  wikiAbs: string | null;
  /** Top-N pages to include as full bodies. Default 8. */
  topN?: number;
}): Promise<WikiContext> {
  if (!args.wikiAbs) {
    return {
      indexSummary: '(wiki disabled — no vault configured)',
      relevantPages: [],
    };
  }

  const topN = args.topN ?? 8;

  // 1. Load index.md as topology header.
  let indexSummary = '';
  try {
    const indexRaw = await readFile(join(args.wikiAbs, 'index.md'), 'utf8');
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
    query: args.query,
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
        seen.set(h.slug, { slug: h.slug, markdown: wikiRaw });
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
