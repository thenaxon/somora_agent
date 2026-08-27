// What a given image model actually accepts.
//
// Allowed spec values are NOT a property of somora — they belong to the
// model. grok-imagine renders 1K and 2K; another model does 512 and 4K;
// next month there's one that does neither. Hardcoding the lists would
// mean a somora release per model, so the truth is fetched from the
// provider's image-model catalog at runtime.
//
// Three sources, in precedence order:
//   1. `imageGen.models[].allow` — operator override, always wins.
//      For providers without a catalog (a local image server) or one
//      that's wrong.
//   2. The provider catalog, cached per process.
//   3. Nothing — and then everything is allowed. A tool that refuses
//      valid input because it couldn't reach a catalog is worse than
//      one that forwards the request and relays the upstream's own
//      complaint.
//
// The catalog payload is provider-specific and not standardized. We
// read the shapes we can identify with confidence and ignore the rest;
// an unrecognized payload degrades to source 3 rather than to an empty
// allow-list. The full entry is logged once at debug level so a real
// payload can be inspected and this parser tightened against it.

import type { ImageModel, OpenAiCompatibleProvider } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import {
  ENUMERABLE_SPEC_FIELDS,
  type EnumerableSpecField,
  type ImageSpecs,
  type ModelCapabilities,
  supportsField,
} from './types.ts';

/** Catalog responses are cached for the process lifetime, keyed by
 *  provider+endpoint. Restart to re-read — same posture as the rest of
 *  config.yaml, and a model's parameter list does not change hourly. */
const catalogCache = new Map<string, Promise<CatalogEntry[] | null>>();

interface CatalogEntry {
  id: string;
  raw: Record<string, unknown>;
}

/**
 * The shape OpenRouter's image-model catalog actually uses, verified
 * against `GET /api/v1/images/models` on 2026-08-26:
 *
 *   supported_parameters: {
 *     resolution:       { type: 'enum',  values: ['1K', '2K'] },
 *     aspect_ratio:     { type: 'enum',  values: ['1:1', '16:9', …] },
 *     n:                { type: 'range', min: 1, max: 1 },
 *     input_references: { type: 'range', min: 0, max: 3 },
 *   }
 *
 * Read first, because it's the one shape we've seen from a real
 * provider. The looser key-guessing below stays as a fallback for
 * catalogs that publish something else.
 */
interface ParamSpec {
  type?: string;
  values?: unknown;
  min?: unknown;
  max?: unknown;
}

function supportedParameters(raw: Record<string, unknown>): Record<string, ParamSpec> | null {
  const sp = raw.supported_parameters;
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return null;
  return sp as Record<string, ParamSpec>;
}

function enumValues(params: Record<string, ParamSpec> | null, field: string): string[] | undefined {
  const spec = params?.[field];
  if (!spec || spec.type !== 'enum') return undefined;
  return asStringArray(spec.values);
}

function rangeMax(params: Record<string, ParamSpec> | null, field: string): number | undefined {
  const spec = params?.[field];
  if (!spec || spec.type !== 'range') return undefined;
  const max = spec.max;
  return typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : undefined;
}

/** Field names a catalog might use for each spec, most specific first.
 *  Fallback for providers that don't publish `supported_parameters`. */
const CATALOG_KEYS: Record<EnumerableSpecField, string[]> = {
  resolution: ['resolutions', 'supported_resolutions', 'resolution'],
  aspect_ratio: ['aspect_ratios', 'supported_aspect_ratios', 'aspect_ratio'],
  quality: ['qualities', 'supported_qualities', 'quality'],
  output_format: ['output_formats', 'supported_output_formats', 'output_format'],
  background: ['backgrounds', 'supported_backgrounds', 'background'],
};

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Pull a spec's allowed values out of a catalog entry, looking at the
 *  top level and one nesting level down (catalogs commonly group these
 *  under `parameters` / `capabilities` / `image`). */
