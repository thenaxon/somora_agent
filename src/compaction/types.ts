// Compaction state types. Matches the meta-file schema documented in
// DECISIONS #21. The Compaction array on a session meta is append-only;
// each new entry's `throughTs` must be > the previous one's, and each
// summary is intended to subsume all earlier ones (caller may either
// store a fully-cumulative summary or the latest delta — current
// implementation produces cumulative summaries).

export interface Compaction {
  /** Wall-clock ts when the compaction was created. */
  ts: number;
  /** All session events with ts <= throughTs are considered compacted. */
  throughTs: number;
  /** LLM-generated summary covering the compacted range. */
  summary: string;
  /** Engine name that drove the compaction. */
  byEngine: string;
  /** Provider/model id that produced the summary. */
  byModel: string;
  /** Input-token estimate of the compacted span before the call. */
  tokensBefore?: number;
  /** Output-token count of the summary itself. */
  tokensAfter?: number;
}

export interface CompactionConfig {
  /**
   * Fraction of contextWindow at which compaction is triggered (0..1).
   * Default 0.8 — leaves room for the response without thrashing too early.
   */
  triggerRatio: number;
  /**
   * Minimum number of recent user/assistant turn pairs to keep _intact_,
   * not subjected to compaction. Default 4.
   */
  safetyCushionPairs: number;
  /**
   * Optional override for the model used to generate the summary.
   * If unset, uses the same model the turn would have run on.
   * Format: alias or `provider/modelId` (resolved via resolveAnyRef).
   */
  modelOverride?: string;
}

function parsePositiveFloat(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0 || v > 1) return undefined;
  return v;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) return undefined;
  return v;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerRatio: parsePositiveFloat(process.env.SOMORA_COMPACTION_TRIGGER_RATIO) ?? 0.8,
  safetyCushionPairs:
    parsePositiveInt(process.env.SOMORA_COMPACTION_SAFETY_PAIRS) ?? 4,
};

/** Picks the latest compaction whose `throughTs > sinceTs` (covers `sinceTs`). */
export function pickLatestApplicable(
  compactions: Compaction[] | undefined,
  sinceTs: number,
): Compaction | undefined {
  if (!compactions || compactions.length === 0) return undefined;
  let best: Compaction | undefined;
  for (const c of compactions) {
    if (c.throughTs > sinceTs) {
      if (!best || c.throughTs > best.throughTs) best = c;
    }
  }
  return best;
}

/** Picks the latest compaction overall, regardless of `sinceTs`. */
export function pickLatest(compactions: Compaction[] | undefined): Compaction | undefined {
  if (!compactions || compactions.length === 0) return undefined;
  return compactions.reduce((acc, c) => (c.throughTs > acc.throughTs ? c : acc));
}
