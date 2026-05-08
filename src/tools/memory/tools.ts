// Memory tool definitions (DECISION #31). Six granular tools:
//   memory_search   — hybrid retrieval across ALL sources (own memory + vault)
//   memory_get      — fetch full content by `source/slug` reference
//   memory_list     — overview of own memory notes (no vault)
//   memory_write    — create or overwrite a note in own memory
//   memory_edit     — modify an existing own-memory note (fail if missing)
//   memory_delete   — remove a note from own memory
//
// All write tools refuse to operate on vault paths by construction: the
// slug regex rejects any string with `/`, `--`, uppercase letters, etc.
// See SLUG_RE in src/memory/manager.ts.

import { z } from 'zod';
import type { ToolDefinition } from '../types.ts';

// ── Shared helpers ────────────────────────────────────────────────────

/** Slug schema for own-memory writes — same regex as MemoryManager.SLUG_RE. */
const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'slug must be lowercase, start with letter/digit, only [a-z0-9_-] allowed');

/** Reference for memory_get — `memory/<slug>`, `wiki/<path>`, or
 *  `vault/<path>`. The wiki source was added in Phase 4 (DECISIONS
 *  #41/#42 + private/wiki-design.md): a designated subfolder of the
 *  Obsidian vault that Dream-B writes to and all agents share. */
const ReferenceSchema = z
  .string()
  .min(3)
  .regex(/^(memory|wiki|vault)\/.+$/, 'reference must start with "memory/", "wiki/", or "vault/"');

const SourceFilterSchema = z
  .enum(['memory', 'wiki', 'vault', 'all'])
  .optional();

const FrontmatterSchema = z
  .object({
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
  .optional();

// ── memory_search ─────────────────────────────────────────────────────

const SearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).optional(),
  minScore: z.number().min(0).max(1).optional(),
  source: SourceFilterSchema,
});

export const memorySearch: ToolDefinition<z.infer<typeof SearchInput>> = {
  name: 'memory_search',
  toolset: 'memory',
  description:
    'Search across all your knowledge sources: your own short-term memory, the shared long-term ' +
    'wiki, and read-only vault content. Returns top-N hits with `reference`, `score`, and a snippet. ' +
    'Hits are tagged by source: `memory/<slug>` for your own notes, `wiki/<path>` for the shared ' +
    'consolidated wiki, `vault/<path>` for read-only vault files. ' +
    'Pass the `reference` value directly to `memory_get` to read the full content. ' +
    'Use the optional `source` parameter to constrain the search to one layer when you know exactly ' +
    'where to look (e.g. `source: "wiki"` for authoritative consolidated facts). ' +
    'Default: searches all sources. Use this when the pre-injected <memory-context> block is ' +
    'insufficient or you need to look up something specific.',
  inputSchema: SearchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to search for — keyword, question, or synonym. Embedding-based recall also finds non-literal matches.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of hits to return (default 5).',
      },
      minScore: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Discard hits below this score (0..1, default 0.5).',
      },
      source: {
        type: 'string',
        enum: ['memory', 'wiki', 'vault', 'all'],
        description:
          'Restrict search to a single layer. ' +
          '"memory" = your own short-term notes; ' +
          '"wiki" = shared consolidated long-term knowledge; ' +
          '"vault" = read-only Obsidian content outside the wiki. ' +
          'Default "all" = mix all three (ranked by source-boost).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const sources =
      !input.source || input.source === 'all' ? 'all' : [input.source];
    // Agent-driven search defaults to a 0 floor so the agent sees the
    // best top-N matches and can filter itself. Auto-injection still
    // uses the higher autoInject.minScore — that's a different use case
    // (ambient context where quality > recall).
    const hits = await mgr.search(input.query, {
      limit: input.limit,
      minScore: input.minScore ?? 0,
      sources,
    });
    return {
      query: input.query,
      count: hits.length,
      hits: hits.map((h) => ({
        reference: `${h.source}/${h.slug}`,
        source: h.source,
        slug: h.slug,
        score: Number(h.score.toFixed(4)),
        snippet: h.text.length > 400 ? h.text.slice(0, 400).trimEnd() + '…' : h.text,
        startLine: h.startLine,
        endLine: h.endLine,
        path: h.filePath,
      })),
    };
  },
};

// ── memory_get ────────────────────────────────────────────────────────

const GetInput = z.object({
  reference: ReferenceSchema,
});

