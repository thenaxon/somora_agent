// Wiki-Lint types (Phase 4 / Stufe 5).
//
// LintFinding is the central discriminated union — each finding has a
// concrete action that maps 1:1 to a fix function. Findings live in
// LintRun records (one per Dream-C invocation).
//
// User flow: Dream-C runs (auto every intervalDays or manual via
// dream_run mode='c'). Findings are persisted as a "lint" entity that
// the dream_*-tool family surfaces alongside per-agent dream-A
// findings. User reviews via dream_list/dream_get/dream_apply/dismiss.

export type LintFindingKind =
  | 'broken_wikilink'
  | 'orphan_page'
  | 'index_missing'
  | 'index_stale'
  | 'one_way_link';

export type LintFindingStatus = 'pending' | 'applied' | 'dismissed';

interface BaseFinding {
  id: number;
  kind: LintFindingKind;
  status: LintFindingStatus;
  reason: string;
  resolved_at?: string;
}

/** A `[[X]]` token in <wikiPath> points at a page that does not exist. */
export interface BrokenWikilinkFinding extends BaseFinding {
  kind: 'broken_wikilink';
  /** Wiki page (relative to wiki root, no .md) where the broken link sits. */
  in_page: string;
  /** Target slug from the [[…]] token, as written. */
  broken_target: string;
  /** Optional repair suggestion: existing slug similar to broken_target. */
  suggested_target?: string;
}

/** A wiki page exists but is referenced nowhere AND not in index.md. */
export interface OrphanPageFinding extends BaseFinding {
  kind: 'orphan_page';
  /** Wiki page (relative, no .md). */
  page: string;
}

/** A wiki page exists in the wiki tree but isn't listed in index.md. */
export interface IndexMissingFinding extends BaseFinding {
  kind: 'index_missing';
  page: string;
}

/** index.md lists a page that no longer exists in the tree. */
export interface IndexStaleFinding extends BaseFinding {
  kind: 'index_stale';
  page: string;
}

/** Page A links `[[B]]` but B does not link back to A. Suggest add backlink. */
export interface OneWayLinkFinding extends BaseFinding {
  kind: 'one_way_link';
  /** The page that already mentions the other. */
  from_page: string;
  /** The page that's missing the back-reference. */
  to_page: string;
}

export type LintFinding =
  | BrokenWikilinkFinding
  | OrphanPageFinding
  | IndexMissingFinding
  | IndexStaleFinding
  | OneWayLinkFinding;

export type LintRunStatus = 'running' | 'completed' | 'failed' | 'processed';

export interface LintRun {
  id: string;
  /** Status: running, completed (findings present, awaiting review),
   *  failed, or processed (all findings resolved). */
  status: LintRunStatus;
  /** ISO timestamp when the run started. */
  created_at: string;
  /** ISO timestamp set when extraction completes successfully. */
  completed_at?: string;
  /** ISO timestamp set when all findings resolved. */
  processed_at?: string;
  /** Trigger: 'auto' (real-clock scheduler) or 'manual' (dream_run). */
  trigger: 'auto' | 'manual';
  /** Populated when status === 'failed'. */
  error?: string;
  /** Wiki page count examined. */
  pages_scanned: number;
  /** All findings, ordered by id (insertion order). */
  findings: LintFinding[];
}
