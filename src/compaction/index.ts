// Compaction module — public surface.
//
// Architecture (DECISIONS #21):
//   - JSONL stays append-only, ground truth.
//   - meta.compactions[] is the index of compaction events.
//   - Each compaction has a throughTs marker + a structured summary.
//   - Engines consult compactions[] when building messages so that
//     events with ts <= throughTs are replaced by the summary.
//
// CLI engines (claude-cli, codex-cli) get the same benefit transparently
// for their delta-replay (replay.ts is compaction-aware).

export type { Compaction, CompactionConfig } from './types.ts';
export {
  DEFAULT_COMPACTION_CONFIG,
  resolveCompactionConfig,
  pickLatest,
  pickLatestApplicable,
} from './types.ts';
export {
  estimateContextSize,
  estimateTokens,
  shouldCompact,
  type ShouldCompactDecision,
} from './policy.ts';
export { extractCompactionRange, runCompaction } from './summarize.ts';
export { buildSummaryPrompt } from './template.ts';
