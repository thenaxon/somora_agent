// Sampling-parameter helpers for the `/sampling` and `/temp` slash
// commands: the key catalogue, the `key=value` argument parser and the
// one-line formatter used by notices and the header badge.
//
// The web client has a deliberate twin of this file at
// web/src/lib/sampling.ts (the two clients share no code). Keep the two
// in sync by hand.

export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string | string[];
}

export type SamplingKey = keyof SamplingParams;

/** A PUT body: keys set to `null` remove that key from the override. */
export type SamplingPatch = { [K in SamplingKey]?: SamplingParams[K] | null };

/** Display + sort order for all keys — the order the server contract lists them. */
export const SAMPLING_KEYS: readonly SamplingKey[] = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'stop',
];

export const SAMPLING_KEY_HINTS: Record<SamplingKey, string> = {
  temperature: '0–2 · randomness, 1 = model default',
  top_p: '0–1 · nucleus sampling cutoff',
  top_k: 'integer ≥ 1 · candidate pool size',
  min_p: '0–1 · minimum relative token probability',
  frequency_penalty: '-2–2 · penalise repeated tokens by count',
  presence_penalty: '-2–2 · penalise tokens already present',
  repetition_penalty: '> 0 · multiplicative repetition penalty',
  seed: 'integer · deterministic sampling seed',
  stop: 'comma-separated stop sequences',
};

export const SAMPLING_USAGE =
  `usage: /sampling [key=value …|default] — keys: ${SAMPLING_KEYS.join(' ')} · ` +
  'value "null" or "-" removes a key';

export const TEMP_USAGE = 'usage: /temp <0–2>|default';

export type SamplingParseResult =
  | { ok: true; params: SamplingPatch }
  | { ok: false; error: string };

function numberIn(
  key: SamplingKey,
  raw: string,
  opts: { min?: number; max?: number; int?: boolean; gtZero?: boolean },
): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(raw);
  const bounds =
    opts.min !== undefined && opts.max !== undefined
      ? ` between ${opts.min} and ${opts.max}`
      : opts.gtZero
        ? ' greater than 0'
        : '';
  const what = `${opts.int ? 'an integer' : 'a number'}${bounds}`;
  if (raw.trim() === '' || !Number.isFinite(n)) {
    return { ok: false, error: `${key} must be ${what}` };
  }
  if (opts.int && !Number.isInteger(n)) return { ok: false, error: `${key} must be ${what}` };
  if (opts.min !== undefined && n < opts.min) return { ok: false, error: `${key} must be ${what}` };
  if (opts.max !== undefined && n > opts.max) return { ok: false, error: `${key} must be ${what}` };
  if (opts.gtZero && n <= 0) return { ok: false, error: `${key} must be ${what}` };
  return { ok: true, value: n };
}

/** Parse one value for one key. Exposed so `/temp` can reuse the
 *  temperature rule without going through the `key=value` split. */
export function parseSamplingValue(
  key: SamplingKey,
  raw: string,
): { ok: true; value: SamplingParams[SamplingKey] } | { ok: false; error: string } {
  switch (key) {
    case 'temperature':
      return numberIn(key, raw, { min: 0, max: 2 });
    case 'top_p':
    case 'min_p':
      return numberIn(key, raw, { min: 0, max: 1 });
    case 'top_k':
      return numberIn(key, raw, { min: 1, int: true });
    case 'frequency_penalty':
    case 'presence_penalty':
      return numberIn(key, raw, { min: -2, max: 2 });
    case 'repetition_penalty':
      return numberIn(key, raw, { gtZero: true });
    case 'seed':
      return numberIn(key, raw, { int: true });
    case 'stop': {
      const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return { ok: false, error: 'stop needs at least one sequence' };
      return { ok: true, value: parts.length === 1 ? parts[0] : parts };
    }
  }
}

export function isSamplingKey(s: string): s is SamplingKey {
  return (SAMPLING_KEYS as readonly string[]).includes(s);
}

/** Parse `key=value` tokens into a PUT patch. `null` / `-` as value
 *  means "remove this key". Any bad token fails the whole parse so
 *  the caller shows a usage notice and sends nothing. */
export function parseSamplingArgs(tokens: readonly string[]): SamplingParseResult {
  const params: SamplingPatch = {};
  const clean = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  if (clean.length === 0) return { ok: false, error: 'no key=value pairs given' };
  for (const tok of clean) {
    const eq = tok.indexOf('=');
    if (eq <= 0) return { ok: false, error: `expected key=value, got "${tok}"` };
    const key = tok.slice(0, eq).trim().toLowerCase();
    const raw = tok.slice(eq + 1).trim();
    if (!isSamplingKey(key)) return { ok: false, error: `unknown key "${key}"` };
    if (raw === 'null' || raw === '-') {
      params[key] = null;
      continue;
    }
    const v = parseSamplingValue(key, raw);
    if (!v.ok) return { ok: false, error: v.error };
    (params as Record<string, unknown>)[key] = v.value;
  }
  return { ok: true, params };
}

/** `temperature=1 top_p=0.95` in catalogue order; `(engine default)`
 *  when nothing is set. Null entries (from a patch) render as `key=-`. */
export function formatSamplingParams(params: SamplingPatch | SamplingParams | null | undefined): string {
  if (!params) return '(engine default)';
  const parts: string[] = [];
  for (const key of SAMPLING_KEYS) {
    if (!(key in params)) continue;
    const v = (params as SamplingPatch)[key];
    if (v === undefined) continue;
    if (v === null) parts.push(`${key}=-`);
    else if (Array.isArray(v)) parts.push(`${key}=${v.join(',')}`);
    else parts.push(`${key}=${String(v)}`);
  }
  return parts.length ? parts.join(' ') : '(engine default)';
}

export function hasSamplingParams(params: SamplingParams | null | undefined): boolean {
  return !!params && SAMPLING_KEYS.some((k) => params[k] !== undefined && params[k] !== null);
}
