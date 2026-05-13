// Path-scheme inference for project pointer entries.
//
// Project files store paths as `{ref, label?}` — no `type` field. The
// type is inferred from the `ref` string itself at the moment we need
// it (validation at write-time, rendering at prompt-build-time). Three
// schemes are recognized:
//
//   url       → starts with a recognized URI scheme (https:// gdrive://
//               etc.). No further validation — URLs can point anywhere.
//   local     → starts with `/` or `~` (absolute or home-relative
//               local-filesystem path on the somora host). Existence is
//               NOT checked — paths may legitimately point at things
//               that don't exist yet.
//   resource  → matches `<word>:/path` where `<word>` is the slug of an
//               entry in `config.resources`. Cross-checked at write
//               time; unknown prefix → reject with helpful list.
//
// Anything else fails inference with a clear "doesn't look like url,
// absolute local, or resource:/" error.
//
// Why no stored `type` field: a single `add_path` tool argument shape
// (`ref` + optional `label`) covers all three schemes uniformly. Adding
// a new scheme is a parser change here, not a frontmatter migration.
// Tradeoff acknowledged: a literal file named `mac-studio.md` with no
// colon-slash never collides; a literal local path like
// `/home/foo/weird:/file` is a theoretical edge case we're willing to
// defer until it bites someone.

import type { Config } from '../config/types.ts';

export type PathType = 'url' | 'local' | 'resource';

/** Match any RFC-3986-style scheme followed by `://`. Covers https,
 *  http, ftp, gdrive, s3, file, gs, ssh, anything someone invents. */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Match `<word>:/path` where the prefix segment looks like a resource
 *  slug. The actual existence check against config.resources happens
 *  in `validatePathRef` — this regex just identifies candidates. */
const RESOURCE_PREFIX_RE = /^([a-z0-9_-]+):\/(.*)$/i;

export interface InferredPath {
  type: PathType;
  /** For `resource` paths: the resource slug (the `<word>` part). */
  resource?: string;
  /** For `resource` paths: the path component after `<word>:/`. */
  remotePath?: string;
}

/**
 * Infer the type of a `ref` without checking config. Returns null if
 * the ref doesn't match any known scheme. Used at RENDER time where
 * config is available but we don't want to re-validate (writes already
 * gated through `validatePathRef`).
 */
export function inferPathType(ref: string): InferredPath | null {
  if (URL_SCHEME_RE.test(ref)) {
    return { type: 'url' };
  }
  if (ref.startsWith('/') || ref.startsWith('~')) {
    return { type: 'local' };
  }
  const m = ref.match(RESOURCE_PREFIX_RE);
  if (m && m[1] && m[2] !== undefined) {
    return { type: 'resource', resource: m[1], remotePath: m[2] };
  }
  return null;
}

export interface ValidationResult {
  ok: true;
  inferred: InferredPath;
}
export interface ValidationError {
  ok: false;
  error: string;
}

/**
 * Validate a `ref` against the current config — used at WRITE time
 * (project_create paths[], project_update add_path). Verifies the
 * scheme is recognized AND for `resource:/...` refs that the resource
 * is actually configured. Returns a structured result so callers can
 * compose multi-op error messages without parsing strings.
 */
export function validatePathRef(ref: string, config: Config): ValidationResult | ValidationError {
  const inferred = inferPathType(ref);
  if (!inferred) {
    return {
      ok: false,
      error:
        `path '${ref}' doesn't look like a URL (https://...), absolute local path (/... or ~/...) or resource (<resource-slug>:/path)`,
    };
  }
  if (inferred.type === 'resource') {
    const slug = inferred.resource!;
    const known = Object.keys(config.resources ?? {});
    if (!known.includes(slug)) {
      const available = known.length > 0 ? known.join(', ') : '(no resources configured)';
      return {
        ok: false,
        error: `unknown resource '${slug}' in path '${ref}' — available: ${available}`,
      };
    }
  }
  return { ok: true, inferred };
}
