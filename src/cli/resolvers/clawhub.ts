// ClawHub skill resolver.
//
// ClawHub (https://clawhub.ai, repo openclaw/clawhub) is OpenClaw's public
// skill marketplace. It serves a stable, OpenAPI-documented HTTP API and
// explicitly invites third-party clients to consume it (see docs/http-api.md
// "Public catalog reuse" section).
//
// What this resolver does:
//   1. Match a URL like `https://clawhub.ai/<owner>/<slug>` (or `…/<slug>`)
//      and extract the slug.
//   2. Fetch the metadata via `GET /api/v1/skills/<slug>` to canonicalize the
//      slug (handles owner rename / merge / slug-alias).
//   3. Fetch the zipped skill bundle via `GET /api/v1/download?slug=<canon>`.
//   4. Extract SKILL.md (or skill.md) + any text sub-resources from the zip.
//   5. Translate `metadata.openclaw.*` frontmatter into `metadata.somora.*`
//      so somora's loader picks up the requires.bins / env_vars / when_to_use
//      runtime checks.
//   6. Return the rewritten SKILL.md content + the sub-resource buffers.
//
// Rate limits: ClawHub enforces 30 anonymous req/min on the download endpoint
// and 600 anonymous req/min on read endpoints. 429 responses include a
// Retry-After header — we surface it in the error so the caller knows how
// long to wait.
//
// Why a separate resolver module (not inline in skill.ts): if a second
// marketplace shows up, the call-site in cmdAdd stays unchanged — only the
// dispatch list grows. The cmdAdd flow (lint, atomic write, post-write
// verify) is identical for all sources.

import AdmZip from 'adm-zip';
import matter from 'gray-matter';

const CLAWHUB_HOSTS = new Set(['clawhub.ai', 'www.clawhub.ai']);
const CLAWHUB_API_BASE = 'https://clawhub.ai/api/v1';
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // matches ClawHub's server-side limit
const DOWNLOAD_TIMEOUT_MS = 60_000;
const META_TIMEOUT_MS = 15_000;

// Text-file extension allowlist mirrors ClawHub's `TEXT_FILE_EXTENSIONS`
// (packages/schema/src/textFiles.ts in their repo). We use it defensively
// even though the registry already enforces it server-side — a future ZIP
// from a less-trusted source should still get the same filter.
const ALLOWED_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.toml',
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts',
  '.sh', '.bash', '.zsh', '.fish',
  '.py', '.rb', '.go', '.rs',
  '.html', '.htm', '.css', '.svg',
  '.ps1', '.psm1', '.psd1',
  '.env.example', '.gitignore', '.clawhubignore', '.clawdhubignore',
]);

export interface ClawHubResolution {
  /** Rewritten SKILL.md text content (frontmatter translated to somora-shape). */
  skillMd: string;
  /** Sub-resources from the zip — relative paths under the skill folder. */
  extraFiles: Array<{ relPath: string; content: Buffer }>;
  /** Canonical slug as reported by ClawHub (may differ from URL slug after rename). */
  canonicalSlug: string;
  /** Resolved version (semver string) we just downloaded. */
  version: string;
  /** Human-readable source label for log messages. */
  sourceLabel: string;
}

/** Returns true if the URL points at ClawHub. The caller uses this to decide
 *  whether to route through this resolver instead of the plain HTTP path. */
export function isClawHubUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return CLAWHUB_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Parse slug + owner from a ClawHub web URL. Accepted shapes:
 *    /<slug>                      (slug shortcut)
 *    /<owner>/<slug>              (older canonical web URL)
 *    /<owner>/skills/<slug>       (current canonical web URL)
 *    /skills/<slug>               (owner-less skills path)
 *  The owner is a REQUIRED disambiguator on the API side whenever a slug
 *  is taken by multiple owners (409 AMBIGUOUS_SKILL_SLUG otherwise) —
 *  dropping it from the URL made `somora skill install
 *  https://clawhub.ai/steipete/skills/gog` fail on any contested slug
 *  (Lucy case study 2026-07-24). Returns null on unrecognized shapes. */
