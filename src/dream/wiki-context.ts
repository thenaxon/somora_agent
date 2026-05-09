// Loads the wiki-pages slice that REM needs as additional read-context
// for the dedup-against-wiki check during extraction.
//
// As of v2.2 the stub-pattern is gone: there's no per-memory pointer
// to a wiki page anymore. Wiki context comes purely from recall over
// the session content — hits with source='wiki' from a vault-style
// search over the session's user-text.
//
// Capped at a reasonable upper bound (default 20) so a giant wiki
// doesn't blow the prompt. v2.5 will expand this with index.md as
// always-on topology header.

import type { MemoryManager } from '../memory/manager.ts';
import { logger } from '../server/logger.ts';
import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';

export interface ReferencedWikiPage {
  slug: string; // wiki path without .md (e.g. 'personen/luca')
  markdown: string;
  source: 'recall';
}

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
  const limit = args.limit ?? 20;
  const seen = new Map<string, ReferencedWikiPage>();

  // Recall-derived. Hits with source='wiki' over the user-text.
  if (args.recallQuery.trim().length > 0) {
    try {
      const hits = await args.mgr.search(args.recallQuery, {
        limit: 30,
        minScore: 0.4,
        sources: ['wiki'],
      });
      for (const h of hits) {
        if (seen.has(h.slug)) continue;
        if (seen.size >= limit) break;
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
  }

  const out = [...seen.values()].slice(0, limit);
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
