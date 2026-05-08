// Loads the wiki-pages slice that Dream-A needs as additional read-
// context (Phase 4 / Stufe 4). Two sources:
//
//   1. Stub-derived: every memory file with `promoted_to: <wiki-path>`
//      pulls in the corresponding wiki page. These are the topics the
//      agent has already promoted — without their wiki content the
//      memory file body is just a pointer + observations and Dream-A
//      can't compare facts.
//
//   2. Recall-derived: hits with source='wiki' from a vault-style
//      recall over the session's user-text. Catches topics that have a
//      wiki page but no stub yet for this agent (cross-agent
//      knowledge).
//
// Union of both, deduplicated by wiki slug. Capped at a reasonable
// upper bound (default 20) so a giant wiki doesn't blow the prompt.

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

import type { MemoryManager } from '../memory/manager.ts';
import { logger } from '../server/logger.ts';
import { isStub, parseStub } from '../wiki/templates.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

export interface ReferencedWikiPage {
  slug: string; // wiki path without .md (e.g. 'personen/luca')
  markdown: string;
  source: 'stub' | 'recall';
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

  // 1. Stub-derived. Walk agent's memory directory, find stubs.
  const memoryRoot = join(SOMORA_HOME, 'agents', args.agent, 'memory');
  let entries: Dirent[] = [];
  try {
    entries = await readdir(memoryRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ msg: 'dream.wiki_ctx.memory_walk_failed', err: (err as Error).message });
    }
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('.')) continue;
    const memPath = join(memoryRoot, e.name);
    try {
      const raw = await readFile(memPath, 'utf8');
      if (!isStub(raw)) continue;
      const stub = parseStub(raw);
      if (!stub) continue;
      const wikiSlug = stub.frontmatter.promoted_to;
      if (seen.has(wikiSlug)) continue;
      const wikiPath = join(args.wikiAbs, `${wikiSlug}.md`);
      try {
        const wikiRaw = await readFile(wikiPath, 'utf8');
        seen.set(wikiSlug, { slug: wikiSlug, markdown: wikiRaw, source: 'stub' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.debug({
            msg: 'dream.wiki_ctx.wiki_page_read_failed',
            slug: wikiSlug,
            err: (err as Error).message,
          });
        }
        // ENOENT: stub points at deleted page. Skip silently — Dream-B
        // will surface this on its next run.
      }
    } catch (err) {
      logger.debug({ msg: 'dream.wiki_ctx.stub_read_failed', path: memPath, err: (err as Error).message });
    }
  }

  // 2. Recall-derived. Hits with source='wiki' over the user-text.
  if (args.recallQuery.trim().length > 0 && seen.size < limit) {
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

  // Strip the source-tag for the return type (extract.ts only needs slug+markdown).
  const out = [...seen.values()].slice(0, limit);
  // Frontmatter strip: caller's formatWiki re-parses, but we sanity-strip
  // any super-large pages that would blow the prompt.
  for (const p of out) {
    if (p.markdown.length > 8000) {
      const parsed = matter(p.markdown);
      const truncated = parsed.content.slice(0, 6000) + '\n\n…(truncated)';
      p.markdown = matter.stringify(truncated, parsed.data);
    }
  }
  return out;
}
