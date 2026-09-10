// Trigger policy. Decides whether a compaction should run before the
// next turn.
//
// Two measurements, in order of trust:
//
//   1. What the provider counted for the last request of this session
//      (`usage.prompt_tokens`, carried as `SessionMeta.contextTokens`).
//      This is the only number that is actually true, and OpenClaw and
//      Hermes Agent both build their trigger on it rather than on an
//      estimate.
//   2. A character estimate, when no fresh reading exists — a new
//      session, a model switch, or a provider that omits usage.
//
// The estimate is deliberately conservative and only has to answer "are
// we near the wall". It used to answer that badly: it counted user and
// assistant TEXT only, so a session made of tool traffic looked tiny
// (measured 2026-09-10: 25,982 tokens visible out of 615,329 actually
// sent) and never triggered at all. Tool calls and results now count.

import type { NormalizedEvent } from '../types/events.ts';
import { pickLatest, type Compaction, type CompactionConfig } from './types.ts';

const CHARS_PER_TOKEN = 4;

/** Mirror of MAX_REPLAYED_TOOL_RESULT_CHARS in the engine: history
 *  replay caps each tool result, so the estimate must cap it too. */
const REPLAYED_TOOL_RESULT_CAP = 800;

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
 * next turn if no compaction ran. Mirrors what the engine actually
 * replays: system prompt, the latest summary, every user/assistant
 * message after it, plus the tool activity — arguments in full (they
 * travel verbatim) and results capped the way the replay caps them.
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
    } else if (ev.kind === 'tool_call') {
      // Arguments are replayed verbatim and are the bulk of an agentic
      // session: exec scripts, file contents, patches.
      chars += safeJsonLength(ev.input);
    } else if (ev.kind === 'tool_result') {
      chars += Math.min(safeJsonLength(ev.output ?? ev.error ?? ''), REPLAYED_TOOL_RESULT_CAP);
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function safeJsonLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * How much prompt actually fits: the window minus the output the model
 * still has to write. Hermes Agent carries an incident number for this
 * one — a threshold on the full window lets a session walk into a
 * provider 400 while every check said it fits. Measured here on
 * 2026-09-10: window 524,288, output cap 16,384, and the request that
 * died carried 507,905 input tokens. One token over the input budget,
 * comfortably under the window.
 */
export function inputBudget(contextWindow: number, maxOutputTokens?: number): number {
  const budget = contextWindow - (maxOutputTokens ?? 0);
  return budget > 0 ? budget : contextWindow;
}

export interface ShouldCompactInput {
  systemPrompt: string;
  history: NormalizedEvent[];
  compactions?: Compaction[];
  contextWindow: number;
  config: CompactionConfig;
  /** The model's declared output cap, reserved out of the same window. */
  maxOutputTokens?: number;
  /**
   * What the provider counted for the last request of this session, when
   * it is still valid for the model about to answer. Beats the estimate.
   */
  measuredTokens?: number;
  /**
   * measured ÷ estimated from the last request. The reading covers the
   * last request only; everything appended since — the new user message,
   * the previous turn's tool results — exists as an estimate, and an
   * estimate of code or JSON is far too low without this factor. Measured
   * live 2026-09-10: a session sat one turn below the trigger by
   * estimate, went 7,000 tokens over the budget with the next message,
   * and never compacted.
   */
  tokenRatio?: number;
}

export interface ShouldCompactDecision {
  shouldCompact: boolean;
  estimatedTokens: number;
  triggerTokens: number;
  ratio: number;
  /** Which measurement decided: the provider's count or our estimate. */
  source: 'measured' | 'estimated';
}

const MIN_RATIO = 0.5;
const MAX_RATIO = 3;

export function shouldCompact(input: ShouldCompactInput): ShouldCompactDecision {
  const raw = estimateContextSize(input);
  const ratio =
    input.tokenRatio && Number.isFinite(input.tokenRatio)
      ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, input.tokenRatio))
      : 1;
  const estimated = Math.ceil(raw * ratio);
  // A measured reading covers everything up to the last request. The
  // estimate covers the same span plus whatever came after it, so the
  // larger of the two is the honest answer.
  const measured = input.measuredTokens;
  const useMeasured = typeof measured === 'number' && measured > 0 && measured >= estimated;
  const estimatedTokens = useMeasured ? measured! : estimated;
  const budget = inputBudget(input.contextWindow, input.maxOutputTokens);
  const triggerTokens = Math.floor(input.config.triggerRatio * budget);
  return {
    shouldCompact: estimatedTokens >= triggerTokens,
    estimatedTokens,
    triggerTokens,
    ratio: estimatedTokens / budget,
    source: useMeasured ? 'measured' : 'estimated',
  };
}