function readValues(raw: Record<string, unknown>, field: EnumerableSpecField): string[] | undefined {
  const containers: Record<string, unknown>[] = [raw];
  for (const key of ['parameters', 'capabilities', 'image', 'image_generation']) {
    const nested = raw[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      containers.push(nested as Record<string, unknown>);
    }
  }
  for (const container of containers) {
    for (const key of CATALOG_KEYS[field]) {
      const hit = asStringArray(container[key]);
      if (hit) return hit;
    }
  }
  return undefined;
}

function readNumber(raw: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return undefined;
}

async function fetchCatalog(
  provider: OpenAiCompatibleProvider,
  endpoint: string,
  timeoutMs: number,
): Promise<CatalogEntry[] | null> {
  const url = provider.baseUrl.replace(/\/+$/, '') + endpoint;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.debug({ msg: 'imagegen.catalog_http_error', url, status: res.status });
      return null;
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body)
      ? body
      : ((body as { data?: unknown[] })?.data ?? (body as { models?: unknown[] })?.models);
    if (!Array.isArray(rows)) {
      logger.debug({ msg: 'imagegen.catalog_unexpected_shape', url });
      return null;
    }
    const entries: CatalogEntry[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const raw = row as Record<string, unknown>;
      const id = typeof raw.id === 'string' ? raw.id : typeof raw.slug === 'string' ? raw.slug : '';
      if (id) entries.push({ id, raw });
    }
    logger.info({ msg: 'imagegen.catalog_loaded', url, models: entries.length });
    return entries;
  } catch (err) {
    logger.debug({ msg: 'imagegen.catalog_unreachable', url, err: (err as Error).message });
    return null;
  }
}

/** Catalog rows for one provider endpoint, cached. */
export async function loadCatalog(
  providerName: string,
  provider: OpenAiCompatibleProvider,
  endpoint: string | null,
  timeoutMs = 15_000,
): Promise<CatalogEntry[] | null> {
  if (!endpoint) return null;
  const key = `${providerName}${endpoint}`;
  let pending = catalogCache.get(key);
  if (!pending) {
    pending = fetchCatalog(provider, endpoint, timeoutMs);
    catalogCache.set(key, pending);
  }
  return pending;
}

/** Test seam — the cache is process-wide and would leak between cases. */
export function clearCatalogCache(): void {
  catalogCache.clear();
}

/** Every image model the provider offers, for the UI's "what can I
 *  configure?" list. Empty array when no catalog is reachable. */
export async function listCatalogModels(
  providerName: string,
  provider: OpenAiCompatibleProvider,
  endpoint: string | null,
): Promise<Array<{ id: string; name?: string }>> {
  const entries = await loadCatalog(providerName, provider, endpoint);
  if (!entries) return [];
  return entries.map((e) => ({
    id: e.id,
    name: typeof e.raw.name === 'string' ? e.raw.name : undefined,
  }));
}

export async function resolveCapabilities(
  providerName: string,
  provider: OpenAiCompatibleProvider,
  entry: ImageModel,
): Promise<ModelCapabilities> {
  // 1. Operator override wins outright.
  if (entry.allow) {
    const values: Partial<Record<EnumerableSpecField, string[]>> = {};
    for (const field of ENUMERABLE_SPEC_FIELDS) {
      const configured = entry.allow[field as keyof typeof entry.allow];
      if (Array.isArray(configured)) values[field] = configured as string[];
    }
    return {
      known: true,
      source: 'config',
      values,
      maxN: entry.allow.maxN,
      maxReferences: entry.allow.maxReferences,
    };
  }

  // 2. Provider catalog.
  const entries = await loadCatalog(providerName, provider, entry.capabilitiesEndpoint);
  const row = entries?.find((e) => e.id === entry.model);
  if (!row) {
    if (entries) {
      // Catalog answered but doesn't list this model. Not fatal — a
      // brand-new model can be callable before it's indexed, and
      // refusing here would be somora overruling the provider.
      logger.warn({
        msg: 'imagegen.model_not_in_catalog',
        model: entry.model,
        provider: providerName,
      });
    }
    return { known: false, source: 'unknown', values: {} };
  }

  logger.debug({ msg: 'imagegen.catalog_entry', model: entry.model, raw: row.raw });

  const params = supportedParameters(row.raw);
  const values: Partial<Record<EnumerableSpecField, string[]>> = {};
  for (const field of ENUMERABLE_SPEC_FIELDS) {
    const hit = enumValues(params, field) ?? readValues(row.raw, field);
    if (hit) values[field] = hit;
  }
  return {
    known: true,
    source: 'catalog',
    values,
    // Only when the catalog published a parameter list. A catalog entry
    // without one tells us the model exists, not what it takes.
    ...(params ? { supported: Object.keys(params) } : {}),
    maxN: rangeMax(params, 'n') ?? readNumber(row.raw, ['max_images', 'maxN', 'max_n']),
    maxReferences:
      rangeMax(params, 'input_references') ??
      readNumber(row.raw, ['max_input_references', 'max_references']),
  };
}

