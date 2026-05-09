// Trigger policy. Decides whether a compaction should run before the
// next turn, based on a rough token estimate of the prompt that would
// be sent if we did nothing. Estimate is intentionally conservative
// (4 chars/token heuristic) — refining this with a real tokenizer is
// a Phase-2-polish task, but for trigger decisions a rough estimate
// is fine: we just need to know if we're approaching the wall.

import type { NormalizedEvent } from '../types/events.ts';
import { pickLatest, type Compaction, type CompactionConfig } from './types.ts';

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface ContextSizeInput {
  systemPrompt: string;
  history: NormalizedEvent[];
  compactions?: Compaction[];
}

/**
 * Estimate the prompt size in tokens that would be assembled for the
 * next turn if no compaction ran. Mirrors the structure that
 * buildMessages would produce: system prompt + (summary if compacted)
 * + uncompacted user/assistant pairs.
 */
export function estimateContextSize({
  systemPrompt,
  history,
  compactions,
}: ContextSizeInput): number {
  let chars = systemPrompt.length;
  const latest = pickLatest(compactions);
  if (latest) {
    chars += latest.summary.length;
  }
  const sinceTs = latest?.throughTs ?? 0;
  for (const ev of history) {
    if (ev.ts <= sinceTs) continue;
    if (ev.kind === 'user_message' || ev.kind === 'assistant_message') {
      chars += ev.text.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ShouldCompactInput {
  systemPrompt: string;
  history: NormalizedEvent[];
  compactions?: Compaction[];
  contextWindow: number;
  config: CompactionConfig;
}

export interface ShouldCompactDecision {
  shouldCompact: boolean;
  estimatedTokens: number;
  triggerTokens: number;
  ratio: number;
}

export function shouldCompact(input: ShouldCompactInput): ShouldCompactDecision {
  const estimatedTokens = estimateContextSize(input);
  const triggerTokens = Math.floor(input.config.triggerRatio * input.contextWindow);
  return {
    shouldCompact: estimatedTokens >= triggerTokens,
    estimatedTokens,
    triggerTokens,
    ratio: estimatedTokens / input.contextWindow,
  };
}
