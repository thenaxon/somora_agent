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

export type LucidFindingKind =
  | 'contradiction'
  | 'stale_claim'
  | 'dead_ref'
  | 'outdated'
  | 'wanted_page'
  | 'inconsistent_xref';

export type LucidFindingStatus = 'pending' | 'applied' | 'dismissed';

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
      /** Wiki path including subfolder (e.g. 'personen/conny'). */
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
