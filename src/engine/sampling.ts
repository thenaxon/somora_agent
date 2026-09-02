// Sampling parameters (temperature, top_p, …) for the openai-compatible
// engine. Same three-layer pattern as the thinking knob: model default
// in config.yaml < agent.yaml `sampling:` < per-session override
// (`/sampling`, `/temp`). claude-cli / codex-cli / grok-cli expose no
// such knobs — there the setting is dormant and the clients say so.
//
// Every key goes on the wire under its own name. OpenAI itself knows
// temperature / top_p / frequency_penalty / presence_penalty / seed /
// stop; vLLM, SGLang, LiteLLM and most local servers additionally take
// top_k / min_p / repetition_penalty as top-level fields. A backend that
// rejects a key answers 400 — the engine then retries once without any
// sampling parameters (see openai-compatible.ts) so a tuning knob can
// never fail a turn.

import type { SamplingConfig } from '../config/types.ts';

export type SamplingParams = SamplingConfig;

/** Wire order, also the display order. */
export const SAMPLING_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'stop',
] as const satisfies ReadonlyArray<keyof SamplingParams>;

/**
 * Field-level merge: later layers win per key, `undefined` leaves the
 * earlier value, `null` (only meaningful in a session override) drops
 * the key. Returns undefined when nothing is set.
 */
export function mergeSampling(
  ...layers: Array<Partial<Record<keyof SamplingParams, unknown>> | null | undefined>
): SamplingParams | undefined {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of SAMPLING_KEYS) {
      const v = (layer as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (v === null) delete out[key];
      else out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? (out as SamplingParams) : undefined;
}

/** Body fragment to spread into a chat.completions request. */
export function samplingBody(sampling: SamplingParams | undefined): Record<string, unknown> {
  if (!sampling) return {};
  const out: Record<string, unknown> = {};
  for (const key of SAMPLING_KEYS) {
    const v = sampling[key];
    if (v !== undefined && v !== null) out[key] = v;
  }
  return out;
}

/** `temperature=1 top_p=0.95` — for notices, logs and badges. */
export function formatSampling(sampling: SamplingParams | undefined | null): string {
  if (!sampling) return '';
  const parts: string[] = [];
  for (const key of SAMPLING_KEYS) {
    const v = sampling[key];
    if (v === undefined || v === null) continue;
    parts.push(`${key}=${Array.isArray(v) ? v.join(',') : String(v)}`);
  }
  return parts.join(' ');
}

/**
 * True when a backend error is about one of the sampling keys — e.g.
 * OpenAI on a reasoning model: `Unsupported parameter: 'temperature' is
 * not supported with this model`, or vLLM: `top_k must be -1 (disable),
 * or at least 1`. Only these trigger the drop-and-retry; a context
 * overflow or an auth error must not.
 */
export function isSamplingParamError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  const namesKey = SAMPLING_KEYS.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(msg));
  if (!namesKey) return false;
  return /unsupported|not supported|invalid|must be|out of range|unknown (parameter|field)|unexpected (parameter|field|keyword)|extra (inputs|fields)|not permitted|does not support/i.test(
    msg,
  );
}