export const memoryGet: ToolDefinition<z.infer<typeof GetInput>> = {
  name: 'memory_get',
  toolset: 'memory',
  description:
    'Fetch the full content of a note, wiki page, or vault file by its `reference` from a recall ' +
    'hit (or from the <memory-context> block). ' +
    'Format: `memory/<slug>` for your own short-term memory, `wiki/<path>` for the shared ' +
    'long-term wiki, `vault/<path>` for read-only vault files. ' +
    'Returns the full markdown content, parsed frontmatter, and file path.',
  inputSchema: GetInput,
  jsonSchema: {
    type: 'object',
    properties: {
      reference: {
        type: 'string',
        pattern: '^(memory|wiki|vault)/.+$',
        description: 'Recall reference, exactly as it appeared in a memory_search hit or in the memory-context block.',
      },
    },
    required: ['reference'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const result = await mgr.getByReference(input.reference);
    if (!result) {
      throw new Error(`reference '${input.reference}' nicht gefunden im Index`);
    }
    return result;
  },
};

// ── memory_list ───────────────────────────────────────────────────────

const ListInput = z.object({
  tag: z.string().optional(),
  source: SourceFilterSchema,
  pathPrefix: z.string().min(1).optional(),
});

export const memoryList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'memory_list',
  toolset: 'memory',
  description:
    'List notes with slug, description, and tags. Default scope: your own short-term memory only. ' +
    'Pass `source: "wiki"` to browse the shared long-term wiki (e.g. with `pathPrefix: "personen/"` ' +
    'to list just the people). Pass `source: "all"` to list everything across memory + wiki + vault — ' +
    'rarely needed; vault can be very large.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      tag: {
        type: 'string',
        description: 'Optional: only return notes whose frontmatter contains this tag.',
      },
      source: {
        type: 'string',
        enum: ['memory', 'wiki', 'vault', 'all'],
        description:
          'Which source to list. "memory" = your own (default), "wiki" = shared consolidated, ' +
          '"vault" = read-only vault, "all" = union of all three.',
      },
      pathPrefix: {
        type: 'string',
        description:
          'Optional slug prefix filter. Useful for wiki subfolders, e.g. "personen/" or "projekte/".',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const sources =
      !input.source || input.source === 'memory'
        ? undefined
        : input.source === 'all'
        ? ('all' as const)
        : [input.source];
    const notes = await mgr.listNotes({
      ...(input.tag ? { tag: input.tag } : {}),
      ...(sources ? { sources } : {}),
      ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
    });
    return {
      count: notes.length,
      notes: notes.map((n) => ({
        slug: n.slug,
        source: n.source,
        reference: `${n.source}/${n.slug}`,
        description: n.description,
        tags: n.tags ?? [],
        updatedAt: new Date(n.updatedAt).toISOString(),
      })),
    };
  },
};

// ── memory_write ──────────────────────────────────────────────────────

const WriteInput = z.object({
  slug: SlugSchema,
  content: z.string(),
  frontmatter: FrontmatterSchema,
});

export const memoryWrite: ToolDefinition<z.infer<typeof WriteInput>> = {
  name: 'memory_write',
  toolset: 'memory',
  description:
    'Create or overwrite a note in YOUR OWN short-term memory. ' +
    'Slug must be lowercase and contain only [a-z0-9_-] — no paths, no slashes. ' +
    'Writes to `~/.somora/agents/<your-name>/memory/<slug>.md`. ' +
    'Cannot modify wiki or vault — those are written by Dream-B/C respectively (or by the user). ' +
    'On overwrite of a normal note, `created` is preserved; `updated` is always set to now. ' +
    'Stub-aware (Phase 4): if the slug is a stub (already promoted to the wiki, with frontmatter ' +
    '`promoted_to`), this call appends the new content as a dated bullet under `## Recent ' +
    'observations` instead of clobbering the stub. Dream-B will integrate those observations ' +
    'into the wiki page on its next run.',
  inputSchema: WriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'File identifier — e.g. "auto", "apartment", "work-notes". Lowercase, no extension.',
      },
      content: {
        type: 'string',
        description:
          'Markdown body (no YAML frontmatter — the tool manages that). ' +
          'For stubs: a one-line observation appended to `## Recent observations`.',
      },
      frontmatter: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short description (shown by memory_list).' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags for filtering.',
          },
        },
        additionalProperties: true,
        description: 'Optional. Any additional fields are persisted as-is. Ignored for stubs.',
      },
    },
    required: ['slug', 'content'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const result = await mgr.writeNote(input.slug, input.content, input.frontmatter);
    return {
      slug: input.slug,
      reference: `memory/${input.slug}`,
      path: result.path,
      created: result.created,
      mode: result.mode,
    };
  },
};

// ── memory_edit ───────────────────────────────────────────────────────

const EditInput = z.object({
  slug: SlugSchema,
  content: z.string(),
  frontmatter: FrontmatterSchema,
});

export const memoryEdit: ToolDefinition<z.infer<typeof EditInput>> = {
  name: 'memory_edit',
  toolset: 'memory',
  description:
    'Replace the content of an EXISTING memory note. Same shape as `memory_write`, ' +
    'but fails if the note does not exist (prevents accidental creation from a typo in the slug). ' +
    'To create a new note, use `memory_write` instead.',
  inputSchema: EditInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'Slug of the existing note to edit.',
      },
      content: {
        type: 'string',
        description: 'New full markdown body. Frontmatter is managed by the tool.',
      },
      frontmatter: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: true,
      },
    },
    required: ['slug', 'content'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const result = await mgr.writeNote(input.slug, input.content, input.frontmatter, {
      mustExist: true,
    });
    return {
      slug: input.slug,
      reference: `memory/${input.slug}`,
      path: result.path,
    };
  },
};

// ── memory_delete ─────────────────────────────────────────────────────

const DeleteInput = z.object({
  slug: SlugSchema,
});

export const memoryDelete: ToolDefinition<z.infer<typeof DeleteInput>> = {
  name: 'memory_delete',
  toolset: 'memory',
  description:
    'Delete one of your own memory notes. Cannot delete vault files via this tool. ' +
    'Idempotent: returns deleted=false if the note does not (or no longer) exist.',
  inputSchema: DeleteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'Slug of the note to delete.',
      },
    },
    required: ['slug'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const deleted = await mgr.deleteNote(input.slug);
    return {
      slug: input.slug,
      reference: `memory/${input.slug}`,
      deleted,
    };
  },
};

// ── Bundle ────────────────────────────────────────────────────────────

export function memoryTools(): ToolDefinition[] {
  // Cast widens each tool's narrow Zod-inferred input type to the registry's
  // erased ToolDefinition<unknown>. The registry validates via the embedded
  // Zod schema before invoking the handler, so type-safety isn't lost at
  // runtime — we just need TypeScript to stop complaining about the bundle.
  return [memorySearch, memoryGet, memoryList, memoryWrite, memoryEdit, memoryDelete] as ToolDefinition[];
}
