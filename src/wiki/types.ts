// Dream-B types: candidates, plans, dispatcher interface.
//
// See `private/wiki-design.md` § "Drei Dream-Modes" for the design,
// and § "Dream-B Verhaltens-Detail" for the orchestration shape.

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
  /** Stub-or-fresh classification. */
  kind: 'fresh' | 'stub_with_observations';
  /** Only set when kind === 'stub_with_observations'. */
  stub?: {
    promotedTo: string; // wiki path without .md
    promotedAt: string;
    observations: string[]; // bullet lines
  };
}

/** Outcome of running the LLM dispatcher on a fresh-memory candidate. */
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

/** Outcome of running the LLM dispatcher on a stub-with-observations
 *  candidate (merge existing wiki page with new observations). */
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
      observationsConsumed: number;
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

  /** Merge new observations into an existing wiki page. */
  decideMerge(args: {
    candidate: PromotionCandidate;
    existingWikiPage: string; // full markdown of the existing page
    workerModel: ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<MergeDecision>;
}
