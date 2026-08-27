// Shared shapes for image generation. Kept separate from the modules
// that use them so store/records/capabilities don't have to import each
// other just to name a type.

/**
 * Generation specs as the wire protocol names them. Deliberately
 * snake_case — these travel to the upstream verbatim, and a camelCase
 * layer in between would mean two vocabularies for the same thing (the
 * tool's JSON schema, the UI's form fields and the request body all
 * speak this one).
 *
 * Every field is optional: an upstream applies its own defaults, and
 * `imageGen.models[].defaults` fills in what the operator cares about.
 */
export interface ImageSpecs {
  /** Tier: `512`, `1K`, `2K`, `4K`. Provider-normalized. */
  resolution?: string;
  /** `1:1`, `16:9`, `9:16`, `4:3`, … */
  aspect_ratio?: string;
  /** Shorthand for a tier or explicit pixels (`2048x2048`). */
  size?: string;
  /** `auto`, `low`, `medium`, `high`. */
  quality?: string;
  /** `png`, `jpeg`, `webp`, `svg`. */
  output_format?: string;
  /** `auto`, `transparent`, `opaque`. */
  background?: string;
  /** 0-100, webp/jpeg only. */
  output_compression?: number;
  /** Deterministic generation, where the model supports it. */
  seed?: number;
  /** How many images to generate (1-10, provider-dependent). */
  n?: number;
}

/** Spec field names that carry a closed set of allowed values. */
export const ENUMERABLE_SPEC_FIELDS = [
  'resolution',
  'aspect_ratio',
  // Endpoints that size images in explicit pixels have a closed set of
  // them ("1024x1024" | "1792x1024" | "1024x1792") and no resolution
  // tier at all, so this belongs with the other enumerable fields.
  'size',
  'quality',
  'output_format',
  'background',
] as const;
export type EnumerableSpecField = (typeof ENUMERABLE_SPEC_FIELDS)[number];

/**
 * What a given model actually accepts. Fields left undefined mean "we
 * don't know" — which is treated as permissive, NOT as empty. A missing
 * catalog must not turn into a tool that refuses everything.
 */
export interface ModelCapabilities {
  /** True when the model was found in the provider's catalog. */
  known: boolean;
  /** Where this knowledge came from — surfaced in error messages so a
   *  confusing rejection can be traced to its source. */
  source: 'catalog' | 'config' | 'unknown';
  values: Partial<Record<EnumerableSpecField, string[]>>;
  /**
   * The complete set of parameter names this model accepts, when the
   * catalog publishes one. Distinct from `values`, which only covers
   * fields with an enumerable set: grok-imagine accepts `n` without
   * `n` having a value list, and does NOT accept `seed` at all.
   *
   * Present ⇒ authoritative: a field missing from this list is
   * unsupported, and offering it in a form or silently forwarding it
   * would be a lie. Absent ⇒ we simply don't know, and everything is
   * allowed through. Keeping those two cases apart is the whole point
   * of this field.
   */
  supported?: string[];
  maxN?: number;
  maxReferences?: number;
}

/** Does this model accept `field`? Unknown counts as yes — see the note
 *  on `supported`. */
export function supportsField(caps: ModelCapabilities, field: string): boolean {
  return caps.supported ? caps.supported.includes(field) : true;
}

/** One generated image, as persisted and as handed back to callers. */
export interface ImageRecord {
  id: string;
  /** ISO-8601, local-time offset preserved. */
  createdAt: string;
  prompt: string;
  /** Config handle (`grok-imagine`). */
  modelName: string;
  /** Wire id (`x-ai/grok-imagine-image-2.0`). */
  modelId: string;
  /** providers.<name> the request went through. */
  provider: string;
  specs: ImageSpecs;
  /** Absolute path in the canonical images dir. */
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  /** Additional locations the caller asked for, as hardlinks (or
   *  copies, across filesystems). */
  linkedTo: string[];
  /** Upstream-reported cost in USD, when available. */
  costUsd?: number;
  /** Who triggered it — agent name, or undefined for a web-UI request. */
  agent?: string;
  session?: string;
  /** Number of reference images passed in, for image-to-image runs. */
  references?: number;
  /** Groups the images of one `n > 1` call. */
  batchId: string;
  batchIndex: number;
}
