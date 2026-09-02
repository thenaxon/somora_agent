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

import type { ModelReasoningConfig, ThinkingLevel } from '../config/types.ts';

interface ModelLike {
  capabilities: readonly string[];
  /** Optional per-model vocabulary + wire shape (openai-compatible only). */
  reasoning?: ModelReasoningConfig;
}

function modelSupportsReasoning(model: ModelLike): boolean {
  return model.capabilities.includes('reasoning');
}

// ── openai-compatible ─────────────────────────────────────────────────

/** Where the effort value goes in a chat.completions body. */
export type OpenAiReasoningParamShape = NonNullable<ModelReasoningConfig['param']>;

export interface OpenAiReasoning {
  /** The value actually sent, or null when the param is omitted. */
  value: string | null;
  /** Wire shape used for `value`. */
  param: OpenAiReasoningParamShape;
  /** Body fragment to spread into the request. `{}` when omitted. */
  body: Record<string, unknown>;
}

/**
 * Resolve somora's neutral level to what THIS model gets on the wire.
 *
 * Without a `reasoning:` block on the model the legacy mapping applies:
 * `off` omits the param, `low|medium|high` go through verbatim as
 * `reasoning_effort`. With a block, `levels` overrides per level — a
 * string is sent as-is, `null` omits the param (a model with no real
 * "off" can map `off: null` to fall back to its default, or `off: low`
 * to ask for as little as it allows). Levels missing from the block keep
 * the legacy mapping. `param` picks the body shape:
 *
 *   reasoning_effort     → { reasoning_effort: value }            (OpenAI, vLLM, LiteLLM)
 *   reasoning            → { reasoning: { effort: value } }       (OpenRouter)
 *   chat_template_kwargs → { chat_template_kwargs: { reasoning_effort: value } } (vLLM templates that only read kwargs)
 *
 * Vocabularies differ per model and some backends reject unknown values
 * with HTTP 400 instead of ignoring them (Qwen's chat template raises;
 * verified 2026-09-01), so the engine additionally retries once via
 * pickFallbackEffort() when the backend names its supported values.
 */
export function resolveOpenAiReasoning(
  thinking: ThinkingLevel | undefined,
  model: ModelLike,
): OpenAiReasoning {
  const param = model.reasoning?.param ?? 'reasoning_effort';
  if (!thinking || !modelSupportsReasoning(model)) return { value: null, param, body: {} };
  const levels = model.reasoning?.levels ?? {};
  const configured = levels[thinking];
  let value: string | null;
  if (configured === undefined) value = thinking === 'off' ? null : thinking;
  else value = configured;
  return { value, param, body: openAiReasoningBody(param, value) };
}

/** Body fragment for a concrete wire value (null → `{}`). */
export function openAiReasoningBody(
  param: OpenAiReasoningParamShape,
  value: string | null,
): Record<string, unknown> {
  if (value === null) return {};
  switch (param) {
    case 'reasoning':
      return { reasoning: { effort: value } };
    case 'chat_template_kwargs':
      return { chat_template_kwargs: { reasoning_effort: value } };
    default:
      return { reasoning_effort: value };
  }
}

/**
 * OpenAI-style chat.completions body fragment. Spread into the request:
 *
 *   client.chat.completions.create({ model, messages, ...openAiReasoningParam(...) })
 */
export function openAiReasoningParam(
  thinking: ThinkingLevel | undefined,
  model: ModelLike,
): Record<string, unknown> {
  return resolveOpenAiReasoning(thinking, model).body;
}

/**
 * Canonical effort ladder, weakest first. Union of the vocabularies we
 * have met (OpenAI none…xhigh, DeepSeek max, Qwen xhigh). Used only to
 * pick a NEIGHBOUR when a backend rejects a value — never to validate.
 */
export const EFFORT_LADDER: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** True when a backend error is about the reasoning-effort value. */
export function isReasoningEffortError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /reasoning[ _.-]?effort|reasoning\.effort|effort.*(?:unsupported|not supported|invalid)/i.test(
    msg,
  );
}

/**
 * Pull the backend's own list of accepted values out of its error text,
 * e.g. vLLM/Qwen: `Unexpected reasoning effort high. Supported: xhigh,
 * medium, low`, OpenAI: `supported values are: 'low', 'medium', 'high'`.
 * Returns null when the message names none.
 */
export function parseSupportedEfforts(message: string): string[] | null {
  // A colon or "are" must follow "supported" — "not supported by this
  // model" names no values and must not be parsed as a list.
  const m =
    /supported(?:\s+(?:values|types|efforts|levels))?(?:\s+are\s*:?|\s*[:=])\s*([^.;\n]+)/i.exec(message) ??
    /(?:one of|must be one of|allowed)\s*[:=]?\s*([^.;\n]+)/i.exec(message);
  if (!m) return null;
  // Drop a trailing "for parameter …" clause first, then either take the
  // quoted words ("'low', 'medium', and 'high'") or split the bare list,
  // which ends at the closing quote/brace of a JSON-wrapped message
  // (`… Supported: xhigh, medium, low","type":"BadRequestError"}`).
  const raw = m[1]!.split(/\s+for\s+|\s+in\s+|\s+on\s+/)[0]!.trim();
  const values = /^['"`]/.test(raw)
    ? [...raw.matchAll(/['"`]([a-z_-]+)['"`]/gi)].map((x) => x[1]!.toLowerCase())
    : raw
        .split(/["}\]]/)[0]!
        .split(/[,|/]|\s+or\s+|\s+and\s+/)
        .map((v) => v.replace(/[^a-z_-]/gi, '').toLowerCase())
        .filter((v) => v.length > 0 && v !== 'or' && v !== 'and');
  return values.length > 0 ? [...new Set(values)] : null;
}

/**
 * Nearest supported value for a rejected one: walk DOWN the ladder from
 * the requested rung first (a weaker effort is the safer surprise),
 * then up. A requested value that is not on the ladder is treated as
 * `medium` — the middle of the road is the least surprising guess for
 * a word we have never seen. `none` is
 * never picked as a downgrade target — that would silently disable
 * reasoning the user asked for. Null = omit the param and let the
 * model default.
 */
export function pickFallbackEffort(requested: string, supported: readonly string[]): string | null {
  const ok = new Set(supported.map((v) => v.toLowerCase()));
  if (ok.has(requested.toLowerCase())) return requested;
  const known = EFFORT_LADDER.indexOf(requested.toLowerCase());
  const idx = known >= 0 ? known : EFFORT_LADDER.indexOf('medium');
  const candidates = [...EFFORT_LADDER.slice(0, idx).reverse(), ...EFFORT_LADDER.slice(idx + 1)];
  for (const c of candidates) {
    if (c === 'none') continue;
    if (ok.has(c)) return c;
  }
  return null;
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
