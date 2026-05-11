// Deep-Phase types: candidates, plans, dispatcher interface.
//
// See `private/dream-system-v2.md` for the design.
//
// As of v2.2 the stub-with-observations variant is gone. All candidates
// are 'fresh' memory files; merge-vs-promote is decided by Deep at
// processing time (collision-detection on slug-write).

import type { ResolvedModel, ThinkingLevel } from '../config/types.ts';

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

/** Unified Deep-decision for one memory candidate. Single LLM call
 *  picks one of three outcomes — see `src/dream/deep-prompts.ts`. */
export type MemoryFateDecision =
  | {
      kind: 'skip';
      reason: string;
      /** Set when the skip is the result of a transient failure
       *  (LLM call error, JSON parse failure, schema mismatch) — i.e.
       *  NOT a deliberate skip-decision from the model. The runner
       *  must not record transient skips into the per-agent skip-cache,
       *  or the memory file gets stuck across runs (verified bug
       *  2026-05-09: mac-studio-korrektur stuck on parser-failure).
       *  Genuine model-emitted skips (transient unset) are stable and
       *  cacheable. */
      transient?: true;
    }
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
      kind: 'merge';
      /** Existing wiki page slug (without .md) to update. */
      wikiPath: string;
      /** Updated body for the wiki page (no frontmatter — caller
       *  preserves frontmatter, only refreshes `updated`). */
      body: string;
      /** Optional updated cross-references. */
      related?: string[];
      /** One-line summary for the wiki log. */
      logSummary: string;
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
      /** When true, the skip resulted from a transient failure (LLM
       *  call/parse error, schema mismatch, mtime conflict, write
       *  failure) — not a stable model-emitted skip-decision. The
       *  runner uses this to gate the per-agent skip-cache so a
       *  one-off failure can't lock a memory file out forever. */
      transient?: true;
    }
  | {
      kind: 'failed';
      agent: string;
      memorySlug: string;
      error: string;
    };

/** Dispatcher interface — wraps the LLM call so smoke tests can mock.
 *  Single decision point per candidate; LLM decides skip/promote/merge
 *  based on the wiki context provided. */
export interface PromotionDispatcher {
  decideMemoryFate(args: {
    candidate: PromotionCandidate;
    /** Wiki topology (index.md content). Always present. */
    wikiIndex: string;
    /** Full bodies of N most-relevant existing wiki pages
     *  (embedding-matched against the candidate's memory body). */
    relevantPages: Array<{ slug: string; markdown: string }>;
    workerModel: ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
    /** Optional thinking-level forwarded into the LLM call. Set from
     *  `config.wiki.deep.thinking` by the runner. */
    thinking?: ThinkingLevel;
  }): Promise<MemoryFateDecision>;
}
