// Run a compaction: pick the range to summarize, call the LLM, return
// a Compaction object. The caller is responsible for appending it to
// `meta.compactions[]`.
//
// Currently only invoked by the openai-compatible engine — that's
// where it's strictly needed (CLI engines bring their own compaction).
// The summarization itself uses the OpenAI Chat Completions API, which
// every openai-compatible provider speaks. If a future requirement is
// to run summarization through an Anthropic/Claude model, this is the
// place to add a router.

import OpenAI from 'openai';
import type { ResolvedModel } from '../config/types.ts';
import type { ReplayPair } from '../engine/replay.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { buildSummaryPrompt } from './template.ts';
import { pickLatest, type Compaction, type CompactionConfig } from './types.ts';
import { estimateTokens } from './policy.ts';

interface ExtractRangeResult {
  /** Pairs to send to the summary LLM (chronological). */
  pairs: ReplayPair[];
  /** Last ts in the compacted range — becomes Compaction.throughTs. */
  throughTs: number;
  /** Optional prior summary the new one should subsume. */
  priorSummary?: string;
}

/**
 * Determine which user/assistant pairs to compact:
 *   - skip pairs already covered by a previous compaction
 *   - keep the safetyCushionPairs newest pairs intact
 *   - everything in between is the compaction target
 *
 * Returns null if there's nothing meaningful to compact (e.g. the
 * cushion already covers everything).
 */
export function extractCompactionRange(
  history: NormalizedEvent[],
  config: CompactionConfig,
  compactions: Compaction[] | undefined,
): ExtractRangeResult | null {
  const latestPrior = pickLatest(compactions);
  const sinceTs = latestPrior?.throughTs ?? 0;

  // Collect all user/assistant pairs strictly after the prior compaction.
  const pairs: { ts: number; user: string; assistant: string }[] = [];
  let pendingUser: { ts: number; text: string } | undefined;
  for (const ev of history) {
    if (ev.ts <= sinceTs) continue;
    if (ev.kind === 'user_message') {
      pendingUser = { ts: ev.ts, text: ev.text };
    } else if (ev.kind === 'assistant_message' && pendingUser !== undefined) {
      pairs.push({ ts: ev.ts, user: pendingUser.text, assistant: ev.text });
      pendingUser = undefined;
    }
  }

  // Drop the safety cushion (newest N pairs).
  const cushion = config.safetyCushionPairs;
  if (pairs.length <= cushion) {
    return null; // not enough history beyond the cushion
  }
  const compactPairs = pairs.slice(0, pairs.length - cushion);
  const lastPair = compactPairs[compactPairs.length - 1];
  if (!lastPair) return null;
  const throughTs = lastPair.ts;

  return {
    pairs: compactPairs.map((p) => ({ user: p.user, assistant: p.assistant })),
    throughTs,
    priorSummary: latestPrior?.summary,
  };
}

export interface RunCompactionInput {
  systemPrompt: string;
  history: NormalizedEvent[];
  resolvedModel: ResolvedModel;
  compactions: Compaction[] | undefined;
  config: CompactionConfig;
}

export async function runCompaction(
  input: RunCompactionInput,
): Promise<Compaction | null> {
  const { systemPrompt, history, resolvedModel, compactions, config } = input;
  if (resolvedModel.provider.engine !== 'openai-compatible') {
    throw new Error(
      `runCompaction currently supports openai-compatible only, got: ${resolvedModel.provider.engine}`,
    );
  }
  const range = extractCompactionRange(history, config, compactions);
  if (!range) return null;

  const { system, user } = buildSummaryPrompt({
    systemPrompt,
    pairs: range.pairs,
    priorSummary: range.priorSummary,
  });

  const tokensBefore = estimateTokens(
    system + user + range.pairs.map((p) => p.user + p.assistant).join(''),
  );

  const client = new OpenAI({
    baseURL: resolvedModel.provider.baseUrl,
    apiKey: resolvedModel.provider.apiKey,
  });

  const completion = await client.chat.completions.create({
    model: resolvedModel.modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    ...(resolvedModel.model.maxTokens ? { max_tokens: resolvedModel.model.maxTokens } : {}),
  });

  const summary = completion.choices[0]?.message?.content?.trim() ?? '';
  if (!summary) return null;

  const tokensAfter = completion.usage?.completion_tokens ?? estimateTokens(summary);

  return {
    ts: Date.now(),
    throughTs: range.throughTs,
    summary,
    byEngine: 'openai-compatible',
    byModel: `${resolvedModel.providerName}/${resolvedModel.modelId}`,
    tokensBefore,
    tokensAfter,
  };
}
