// Single source of truth for mapping somora's cross-engine `thinking`
// knob ('off'|'low'|'medium'|'high') to each engine's API-specific
// parameter shape.
//
// Used by:
//   - src/engine/openai-compatible.ts  → reasoning_effort body param
//   - src/engine/claude-cli.ts         → SDK query() option (effort or thinking:disabled)
//   - src/engine/codex-cli.ts          → -c model_reasoning_effort=<level> CLI arg
//   - src/dream/rem-extract.ts         → reasoning_effort for REM-Phase LLM calls
//   - src/dream/deep-llm.ts            → reasoning_effort + SDK option for DEEP/LUCID one-shots
//
// Every helper checks `model.capabilities.includes('reasoning')` first
// and returns empty (=no param) if the active model can't reason. This
// keeps requests clean for opaque local endpoints (Gemma etc.) and
// surfaces the dormant state honestly in the UI.

import type { ThinkingLevel } from '../config/types.ts';

interface ModelLike {
  capabilities: readonly string[];
}

function modelSupportsReasoning(model: ModelLike): boolean {
  return model.capabilities.includes('reasoning');
}

/**
 * OpenAI-style chat.completions body fragment. Spread into the request:
 *
 *   client.chat.completions.create({ model, messages, ...openAiReasoningParam(...) })
 */
export function openAiReasoningParam(
  thinking: ThinkingLevel | undefined,
  model: ModelLike,
): { reasoning_effort?: 'low' | 'medium' | 'high' } {
  if (!thinking || thinking === 'off' || !modelSupportsReasoning(model)) {
    return {};
  }
  return { reasoning_effort: thinking };
}

/**
 * Claude-Agent-SDK option fragment. Spread into `query({ options })`:
 *
 *   const stream = query({ prompt, options: { ...base, ...claudeCliThinkingOptions(...) } })
 *
 * Returns one of:
 *   {}                                — model doesn't reason, or no setting
 *   { thinking: { type: 'disabled' } } — user explicitly set thinking off
 *   { effort: 'low'|'medium'|'high' } — engaged reasoning at requested level
 */
export function claudeCliThinkingOptions(
  thinking: ThinkingLevel | undefined,
  model: ModelLike,
):
  | { effort: 'low' | 'medium' | 'high' }
  | { thinking: { type: 'disabled' } }
  | Record<string, never> {
  if (!modelSupportsReasoning(model)) return {};
  if (!thinking) return {};
  if (thinking === 'off') return { thinking: { type: 'disabled' as const } };
  return { effort: thinking };
}

/**
 * Codex CLI spawn-args fragment. Append to the command-line:
 *
 *   args.push(...codexCliReasoningArgs(thinking, model));
 *
 * Codex maps 'off' to its own 'minimal' level (it doesn't accept a
 * literal disable). Non-reasoning models get an empty array so the
 * spawn-line stays clean.
 */
export function codexCliReasoningArgs(
  thinking: ThinkingLevel | undefined,
  model: ModelLike,
): string[] {
  if (!thinking || !modelSupportsReasoning(model)) return [];
  const codexEffort = thinking === 'off' ? 'minimal' : thinking;
  return ['-c', `model_reasoning_effort=${codexEffort}`];
}

/**
 * Grok Build spawn-args fragment. Append to the `grok agent … stdio`
 * command-line:
 *
 *   args.push(...grokCliReasoningArgs(thinking, model));
 *
 * grok-4.5 advertises exactly three efforts in its ACP handshake
 * (`_meta.modelState.availableModels[].reasoningEffort{,s}`):
 * low | medium | high, default high. There is no "disabled" state —
 * the model always reasons — so 'off' maps to 'low' rather than
 * silently dropping the flag, which would leave the model at its
 * default 'high' and make /thinking off look broken.
 */
export function grokCliReasoningArgs(
  thinking: ThinkingLevel | undefined,
  model: ModelLike,
): string[] {
  if (!thinking || !modelSupportsReasoning(model)) return [];
  const effort = thinking === 'off' ? 'low' : thinking;
  return ['--reasoning-effort', effort];
}
