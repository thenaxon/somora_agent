// Lucid types — LLM-driven wiki cleanup findings.
//
// Replaces the deterministic LintFinding union (broken_wikilink,
// orphan_page, index_missing, index_stale, one_way_link) with a
// quality-driven union populated by an Opus run over the full wiki.
//
// Design principle: each finding carries a structured `fix` that the
// apply function uses verbatim — no further LLM call at apply-time.
// The user reviews the finding, sees the proposed fix, approves or
// dismisses.
//
// See `private/dream-system-v2.md` § "Phase Lucid".

/**
 * Active finding kinds (produced by current Lucid prompt). Lucid surfaces
 * only objectively-verifiable issues. Subjective polish is handled in
 * the user-driven dream_review loop, not as Lucid-emitted findings.
 *
 * Legacy kinds (`stale_claim`, `outdated`, `inconsistent_xref`) are
 * kept in the union for backward compatibility with archived runs in
 * `~/.somora/wiki-lucid/processed/` — current Lucid runs no longer
 * produce them.
 */
export type LucidFindingKind =
  | 'contradiction'
  | 'dead_ref'
  | 'wanted_page'
  | 'link_suggestion'
  | 'stale_claim'
  | 'outdated'
  | 'inconsistent_xref';

// 'resolved_manually': content was right but handled outside the dream
// flow — terminal like dismissed, reads as "done" instead of "wrong".
export type LucidFindingStatus = 'pending' | 'applied' | 'dismissed' | 'resolved_manually';

export type LucidFix =
  | {
      kind: 'update_page';
      /** Wiki path (no .md) to overwrite. */
      wikiPath: string;
      /** Full new body. Frontmatter is preserved by applyFinding;
       *  `updated` field auto-refreshed. */
      newBody: string;
      logSummary: string;
    }
  | {
      kind: 'create_page';
      /** Subfolder within the wiki (e.g. 'personen', 'projekte'). */
      subfolder: string;
      /** Wiki path including subfolder (e.g. 'personen/jane-doe'). */
      wikiPath: string;
      /** Frontmatter `type` (person | projekt | konzept | ort | ...). */
      type: string;
      /** H1 title for the new page. */
      title: string;
      /** Body without frontmatter. */
      body: string;
      /** Optional cross-refs. */
      related?: string[];
      logSummary: string;
    }
  | {
      kind: 'delete_page';
      wikiPath: string;
      logSummary: string;
    }
  | {
      kind: 'no_op';
      /** Informational finding — no apply action, dismiss-only. */
      note: string;
    };

export interface LucidFinding {
  id: number;
  kind: LucidFindingKind;
  status: LucidFindingStatus;
  /** Wiki paths affected (for indexing, listing, conflict detection). */
  affected_pages: string[];
  /** LLM's narrative explaining the issue. */
  reason: string;
  /** Structured fix. `kind: 'no_op'` for info-only findings. */
  fix: LucidFix;
  resolved_at?: string;
  /** Optional free-text reason recorded at dismissal time. */
  resolution_note?: string;
}

export type LucidRunStatus = 'running' | 'completed' | 'failed' | 'processed';

export interface LucidRun {
  id: string;
  status: LucidRunStatus;
  /** ISO timestamp when the run started. */
  created_at: string;
  /** ISO timestamp when the LLM call returned. */
  completed_at?: string;
  /** ISO timestamp when all findings resolved. */
  processed_at?: string;
  /** 'auto' (weekly scheduler) or 'manual' (dream_run({phase:'lucid'})). */
  trigger: 'auto' | 'manual';
  /** Populated when status === 'failed'. */
  error?: string;
  /** Wiki pages examined. */
  pages_scanned: number;
  /** Worker model that produced the findings. */
  worker_model_ref: string;
  /** Total tokens estimated for the LLM call (in + out). */
  estimated_tokens?: number;
  /** All findings, ordered by id (insertion order). */
  findings: LucidFinding[];
}