/**
 * Validate specs against what the model accepts.
 *
 * Rejections name the valid values, because the caller is often a
 * language model: "resolution '4K' is not supported by this model —
 * allowed: 1K, 2K" gets corrected on the next attempt, whereas
 * "invalid resolution" gets retried verbatim three times.
 *
 * Unknown constraints are not constraints. Only a field we positively
 * know the allowed values for can fail here.
 */
export function validateSpecs(
  specs: ImageSpecs,
  caps: ModelCapabilities,
  modelLabel: string,
): string[] {
  const errors: string[] = [];

  // A field the model doesn't take at all. Forwarding it would look
  // like it worked — the provider ignores the parameter and returns an
  // image that quietly disregards what was asked for, which is how you
  // end up wondering why "transparent background" did nothing.
  for (const [field, value] of Object.entries(specs)) {
    if (value === undefined) continue;
    if (!supportsField(caps, field)) {
      errors.push(
        `${modelLabel} does not accept '${field}'` +
          (caps.supported ? ` — it takes: ${caps.supported.join(', ')}` : ''),
      );
    }
  }

  for (const field of ENUMERABLE_SPEC_FIELDS) {
    const value = specs[field];
    const allowed = caps.values[field];
    if (value === undefined || !allowed || allowed.length === 0) continue;
    // Tier names are case-insensitive in practice ("2k" vs "2K").
    const ok = allowed.some((a) => a.toLowerCase() === String(value).toLowerCase());
    if (!ok) {
      errors.push(
        `${field} '${value}' is not supported by ${modelLabel} — allowed: ${allowed.join(', ')}`,
      );
    }
  }

  if (specs.n !== undefined) {
    if (!Number.isInteger(specs.n) || specs.n < 1) {
      errors.push(`n must be a positive integer, got '${specs.n}'`);
    } else if (caps.maxN !== undefined && specs.n > caps.maxN) {
      errors.push(`n '${specs.n}' exceeds what ${modelLabel} allows (max ${caps.maxN})`);
    }
  }

  if (specs.output_compression !== undefined) {
    const c = specs.output_compression;
    if (!Number.isInteger(c) || c < 0 || c > 100) {
      errors.push(`output_compression must be an integer 0-100, got '${c}'`);
    }
  }

  return errors;
}

/** Merge configured defaults under caller-supplied specs. Caller wins
 *  field by field, so a default aspect ratio survives a call that only
 *  overrides the resolution. */
export function applyDefaults(
  specs: ImageSpecs,
  entry: ImageModel,
  caps?: ModelCapabilities,
): ImageSpecs {
  const merged: ImageSpecs = { ...specs };
  for (const [key, value] of Object.entries(entry.defaults)) {
    if (value === undefined) continue;
    // Silently skipped rather than applied-and-rejected: defaults are
    // operator convenience, not intent for this particular call. One
    // shared default block across several models shouldn't make every
    // request to the odd one out fail.
    if (caps && !supportsField(caps, key)) continue;
    if (merged[key as keyof ImageSpecs] === undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
