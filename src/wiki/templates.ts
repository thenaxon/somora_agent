// Page-format definitions for the somora wiki + memory stub.
//
// This module is the single source of truth for:
//   - what a wiki page looks like (frontmatter fields, section names)
//   - what a memory stub looks like after Dream-B promotion
//   - how to parse and (re-)build either
//
// Used by Dream-B (Stage 3) for promotion writes and merge-updates,
// by memory_write (Stage 2) for stub-aware append, and by Dream-C
// (Stage 5) for lint inspections.
//
// See `private/wiki-design.md` § "Vault-Struktur" and
// § "Memory-Struktur (Short-term)".

import matter from 'gray-matter';
import { dump as yamlDump } from 'js-yaml';

// ─── Wiki-Page ───────────────────────────────────────────────────────

/** Allowed `type` values in wiki-page frontmatter. Non-exhaustive —
 *  Dream-B may introduce new types when it creates new subdirs.
 *  Validation: warn on unknown types, don't reject. */
export const KNOWN_WIKI_TYPES = ['person', 'projekt', 'konzept', 'ort', 'werkzeug'] as const;
export type KnownWikiType = (typeof KNOWN_WIKI_TYPES)[number];

export interface WikiPageFrontmatter {
  slug: string;
  /** Loose enum — see KNOWN_WIKI_TYPES. */
  type: string;
  /** ISO date (YYYY-MM-DD). When the page was first created. */
  created: string;
  /** ISO date (YYYY-MM-DD). Last update by Dream-B or user. */
  updated: string;
  /** Source pointers: `<agent>/<memory-slug>` strings. */
  sources?: string[];
  /** Cross-refs to other wiki pages (path without .md). */
  related?: string[];
  /** Free-form additional metadata Dream-B may want to track. */
  [extra: string]: unknown;
}

/** Section titles Dream-B prefers when generating new pages. User may
 *  introduce others; Dream-B respects existing structure. */
export const WIKI_SECTION_TITLES = {
  currentState: 'Aktueller Stand',
  properties: 'Eigenschaften',
  timeline: 'Zeitleiste',
  notes: 'Notizen',
} as const;

export interface WikiPage {
  frontmatter: WikiPageFrontmatter;
  /** Page body (everything after frontmatter), with `# Title` heading
   *  and `## Sektionen` preserved verbatim. */
  body: string;
}

export function parseWikiPage(raw: string): WikiPage {
  const parsed = matter(raw);
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  return {
    frontmatter: {
      slug: typeof data.slug === 'string' ? data.slug : '',
      type: typeof data.type === 'string' ? data.type : '',
      created: typeof data.created === 'string' ? data.created : '',
      updated: typeof data.updated === 'string' ? data.updated : '',
      ...(Array.isArray(data.sources) ? { sources: data.sources as string[] } : {}),
      ...(Array.isArray(data.related) ? { related: data.related as string[] } : {}),
      ...stripStandardFields(data),
    },
    body: parsed.content,
  };
}

export function buildWikiPage(page: WikiPage): string {
  // Use yaml-dump (not gray-matter's stringify) for deterministic field
  // order and clean array rendering. gray-matter's stringify uses JS
  // YAML.dump which is fine but adds odd quoting. Manual is predictable.
  const fm = page.frontmatter;
  const ordered: Record<string, unknown> = {
    slug: fm.slug,
    type: fm.type,
    created: fm.created,
    updated: fm.updated,
  };
  if (fm.sources?.length) ordered.sources = fm.sources;
  if (fm.related?.length) ordered.related = fm.related;
  for (const [k, v] of Object.entries(fm)) {
    if (['slug', 'type', 'created', 'updated', 'sources', 'related'].includes(k)) continue;
    ordered[k] = v;
  }
  const yaml = yamlDump(ordered, { lineWidth: 100, noRefs: true }).trimEnd();
  const body = page.body.startsWith('\n') ? page.body : '\n' + page.body;
  return `---\n${yaml}\n---\n${body}`;
}

/** Build an initial wiki-page from minimum input. Helper for Dream-B's
 *  first-promotion path. */
export function buildInitialWikiPage(args: {
  slug: string;
  type: string;
  title: string;
  body: string;
  sources?: string[];
  related?: string[];
}): string {
  const today = isoDate();
  return buildWikiPage({
    frontmatter: {
      slug: args.slug,
      type: args.type,
      created: today,
      updated: today,
      ...(args.sources?.length ? { sources: args.sources } : {}),
      ...(args.related?.length ? { related: args.related } : {}),
    },
    body: `# ${args.title}\n\n${args.body.trimStart()}\n`,
  });
}

// ─── Memory-Stub ─────────────────────────────────────────────────────

/** Section header inside a memory-stub where new agent observations
 *  are appended between Dream-B runs. Dream-B reads + clears it on each
 *  consolidation. */
