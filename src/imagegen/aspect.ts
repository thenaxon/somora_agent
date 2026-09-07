// Aspect ratio on the OpenAI image wire.
//
// The OpenAI-shaped image API has no `aspect_ratio` — only `size`. A
// router in front of a backend that DOES understand ratios (LiteLLM in
// front of the cerebro visual-adapter) forwards unknown JSON keys on
// /images/generations but rebuilds the multipart body for /images/edits
// from a fixed whitelist, so `aspect_ratio` silently disappears exactly
// when reference images are involved (2026-09-06/07 reports: every
// "16:9" edit came back 1024×1024). `size` survives both paths.
//
// So on `wire: openai` somora translates before sending:
//   1. the catalog says `size` also accepts named ratios → send the
//      ratio string as `size` ("16:9"), exact by the backend's table;
//   2. else the catalog lists concrete sizes → the listed size whose
//      shape is closest to the ratio;
//   3. else OpenAI's own sizes — best effort, and the mismatch check on
//      the returned pixels says so.
// `aspect_ratio` itself never goes on that wire. The OpenRouter wire
// keeps `aspect_ratio` (it is native there) — this module is not
// consulted for it.

import { parseSizeSpec } from '../multimodal/dimensions.ts';
import type { ImageSpecs, ModelCapabilities } from './types.ts';

/** 1 %: 1536×864 is exactly 16:9, 1792×1024 (7:4, 1.6 % off) is not —
 *  that is the difference the 2026-09-07 report is about. */
export const RATIO_TOLERANCE = 0.01;

/** Fallback when the endpoint publishes nothing: OpenAI's own size set
 *  (gpt-image / dall-e-3). Landscape and portrait are not exact ratios. */
export const OPENAI_WIRE_SIZE_FOR_RATIO: Record<string, string> = {
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
};

/** "16:9" → 1.777…, null for anything that is not `a:b`. */
export function ratioValue(ratio: string | undefined): number | null {
  if (!ratio) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(ratio);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!(a > 0 && b > 0)) return null;
  return a / b;
}

export interface AspectTranslation {
  specs: ImageSpecs;
  /** Present when a translation happened. */
  translated?: {
    from: string;
    to: string;
    via: 'catalog-ratio' | 'catalog-size' | 'openai-table';
    /** False when the chosen size is only the closest shape available. */
    exact: boolean;
  };
  /** Present when the ratio could not be expressed at all. */
  dropped?: { from: string; reason: string };
}

/**
 * Rewrite `aspect_ratio` into `size` for the OpenAI wire. An explicit
 * `size` always wins (the ratio is dropped without a word — pixels are
 * more specific). Pure; the caller logs and warns.
 */
export function translateAspectForOpenAiWire(
  specs: ImageSpecs,
  caps: ModelCapabilities,
  path: 'json' | 'multipart' = 'json',
): AspectTranslation {
  const ratio = specs.aspect_ratio;
  if (!ratio) return { specs };
  // Upgrade-safety: a backend that positively declares `aspect_ratio`
  // and offers no named sizes keeps getting it on the JSON path, where
  // routers forward unknown keys — exactly what worked before. Only the
  // multipart edit path (where routers drop it) is always translated.
  if (path === 'json' && caps.supported?.includes('aspect_ratio') && !caps.sizeAlsoAccepts && !specs.size) {
    return { specs };
  }
  const { aspect_ratio: _drop, ...rest } = specs;
  if (rest.size) return { specs: rest };

  const wanted = ratioValue(ratio);
  if (caps.sizeAlsoAccepts?.some((r) => r === ratio)) {
    return { specs: { ...rest, size: ratio }, translated: { from: ratio, to: ratio, via: 'catalog-ratio', exact: true } };
  }
  if (wanted === null) {
    return { specs: rest, dropped: { from: ratio, reason: 'not an a:b ratio and the endpoint does not take named sizes' } };
  }
  const pick = (candidates: string[], via: 'catalog-size' | 'openai-table'): AspectTranslation | null => {
    let best: { size: string; err: number } | null = null;
    for (const s of candidates) {
      const d = parseSizeSpec(s);
      if (!d) continue;
      const err = Math.abs(d.width / d.height - wanted) / wanted;
      if (!best || err < best.err) best = { size: s, err };
    }
    if (!best) return null;
    return { specs: { ...rest, size: best.size }, translated: { from: ratio, to: best.size, via, exact: best.err < RATIO_TOLERANCE } };
  };
  const listed = caps.values.size;
  if (listed && listed.length > 0) {
    const r = pick(listed, 'catalog-size');
    if (r) return r;
  }
  const table = OPENAI_WIRE_SIZE_FOR_RATIO[ratio] ? [OPENAI_WIRE_SIZE_FOR_RATIO[ratio]!] : Object.values(OPENAI_WIRE_SIZE_FOR_RATIO);
  return pick(table, 'openai-table') ?? { specs: rest, dropped: { from: ratio, reason: 'no size candidates' } };
}

/**
 * The ratio the caller asked for, as a number — from `aspect_ratio`, or
 * from a `size` that is itself a named ratio. Null when only pixels (the
 * size check covers those) or nothing was requested.
 */
export function requestedRatio(requested: ImageSpecs): number | null {
  return ratioValue(requested.aspect_ratio) ?? (parseSizeSpec(requested.size) ? null : ratioValue(requested.size));
}

/** True when the returned image's shape is off by more than the tolerance. */
export function ratioMismatch(wanted: number, width: number, height: number): boolean {
  if (!(width > 0 && height > 0)) return false;
  return Math.abs(width / height - wanted) / wanted > RATIO_TOLERANCE;
}
