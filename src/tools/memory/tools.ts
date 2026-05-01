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

/** Reference for memory_get — must be `memory/<slug>` or `vault/<slug>`. */
const ReferenceSchema = z
  .string()
  .min(3)
  .regex(/^(memory|vault)\/.+$/, 'reference must start with "memory/" or "vault/"');

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
});

export const memorySearch: ToolDefinition<z.infer<typeof SearchInput>> = {
  name: 'memory_search',
  description:
    'Search across all your knowledge sources: your own memory notes plus any attached vault. ' +
    'Returns top-N hits with `reference`, `score`, and a snippet. Hits are tagged by source: ' +
    '`memory/<slug>` for your own notes, `vault/<slug>` for vault files. ' +
    'Pass the `reference` value directly to `memory_get` to read the full content. ' +
    'Use this when the pre-injected <memory-context> block is insufficient or you need to ' +
    'look up something specific that was not surfaced automatically.',
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
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const hits = await mgr.search(input.query, {
      limit: input.limit,
      minScore: input.minScore,
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
  description:
    'Fetch the full content of a note or vault file by its `reference` from a recall hit ' +
    '(or from the <memory-context> block). ' +
    'Format: `memory/<slug>` for your own memory, `vault/<slug>` for vault files. ' +
    'Returns the full markdown content, parsed frontmatter, and file path.',
  inputSchema: GetInput,
  jsonSchema: {
    type: 'object',
    properties: {
      reference: {
        type: 'string',
        pattern: '^(memory|vault)/.+$',
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
});

export const memoryList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'memory_list',
  description:
    'List your own memory notes with slug, description, and tags. Optionally filter by tag. ' +
    'Does NOT list vault files — the user knows their own vault, and it may be large. ' +
    'For vault content, use `memory_search` with a specific query.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      tag: {
        type: 'string',
        description: 'Optional: only return notes whose frontmatter contains this tag.',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mgr = await ctx.getMemoryManager();
    const notes = await mgr.listNotes(input.tag ? { tag: input.tag } : undefined);
    return {
      count: notes.length,
      notes: notes.map((n) => ({
        slug: n.slug,
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
  description:
    'Create or overwrite a note in YOUR OWN memory. ' +
    'Slug must be lowercase and contain only [a-z0-9_-] — no paths, no slashes. ' +
    'Writes to `~/.somora/agents/<your-name>/memory/<slug>.md`. ' +
    'Cannot modify vault files — vaults are read-only via this tool. ' +
    'On overwrite, `created` is preserved; `updated` is always set to now.',
  inputSchema: WriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'File identifier — e.g. "auto", "apartment", "work-naxon". Lowercase, no extension.',
      },
      content: {
        type: 'string',
        description: 'Markdown body (no YAML frontmatter — the tool manages that).',
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
        description: 'Optional. Any additional fields are persisted as-is.',
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