export const STUB_OBSERVATIONS_HEADER = '## Recent observations (will be promoted next dream-B)';

export interface StubFrontmatter {
  slug: string;
  /** Wiki path (without .md) the original memory was promoted to. */
  promoted_to: string;
  /** ISO timestamp of the last promotion. */
  promoted_at: string;
}

export interface MemoryStub {
  frontmatter: StubFrontmatter;
  /** Stub body — pointer line plus the `## Recent observations`
   *  section. Bullet entries below the header are the unsync'd
   *  observations Dream-B picks up next run. */
  body: string;
}

/** True iff the parsed file is a memory-stub (has both promoted_to and
 *  promoted_at fields). Returns false for normal memory files. */
export function isStub(raw: string): boolean {
  const data = matter(raw).data as Record<string, unknown> | undefined;
  if (!data) return false;
  return typeof data.promoted_to === 'string' && typeof data.promoted_at === 'string';
}

export function parseStub(raw: string): MemoryStub | null {
  const parsed = matter(raw);
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  if (typeof data.promoted_to !== 'string' || typeof data.promoted_at !== 'string') {
    return null;
  }
  return {
    frontmatter: {
      slug: typeof data.slug === 'string' ? data.slug : '',
      promoted_to: data.promoted_to,
      promoted_at: data.promoted_at,
    },
    body: parsed.content,
  };
}

export function buildStub(args: {
  slug: string;
  wikiPath: string;
  promotedAt?: string;
}): string {
  const promotedAt = args.promotedAt ?? new Date().toISOString();
  const fm: StubFrontmatter = {
    slug: args.slug,
    promoted_to: args.wikiPath,
    promoted_at: promotedAt,
  };
  const yaml = yamlDump(fm, { lineWidth: 100, noRefs: true }).trimEnd();
  const body = `\n→ Konsolidiertes Wissen: [[${args.wikiPath}]]\n\n${STUB_OBSERVATIONS_HEADER}\n\n`;
  return `---\n${yaml}\n---\n${body}`;
}

/** Append a dated observation line to the `## Recent observations`
 *  section of a stub body. Idempotent on whitespace — caller may pass
 *  the raw stub-body (with header still present); the function inserts
 *  the bullet right after the header.
 *
 *  Returns the new body. If the stub-body lacks the observations
 *  header (malformed stub), the function appends a fresh header +
 *  bullet at the end.
 */
export function appendObservation(stubBody: string, observation: string): string {
  const today = isoDate();
  const bullet = `- ${today}: ${observation.trim()}`;
  const headerIdx = stubBody.indexOf(STUB_OBSERVATIONS_HEADER);
  if (headerIdx === -1) {
    // malformed — synthesize a complete observations block at end
    const sep = stubBody.endsWith('\n') ? '' : '\n';
    return `${stubBody}${sep}\n${STUB_OBSERVATIONS_HEADER}\n\n${bullet}\n`;
  }
  // Find next non-blank line after the header → insert bullet right
  // before existing bullets (newest-first).
  const afterHeader = headerIdx + STUB_OBSERVATIONS_HEADER.length;
  const before = stubBody.slice(0, afterHeader);
  const after = stubBody.slice(afterHeader);
  // afterHeader content typically begins with \n\n then bullets. Insert
  // our bullet on its own line right after the header's newlines.
  const m = after.match(/^\n+/);
  const padding = m ? m[0] : '\n\n';
  const rest = after.slice(padding.length);
  return `${before}${padding}${bullet}\n${rest}`;
}

/** Extract observation bullets from a stub body. Returns the raw lines
 *  (without leading `- ` markers stripped — keeps date prefix intact)
 *  for Dream-B to feed into its merge prompt. */
export function extractObservations(stubBody: string): string[] {
  const headerIdx = stubBody.indexOf(STUB_OBSERVATIONS_HEADER);
  if (headerIdx === -1) return [];
  const after = stubBody.slice(headerIdx + STUB_OBSERVATIONS_HEADER.length);
  const lines = after.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith('-')) break; // section ended
    out.push(t);
  }
  return out;
}

/** Reset the observations section to empty (called by Dream-B after
 *  successful promotion of the observations into the wiki). */
export function clearObservations(stubBody: string): string {
  const headerIdx = stubBody.indexOf(STUB_OBSERVATIONS_HEADER);
  if (headerIdx === -1) return stubBody;
  const before = stubBody.slice(0, headerIdx + STUB_OBSERVATIONS_HEADER.length);
  return `${before}\n\n`;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function isoDate(): string {
  // YYYY-MM-DD in UTC. Wiki dates are calendar-day granularity.
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function stripStandardFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (['slug', 'type', 'created', 'updated', 'sources', 'related'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}
