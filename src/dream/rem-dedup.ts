// REM post-extraction dedup — mechanical filter, no LLM involved.
//
// Why this exists (buffet's report 2026-07-06): the extractor prompt
// already hands the worker model every existing memory note plus the
// wiki context and asks it to propose only NEW facts. Small worker
// models ignore that instruction — buffet's weekly monitoring sessions
// produced the same portfolio findings for weeks, 26/27 findings in one
// review round were repeats, several with byte-identical slugs. The fix
// is to stop trusting the prompt and enforce dedup in code, AFTER
// extraction and BEFORE the findings are persisted for review:
//
//   1. Exact slug collision (memory_write proposing a slug that already
//      exists as a memory note, or matching a wiki page the run loaded)
//      → the finding is DROPPED and logged. Nothing ambiguous about a
//      byte-identical slug.
//   2. Content similarity: hybrid search (memory+wiki sources) over the
//      proposed content; a hit at/above `rem.dedup.similarityThreshold`
//      marks the finding `likely_duplicate` + `duplicate_of`. The
//      finding STAYS in the review — similarity is a judgment call, the
//      marker just lets the user batch-dismiss with confidence.
//
// Only `memory_write` findings are candidates. memory_edit /
// memory_delete address an existing slug by design (a "collision" is
// the point), and vault_hint is a pointer, not new content.
//
// Scope note: workspace files (e.g. buffet's finance/monitoring/) are
// NOT visible here — that would be the deferred `memory.sourceOfTruth`
// design (option (c) in the report). This pass covers memory + wiki.

import type { RemDedupConfig } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import { logger } from '../server/logger.ts';
import type { Finding } from './types.ts';

export interface RemDedupArgs {
  agent: string;
  /** Dream id — for log correlation only. */
  dreamId: string;
  findings: Finding[];
  /** Slugs of ALL existing memory notes (complete list, from listNotes). */
  existingMemorySlugs: string[];
  /** Slugs of the wiki pages this run loaded into context (top-N match —
   *  not the whole wiki; full-wiki slug enumeration isn't available here). */
  loadedWikiSlugs: string[];
  mgr: MemoryManager;
  config: RemDedupConfig;
}

export interface RemDedupResult {
  findings: Finding[];
  dropped: number;
  marked: number;
}

export async function applyRemDedup(args: RemDedupArgs): Promise<RemDedupResult> {
  if (!args.config.enabled) {
    return { findings: args.findings, dropped: 0, marked: 0 };
  }
  const memorySlugs = new Set(args.existingMemorySlugs);
  const wikiSlugs = new Set(args.loadedWikiSlugs);
  const kept: Finding[] = [];
  let dropped = 0;
  let marked = 0;

  for (const f of args.findings) {
    if (f.action !== 'memory_write') {
      kept.push(f);
      continue;
    }

    // Stage 1 — exact slug collision → drop.
    const slugHit = memorySlugs.has(f.slug)
      ? 'memory'
      : wikiSlugs.has(f.slug)
        ? 'wiki'
        : null;
    if (slugHit) {
      dropped++;
      logger.info({
        msg: 'dream.rem.dedup_dropped',
        agent: args.agent,
        dreamId: args.dreamId,
        findingId: f.id,
        slug: f.slug,
        matchedSource: slugHit,
        reason: 'exact slug collision with existing note/page',
      });
      continue;
    }

    // Stage 2 — content similarity → mark, keep.
    const text = (f.proposed_content ?? '').trim() || f.reason;
    if (text) {
      try {
        const hits = await args.mgr.search(text, {
          limit: 3,
          minScore: args.config.similarityThreshold,
          sources: ['memory', 'wiki'],
        });
        const top = hits[0];
        if (top) {
          marked++;
          f.likely_duplicate = true;
          f.duplicate_of = `${top.source}:${top.slug}@${top.score.toFixed(2)}`;
          logger.info({
            msg: 'dream.rem.dedup_marked',
            agent: args.agent,
            dreamId: args.dreamId,
            findingId: f.id,
            slug: f.slug,
            duplicateOf: f.duplicate_of,
          });
        }
      } catch (err) {
        // Search failure must never cost the user a finding — degrade to
        // unmarked, same posture as the rest of the dream pipeline.
        logger.warn({
          msg: 'dream.rem.dedup_search_failed',
          agent: args.agent,
          dreamId: args.dreamId,
          findingId: f.id,
          err: (err as Error).message,
        });
      }
    }
    kept.push(f);
  }

  if (dropped > 0 || marked > 0) {
    logger.info({
      msg: 'dream.rem.dedup_summary',
      agent: args.agent,
      dreamId: args.dreamId,
      inputFindings: args.findings.length,
      dropped,
      marked,
    });
  }
  return { findings: kept, dropped, marked };
}
