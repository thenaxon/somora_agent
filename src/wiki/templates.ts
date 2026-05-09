// Page-format definitions for the somora wiki.
//
// This module is the single source of truth for what a wiki page
// looks like (frontmatter fields, section names) and how to parse
// and (re-)build one.
//
// Used by Deep (memory→wiki consolidation) for promotion writes and
// merge-updates.
//
// As of v2.2 the stub-pattern is gone — memory files no longer get
// converted to pointer-stubs after Deep promotion; they are deleted.
// Wiki is the single source of truth for consolidated knowledge.
//
// See `private/dream-system-v2.md`.

import matter from 'gray-matter';
import { dump as yamlDump } from 'js-yaml';

// ─── Wiki-Page ───────────────────────────────────────────────────────

/** Allowed `type` values in wiki-page frontmatter. Non-exhaustive —
 *  Deep may introduce new types when it creates new subdirs.
 *  Validation: warn on unknown types, don't reject. */
export const KNOWN_WIKI_TYPES = ['person', 'projekt', 'konzept', 'ort', 'werkzeug'] as const;
export type KnownWikiType = (typeof KNOWN_WIKI_TYPES)[number];

export interface WikiPageFrontmatter {
  slug: string;
  /** Loose enum — see KNOWN_WIKI_TYPES. */
  type: string;
  /** ISO date (YYYY-MM-DD). When the page was first created. */
  created: string;
  /** ISO date (YYYY-MM-DD). Last update by Deep or user. */
  updated: string;
  /** Source pointers: `<agent>/<memory-slug>` strings. */
  sources?: string[];
  /** Cross-refs to other wiki pages (path without .md). */
  related?: string[];
  /** Free-form additional metadata Deep may want to track. */
  [extra: string]: unknown;
}

/** Section titles Deep prefers when generating new pages. User may
 *  introduce others; Deep respects existing structure. */
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
  // order and clean array rendering.
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

/** Build an initial wiki-page from minimum input. Helper for Deep's
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
