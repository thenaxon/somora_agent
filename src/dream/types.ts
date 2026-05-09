// Dream-Mode types (Phase 2-Stufe-D, FUTURE.md). Findings extracted from
// a session-JSONL-delta against existing memory + (optionally) referenced
// vault content, presented to the user via tool-surface for explicit
// approval. Read-only — no auto-mutation of memory.

export type DreamTriggerKind = 'auto' | 'manual';

export type DreamStatus =
  | 'running' // extraction LLM is actively working
  | 'paused' // extraction was interrupted (auto-dream cancelled by user activity, or server crash)
  | 'failed' // extraction errored unrecoverably; details in `error` field
  | 'completed' // extraction done, findings present, awaiting user review
  | 'processed'; // all findings resolved (applied or dismissed); file moved to processed/

export type FindingStatus =
  | 'pending' // not yet reviewed by user
  | 'applied' // user approved + memory action executed
  | 'dismissed'; // user rejected (or dream-as-whole dismissed)

/**
 * A concrete change suggestion. Each finding maps 1:1 to a memory_*
 * tool call (or a vault-write recommendation, which today only surfaces
 * as a hint — `obsidian_write` is future work).
 *
 * Action determines which fields are required:
 *   memory_write   — slug + proposed_content (+ optional frontmatter_tags)
 *   memory_edit    — slug + current_excerpt + proposed_content
 *   memory_delete  — slug (proposed_content not used; reason should be strong)
 *   vault_hint     — slug (vault path) + reason (no auto-action; user-only)
 */
export type FindingAction = 'memory_write' | 'memory_edit' | 'memory_delete' | 'vault_hint';

export interface Finding {
  id: number;
  action: FindingAction;
  slug: string;
  current_excerpt?: string;
  proposed_content?: string;
  frontmatter_tags?: string[];
  reason: string;
  status: FindingStatus;
  /** ISO timestamp set when status transitions to applied/dismissed. */
  resolved_at?: string;
}

export interface DreamMeta {
  id: string;
  agent: string;
  /** Source session id (the session whose JSONL delta was extracted). */
  source_session: string;
  trigger: DreamTriggerKind;
  status: DreamStatus;
  /** Timestamp range covered by this dream (delta-bounds). */
  range_from_ts: number;
  range_through_ts: number;
  created_at: string;
  /** Set when extraction completes successfully. */
  completed_at?: string;
  /** Set when all findings are resolved. */
  processed_at?: string;
  /** Populated when status === 'failed'. */
  error?: string;
  /** Number of chunks processed; 0 = single-chunk; helps resume after pause. */
  chunks_done: number;
  /** Total chunks planned (set after first range/chunk plan). */
  chunks_total: number;
  /** Engine + model that ran the extraction (for diagnostics). */
  worker_model_ref: string;
  findings: Finding[];
}

/**
 * The on-disk format combines a YAML-frontmatter `DreamMeta` with a
 * Markdown body for human-readable inspection. Atomic-rewrite pattern:
 * write to `<file>.tmp`, then rename over the original. State transitions
 * (status changes, finding-status updates) all go through this.
 */
export interface DreamFile {
  meta: DreamMeta;
  /** Markdown body — human-readable summary. The structured truth is in meta. */
  body: string;
}
