// Deep-Phase types: candidates, plans, dispatcher interface.
//
// See `private/dream-system-v2.md` for the design.
//
// As of v2.2 the stub-with-observations variant is gone. All candidates
// are 'fresh' memory files; merge-vs-promote is decided by Deep at
// processing time (collision-detection on slug-write).

import type { ResolvedModel } from '../config/types.ts';

/** A memory file that's a candidate for promotion or merge. */
export interface PromotionCandidate {
  agent: string;
  /** Slug of the memory file (no extension). */
  slug: string;
  /** Absolute path to the memory file. */
  path: string;
  /** Full markdown including frontmatter. */
  raw: string;
  /** Parsed frontmatter (may be empty). */
  frontmatter: Record<string, unknown>;
  /** Body without frontmatter. */
  body: string;
  /** mtime at read time — used for optimistic-concurrency on later writes. */
  mtimeMs: number;
}

/** Outcome of running the LLM dispatcher on a candidate. */
export type PromotionDecision =
  | {
      kind: 'promote';
      /** Wiki sub-folder (relative to wiki root, e.g. 'personen'). */
      subfolder: string;
      /** Slug for the new wiki page (filename without .md). May
       *  contain `/` for nested paths within the subfolder. */
      slug: string;
      /** Wiki frontmatter `type` (person | projekt | konzept | ...). */
      type: string;
      /** Suggested H1 title for the wiki page. */
      title: string;
      /** Body markdown for the wiki page (no frontmatter, no H1 — the
       *  builder adds those). */
      body: string;
      /** Optional cross-reference targets (wiki paths without .md). */
      related?: string[];
    }
  | {
      kind: 'skip';
      reason: string;
    };

/** Outcome of running the LLM dispatcher when merging a candidate
 *  into an existing wiki page (collision-fallback path). */
export type MergeDecision =
  | {
      kind: 'update';
      /** Updated body for the wiki page (no frontmatter — caller
       *  preserves frontmatter, only refreshes `updated`). */
      body: string;
      /** Optional updated cross-references. */
      related?: string[];
      /** One-line summary for the wiki log. */
      logSummary: string;
    }
  | {
      kind: 'no_change';
      reason: string;
    };

/** What a single candidate produced — the shape used by orchestrator
 *  for log entries and index regeneration. */
export type CandidateOutcome =
  | {
      kind: 'promoted';
      agent: string;
      memorySlug: string;
      wikiPath: string; // relative to wiki root, no .md
      logSummary: string;
    }
  | {
      kind: 'merged';
      agent: string;
      memorySlug: string;
      wikiPath: string;
      logSummary: string;
    }
  | {
      kind: 'skipped';
      agent: string;
      memorySlug: string;
      reason: string;
    }
  | {
      kind: 'failed';
      agent: string;
      memorySlug: string;
      error: string;
    };

/** Dispatcher interface — wraps the LLM call so smoke tests can mock. */
export interface PromotionDispatcher {
  /** Decide whether (and how) to promote a fresh memory file. */
  decidePromotion(args: {
    candidate: PromotionCandidate;
    existingWikiSummary: string; // verkürzte index.md so the LLM knows topology
    workerModel: ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<PromotionDecision>;

  /** Merge a candidate into an existing wiki page. Called when promote
   *  hits a slug collision (writeIfNotExists fails). */
  decideMerge(args: {
    candidate: PromotionCandidate;
    existingWikiPage: string; // full markdown of the existing page
    workerModel: ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<MergeDecision>;
}
