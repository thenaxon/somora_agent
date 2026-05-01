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
    'Durchsuche dein gesamtes Wissen: dein eigenes Memory plus angebundene Vaults. ' +
    'Liefert Top-N Treffer mit `reference`, `score` und Snippet. Treffer sind nach Source ' +
    'getagged: `memory/<slug>` für eigene Notizen, `vault/<slug>` für Vault-Files. ' +
    'Die `reference` kannst du 1:1 in `memory_get` einsetzen, um den vollen Inhalt zu lesen. ' +
    'Nutze dieses Tool wenn der vor-injizierte <memory-context>-Block nicht ausreicht oder ' +
    'du gezielt etwas Bestimmtes nachschlagen willst.',
  inputSchema: SearchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Was du suchst — Schlagwort, Frage, Synonyme. Embeddings finden auch nicht-wörtliche Treffer.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximal so viele Treffer (default 5).',
      },
      minScore: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Treffer unter diesem Score verwerfen (default 0.5).',
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
    'Hol den vollen Inhalt einer Notiz oder eines Vault-Files anhand der `reference` aus einem ' +
    'Recall-Treffer (oder aus dem <memory-context>-Block). ' +
    'Format: `memory/<slug>` für eigenes Memory, `vault/<slug>` für Vault. Liefert ' +
    'Markdown-Inhalt, Frontmatter und Pfad.',
  inputSchema: GetInput,
  jsonSchema: {
    type: 'object',
    properties: {
      reference: {
        type: 'string',
        pattern: '^(memory|vault)/.+$',
        description: 'Recall-Referenz, exakt wie sie in memory_search-Treffern oder im memory-context-Block stand.',
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
    'Liste deiner eigenen Memory-Notizen mit Slug, Description und Tags. Optional nach Tag filtern. ' +
    'Listet NICHT Vault-Files (der User kennt seinen Vault selbst und der kann groß sein). ' +
    'Wenn du Vault-Inhalt brauchst, nutze `memory_search` mit konkreter Query.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      tag: {
        type: 'string',
        description: 'Optional: nur Notizen mit diesem Tag im Frontmatter zurückgeben.',
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
    'Erstelle oder überschreibe eine Notiz in DEINEM eigenen Memory. ' +
    'Slug muss lowercase sein und nur [a-z0-9_-] enthalten — keine Pfade, keine Slashes. ' +
    'Schreibt nach `~/.somora/agents/<dein-name>/memory/<slug>.md`. ' +
    'Vault-Files kannst du mit diesem Tool nicht ändern. ' +
    '`created` wird beim Überschreiben erhalten, `updated` wird automatisch gesetzt.',
  inputSchema: WriteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'Datei-Identifier — z.B. "auto", "wohnung", "arbeit-naxon". Lowercase, ohne Endung.',
      },
      content: {
        type: 'string',
        description: 'Markdown-Body (ohne YAML-Frontmatter — den verwaltet das Tool).',
      },
      frontmatter: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Kurzbeschreibung (für memory_list).' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags für Filterung.',
          },
        },
        additionalProperties: true,
        description: 'Optional. Beliebige weitere Felder werden mitgespeichert.',
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
    'Ersetze den Inhalt einer EXISTIERENDEN Memory-Notiz. Verhalten wie `memory_write`, ' +
    'aber bricht ab wenn die Notiz noch nicht existiert (verhindert versehentliches Anlegen ' +
    'durch Tippfehler im Slug). Wenn du eine neue Notiz anlegen willst: `memory_write`.',
  inputSchema: EditInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'Slug der bestehenden Notiz.',
      },
      content: {
        type: 'string',
        description: 'Neuer kompletter Markdown-Body. Frontmatter wird vom Tool verwaltet.',
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
    'Lösche eine eigene Memory-Notiz. Vault-Files kannst du mit diesem Tool nicht löschen. ' +
    'Ist idempotent: gibt deleted=false zurück wenn die Notiz nicht (mehr) existiert.',
  inputSchema: DeleteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9_-]*$',
        description: 'Slug der zu löschenden Notiz.',
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
