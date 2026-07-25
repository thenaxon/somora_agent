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
// Dedup stages (1+2) only apply to `memory_write` findings. memory_edit /
// memory_delete address an existing slug by design (a "collision" is
// the point), and vault_hint is a pointer, not new content. A Stage-0
// referential check (below, always-on) additionally guards memory_edit /
// memory_delete against slugs that DON'T exist — invented targets would
// otherwise fail only at dream_apply time (2026-07-23 report).
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
  /** memory_edit findings whose slug doesn't exist as a memory note,
   *  converted to memory_write (Stage 0 referential validation). */
  downgraded: number;
}

export async function applyRemDedup(args: RemDedupArgs): Promise<RemDedupResult> {
  const memorySlugs = new Set(args.existingMemorySlugs);
  const wikiSlugs = new Set(args.loadedWikiSlugs);

  // Stage 0 — referential validation. Runs ALWAYS, even with dedup
  // disabled: it's a correctness gate, not a dedup heuristic.
  //
  // memory_edit / memory_delete address an existing memory note by
  // design — but small worker models sometimes invent a slug instead
  // (2026-07-23 report: a wanted wiki-page update surfaced as
  // memory_edit against the synthetic slug
  // `wiki-hardware-rene-llm-hardware-upgrade-2026`, which exists
  // nowhere). Such findings explode only later at dream_apply time,
  // which is exactly when agents start improvising. Catch them here:
  //   - memory_edit with proposed_content → downgrade to memory_write
  //     (the content is the point; a fresh note is the correct REM
  //     shape, Deep merges it into the wiki later)
  //   - memory_edit without content / memory_delete → drop with log
  //     (nothing actionable — an edit needs content, deleting a
  //     non-existent note is a no-op)
  const validated: Finding[] = [];
  let downgraded = 0;
  let droppedInvalid = 0;
  for (const f of args.findings) {
    const needsExistingNote = f.action === 'memory_edit' || f.action === 'memory_delete';
    if (needsExistingNote && !memorySlugs.has(f.slug)) {
      if (f.action === 'memory_edit' && f.proposed_content) {
        downgraded++;
        logger.info({
          msg: 'dream.rem.finding_downgraded',
          agent: args.agent,
          dreamId: args.dreamId,
          findingId: f.id,
          slug: f.slug,
          from: 'memory_edit',
          to: 'memory_write',
          reason: 'target memory note does not exist',
        });
        validated.push({
          ...f,
          action: 'memory_write',
          reason: `${f.reason} [auto-converted from memory_edit: note '${f.slug}' does not exist in memory]`,
        });
      } else {
        droppedInvalid++;
        logger.info({
          msg: 'dream.rem.finding_dropped_invalid_ref',
          agent: args.agent,
          dreamId: args.dreamId,
          findingId: f.id,
          action: f.action,
          slug: f.slug,
          reason: 'target memory note does not exist and finding is not convertible',
        });
      }
      continue;
    }
    validated.push(f);
  }

  if (!args.config.enabled) {
    return { findings: validated, dropped: droppedInvalid, marked: 0, downgraded };
  }
  const kept: Finding[] = [];
  let dropped = droppedInvalid;
  let marked = 0;

  for (const f of validated) {
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

  if (dropped > 0 || marked > 0 || downgraded > 0) {
    logger.info({
      msg: 'dream.rem.dedup_summary',
      agent: args.agent,
      dreamId: args.dreamId,
      inputFindings: args.findings.length,
      dropped,
      marked,
      downgraded,
    });
  }
  return { findings: kept, dropped, marked, downgraded };
}