export function parseClawHubUrl(url: string): { slug: string; owner?: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter((p) => p.length > 0);
  const last = parts[parts.length - 1];
  if (!last) return null;
  // ClawHub slugs: lowercase, URL-safe (`^[a-z0-9][a-z0-9-]*$`).
  if (!/^[a-z0-9][a-z0-9-]*$/.test(last)) return null;
  let owner: string | undefined;
  if (parts.length === 2 && parts[0] !== 'skills') owner = parts[0];
  else if (parts.length === 3 && parts[1] === 'skills') owner = parts[0];
  else if (parts.length > 1 && !(parts.length === 2 && parts[0] === 'skills')) return null;
  if (owner !== undefined && !/^[a-z0-9][a-z0-9._-]*$/i.test(owner)) return null;
  return { slug: last, ...(owner ? { owner } : {}) };
}

/** Run a fetch with an explicit AbortController-based timeout. We don't reuse
 *  the openai-compat patient client because that one disables timeouts entirely
 *  — for ClawHub's small REST calls a 15-60s cap is much more appropriate. */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ac.signal,
      headers: {
        // Identify ourselves so ClawHub can attribute traffic. Doesn't replace
        // a real Bearer token but is useful for both sides.
        'User-Agent': 'somora-skill-cli (https://github.com/thenaxon/somora_agent)',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

interface ClawHubMetaResponse {
  skill?: {
    slug?: string;
    displayName?: string;
    summary?: string;
  };
  latestVersion?: {
    version?: string;
  };
  moderation?: {
    isMalwareBlocked?: boolean;
    verdict?: string;
  };
}

/** Shape of ClawHub's 409 AMBIGUOUS_SKILL_SLUG body (verified live
 *  2026-07-27): lists every owner holding the slug. */
interface ClawHubAmbiguousResponse {
  code?: string;
  matches?: Array<{ ownerHandle?: string; slug?: string; url?: string }>;
}

async function ambiguousSlugError(slug: string, res: Response): Promise<Error> {
  let candidates = '';
  try {
    const body = (await res.json()) as ClawHubAmbiguousResponse;
    if (Array.isArray(body.matches) && body.matches.length > 0) {
      candidates =
        ' Candidates:\n' +
        body.matches
          .map((m) => `  - ${m.url ?? `https://clawhub.ai/${m.ownerHandle}/skills/${m.slug ?? slug}`}`)
          .join('\n');
    }
  } catch {
    /* non-JSON body — generic message below is still actionable */
  }
  return new Error(
    `ClawHub: slug '${slug}' is taken by multiple owners (409). ` +
      `Re-run with the owner-qualified URL (https://clawhub.ai/<owner>/skills/${slug}).${candidates}`,
  );
}

async function fetchMeta(slug: string, owner?: string): Promise<ClawHubMetaResponse> {
  const ownerQs = owner ? `?owner=${encodeURIComponent(owner)}` : '';
  const url = `${CLAWHUB_API_BASE}/skills/${encodeURIComponent(slug)}${ownerQs}`;
  const res = await fetchWithTimeout(url, META_TIMEOUT_MS);
  if (res.status === 404) {
    throw new Error(`ClawHub: skill '${owner ? `${owner}/` : ''}${slug}' not found (404)`);
  }
  if (res.status === 409) {
    throw await ambiguousSlugError(slug, res);
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') ?? '?';
    throw new Error(
      `ClawHub: rate-limited on metadata fetch (429). Retry after ${retryAfter}s.`,
    );
  }
  if (!res.ok) {
    throw new Error(`ClawHub: GET /skills/${slug} returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ClawHubMetaResponse;
  if (body.moderation?.isMalwareBlocked) {
    throw new Error(
      `ClawHub: skill '${slug}' is currently malware-blocked by ClawHub's moderation system — refusing to install.`,
    );
  }
  return body;
}

async function fetchZip(slug: string, owner?: string): Promise<Buffer> {
  const ownerQs = owner ? `&owner=${encodeURIComponent(owner)}` : '';
  const url = `${CLAWHUB_API_BASE}/download?slug=${encodeURIComponent(slug)}${ownerQs}`;
  const res = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
  if (res.status === 410) {
    throw new Error(`ClawHub: requested skill version is soft-deleted (410).`);
  }
  if (res.status === 409) {
    throw await ambiguousSlugError(slug, res);
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') ?? '?';
    throw new Error(
      `ClawHub: rate-limited on download (429). Retry after ${retryAfter}s.`,
    );
  }
  if (!res.ok) {
    throw new Error(`ClawHub: download returned ${res.status} ${res.statusText}`);
  }
  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `ClawHub: download size ${contentLength} bytes exceeds limit ${MAX_DOWNLOAD_BYTES}.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `ClawHub: download size ${buf.byteLength} bytes exceeds limit ${MAX_DOWNLOAD_BYTES}.`,
    );
  }
  if (buf.byteLength < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    // ZIP local-file-header signature is 0x50 0x4B 0x03 0x04. If we got
    // something else, the registry returned non-zip content (HTML error
    // page, JSON wrapper). Surface honestly.
    throw new Error(
      `ClawHub: response did not look like a ZIP (first bytes ${buf.slice(0, 4).toString('hex')}).`,
    );
  }
  return buf;
}

/** Sanitize a ZIP entry path. Rejects absolute paths, parent-dir traversal,
 *  and any path that escapes the skill root. Returns the normalized relative
 *  path or null if the entry should be dropped silently. */
function safeRelPath(rawName: string): string | null {
  // Use forward slashes, drop leading slashes.
  let p = rawName.replace(/\\/g, '/').replace(/^\/+/, '');
  // Reject any parent-dir traversal.
  if (p.includes('..')) return null;
  // Skip directory entries (zip uses trailing slash for dirs).
  if (p.endsWith('/')) return null;
  // Skip empty + absolute-like paths.
  if (!p || p.startsWith('/')) return null;
  // ClawHub bundles often have a top-level folder named after the skill.
  // Strip exactly ONE leading folder if all entries share it — caller does
  // that pass; here we just normalize. (Caller handles the prefix strip.)
  return p;
}

/** Strip a common top-level folder if every entry shares it. ClawHub's
 *  download zip typically wraps the skill in `<slug>/...` — we want
 *  `SKILL.md` at the root of our extraction, not `<slug>/SKILL.md`. */
function commonPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0];
  if (first === undefined) return null;
  const slash = first.indexOf('/');
  if (slash <= 0) return null;
  const prefix = first.slice(0, slash + 1);
  for (const p of paths) {
    if (!p.startsWith(prefix)) return null;
  }
  return prefix;
}

interface ExtractedFiles {
  /** Path → buffer, paths normalized (no leading prefix). */
  byPath: Map<string, Buffer>;
}

function extractZip(buf: Buffer): ExtractedFiles {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  const tmp = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const rel = safeRelPath(e.entryName);
    if (!rel) continue;
    const ext = '.' + (rel.split('.').pop() ?? '').toLowerCase();
    // Allowlist filter is defensive — registry enforces it server-side.
    // Skip files outside the allowlist instead of erroring; the SKILL.md is
    // the only required entry and the linter will catch missing pieces.
    if (!ALLOWED_EXT.has(ext) && rel !== '.gitignore' && rel !== '.clawhubignore') continue;
    tmp.set(rel, e.getData());
  }
  // Strip the common top-level folder if every entry shares it.
  const prefix = commonPrefix([...tmp.keys()]);
  if (prefix) {
    const stripped = new Map<string, Buffer>();
    for (const [k, v] of tmp) {
      stripped.set(k.slice(prefix.length), v);
    }
    return { byPath: stripped };
  }
  return { byPath: tmp };
}

/** Find the SKILL.md (or skill.md) entry in the extracted zip. Per the
 *  ClawHub format spec it MUST exist at the skill folder root. */
function findSkillMd(files: ExtractedFiles): { path: string; buffer: Buffer } | null {
  for (const candidate of ['SKILL.md', 'skill.md']) {
    const buf = files.byPath.get(candidate);
    if (buf) return { path: candidate, buffer: buf };
  }
  return null;
}

/** Translate ClawHub-shape frontmatter into somora-shape so somora's loader
 *  recognizes requires.bins / env_vars / when_to_use checks at load time.
 *  The body itself is unchanged. ClawHub uses `metadata.openclaw.*`, somora
 *  uses `metadata.somora.*`; the field names are mostly identical except
 *  ClawHub's `requires.env` is somora's `requires.env_vars`. We keep the
 *  original `metadata.openclaw` block intact in addition to the translated
 *  somora block, so the file remains valid in both ecosystems. */
function translateFrontmatter(skillMdText: string, slug: string): string {
  const parsed = matter(skillMdText);
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const clawhub =
    (metadata.openclaw as Record<string, unknown> | undefined) ??
    (metadata.clawdbot as Record<string, unknown> | undefined) ??
    (metadata.clawdis as Record<string, unknown> | undefined);

  // Build a somora-shape block, preferring existing metadata.somora if the
  // skill already has one (rare — usually it has openclaw-only).
  const existingSomora = (metadata.somora as Record<string, unknown> | undefined) ?? {};
  const somoraOut: Record<string, unknown> = { ...existingSomora };

  if (clawhub) {
    const requires = (clawhub.requires as Record<string, unknown> | undefined) ?? {};
    const reqEnv = requires.env;
    const reqBins = requires.bins;
    const reqConfig = requires.config;
    const requiresOut: Record<string, unknown> = {};
    if (Array.isArray(reqBins) && reqBins.length > 0) requiresOut.bins = reqBins;
    if (Array.isArray(reqEnv) && reqEnv.length > 0) requiresOut.env_vars = reqEnv;
    if (Array.isArray(reqConfig) && reqConfig.length > 0) requiresOut.config = reqConfig;
    if (Object.keys(requiresOut).length > 0) {
      somoraOut.requires = { ...(somoraOut.requires as object | undefined), ...requiresOut };
    }
    // ClawHub has no direct when_to_use — keep any existing somora value.
  }

  const newData: Record<string, unknown> = {
    ...data,
    name: slug, // canonicalize: somora's loader requires name === parent dir
    metadata: {
      ...metadata,
      ...(Object.keys(somoraOut).length > 0 ? { somora: somoraOut } : {}),
    },
  };

  return matter.stringify(parsed.content, newData);
}

/** Main entry point. Given a ClawHub URL, return an installable resolution
 *  the caller can pass straight into its pre-flight lint + atomic write
 *  flow. The caller still chooses the destination slug — usually it should
 *  match `canonicalSlug` returned here, but a `--force` rename is allowed. */
export async function resolveClawHubUrl(url: string): Promise<ClawHubResolution> {
  const ref = parseClawHubUrl(url);
  if (!ref) {
    throw new Error(`Unrecognized ClawHub URL shape: ${url}`);
  }
  // Canonicalize via metadata fetch. Handles rename / merge / alias.
  // The owner from the URL rides along on BOTH calls — it's the only
  // disambiguator the API accepts when a slug is contested.
  const meta = await fetchMeta(ref.slug, ref.owner);
  const canonicalSlug = meta.skill?.slug ?? ref.slug;
  const version = meta.latestVersion?.version ?? 'unknown';
  // Download the zipped bundle.
  const zipBuf = await fetchZip(canonicalSlug, ref.owner);
  const extracted = extractZip(zipBuf);
  const skillEntry = findSkillMd(extracted);
  if (!skillEntry) {
    throw new Error(
      `ClawHub: downloaded zip for '${canonicalSlug}' does not contain SKILL.md at the root.`,
    );
  }
  const rewrittenSkillMd = translateFrontmatter(skillEntry.buffer.toString('utf8'), canonicalSlug);
  const extraFiles: Array<{ relPath: string; content: Buffer }> = [];
  for (const [path, buf] of extracted.byPath) {
    if (path === skillEntry.path) continue;
    extraFiles.push({ relPath: path, content: buf });
  }
  return {
    skillMd: rewrittenSkillMd,
    extraFiles,
    canonicalSlug,
    version,
    sourceLabel: `ClawHub: ${canonicalSlug}@${version} (${url})`,
  };
}
