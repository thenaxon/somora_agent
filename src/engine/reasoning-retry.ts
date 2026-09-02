// One retry when an openai-compatible backend rejects the reasoning
// effort value. Shared by the chat engine (src/engine/openai-compatible.ts)
// and the dream one-shots (src/dream/rem-extract.ts, src/dream/deep-llm.ts)
// so a `thinking:` setting on a REM/Deep worker cannot kill a chunk the
// way it could not kill a chat turn.
//
// Vocabularies differ per model (Qwen: xhigh|medium|low, DeepSeek:
// low|high|max, OpenAI: none…xhigh) and some backends answer an unknown
// value with HTTP 400 instead of ignoring it — Qwen's chat template
// raises (verified 2026-09-01). Strategy: read the backend's own
// supported list out of the error, pick the nearest neighbour, send the
// request again ONCE, and keep the adjusted value for the rest of the
// state's lifetime (a turn, a REM run).

import { logger } from '../server/logger.ts';
import type { ThinkingLevel } from '../config/types.ts';
import {
  isReasoningEffortError,
  openAiReasoningBody,
  parseSupportedEfforts,
  pickFallbackEffort,
  resolveOpenAiReasoning,
  type OpenAiReasoningParamShape,
} from './thinking-params.ts';

export interface ReasoningAdjustment {
  requested: string;
  /** null = parameter omitted on the retry. */
  sent: string | null;
  backend: string;
}

export interface OpenAiReasoningState {
  param: OpenAiReasoningParamShape;
  /** Body fragment for the NEXT request (already adjusted after a retry). */
  body: Record<string, unknown>;
  /** Value on the wire, null when the param is omitted. */
  sent: string | null;
  /** Set by withReasoningRetry after an adjustment; the caller clears it
   *  once surfaced (engine_meta, log line). */
  adjustment: ReasoningAdjustment | null;
}

export function openAiReasoningState(
  thinking: ThinkingLevel | undefined,
  model: Parameters<typeof resolveOpenAiReasoning>[1],
): OpenAiReasoningState {
  const r = resolveOpenAiReasoning(thinking, model);
  return { param: r.param, body: r.body, sent: r.value, adjustment: null };
}

/**
 * Run `send(body)` with the state's reasoning fragment; on a reasoning
 * rejection adjust the state and run it once more. Any other error, or
 * a second rejection, propagates unchanged.
 */
export async function withReasoningRetry<T>(
  state: OpenAiReasoningState,
  send: (reasoningBody: Record<string, unknown>) => Promise<T>,
  logCtx: Record<string, unknown>,
): Promise<T> {
  try {
    return await send(state.body);
  } catch (err) {
    if (state.sent === null || !isReasoningEffortError(err)) throw err;
    const backend = String((err as Error).message ?? err);
    const supported = parseSupportedEfforts(backend);
    const fallback = supported ? pickFallbackEffort(state.sent, supported) : null;
    if (fallback === state.sent) throw err; // backend lists it yet rejects — not ours to fix
    logger.warn({
      msg: 'engine.reasoning_effort_rejected',
      ...logCtx,
      requested: state.sent,
      supported,
      fallback,
      backend: backend.slice(0, 300),
    });
    state.adjustment = { requested: state.sent, sent: fallback, backend: backend.slice(0, 300) };
    state.sent = fallback;
    state.body = openAiReasoningBody(state.param, fallback);
    return await send(state.body);
  }
}
