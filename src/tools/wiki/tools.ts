// wiki_* tools — write access to the shared wiki layer.
//
// IMPORTANT capability gate: these tools are ONLY exposed when the
// calling agent holds the active dream_review loop. Outside the loop
// the registry hides them entirely (see ToolDefinition.available).
// This keeps wiki authorship intentional: agents can only mutate the
// wiki while the user has explicitly opened a review session.
//
// Wiki writes go through the same mtime-aware helpers as Deep/Lucid
// (`src/wiki/conflict.ts`) so concurrent edits via Obsidian on disk
// don't get clobbered silently.

import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { isLoopHolder, refreshLoopActivity } from '../../dream/loop-state.ts';
import { resolveObsidianSource } from '../../memory/registry.ts';
import { logger } from '../../server/logger.ts';
import {
  readWithMtime,
  writeIfMtimeUnchanged,
  writeIfNotExists,
} from '../../wiki/conflict.ts';
import {
  buildInitialWikiPage,
  buildWikiPage,
  parseWikiPage,
} from '../../wiki/templates.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';

// ─── helpers ────────────────────────────────────────────────────────

function isoDate(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resolveWikiAbs(ctx: ToolContext): string {
  if (!ctx.config.wiki?.enabled) {
    throw new Error('wiki_*: config.wiki.enabled is false — wiki layer not active');
  }
  const vault = resolveObsidianSource(ctx.config.obsidian);
  if (!vault) {
    throw new Error('wiki_*: no obsidian vault configured');
  }
  const subfolder = ctx.config.wiki.vaultSubfolder;
  return join(vault.vaultPath, subfolder);
}

function validateWikiPath(p: string): string {
  // Wiki paths use posix slashes, no leading slash, no '..'. Slug
  // segments are lower-case kebab-case-ish; we reject anything with
  // shell metacharacters or path-traversal markers.
  if (!p || typeof p !== 'string') throw new Error('wiki_*: wikiPath required');
  const trimmed = p.trim().replace(/\.md$/, '');
  if (trimmed.startsWith('/') || trimmed.includes('..') || trimmed.includes('\\')) {
    throw new Error(`wiki_*: invalid wikiPath '${p}'`);
  }
  if (!/^[a-z0-9][a-z0-9_\-/]*$/i.test(trimmed)) {
    throw new Error(`wiki_*: wikiPath '${p}' contains disallowed characters`);
  }
  return trimmed;
}

const HOLDER_GATE = (ctx: ToolContext): boolean => isLoopHolder(ctx.agent);

// ─── wiki_edit ──────────────────────────────────────────────────────

const EditInput = z.object({
  wikiPath: z.string().min(1),
  newBody: z.string().min(1),
  logSummary: z.string().optional(),
});

export const wikiEdit: ToolDefinition<z.infer<typeof EditInput>> = {
  name: 'wiki_edit',
  toolset: 'wiki',
  description:
    'Overwrite the body of an existing wiki page. ONLY available while you hold the ' +
    'active dream_review loop. Frontmatter is preserved and the `updated` field is ' +
    "auto-refreshed; pass body content WITHOUT '---' frontmatter delimiters and " +
    'WITHOUT a leading H1 (the existing title stays unless you replace the whole body). ' +
    'mtime-aware: if the page changed on disk since the last read (e.g. the user edited ' +
    'in Obsidian), the write fails and you should fetch fresh content.',
  inputSchema: EditInput,
  jsonSchema: {
    type: 'object',
    properties: {
      wikiPath: {
        type: 'string',
        description: 'Wiki page path without .md, e.g. "personen/anna" or "infrastruktur/mac-studio".',
      },
      newBody: {
        type: 'string',
        description:
          'Full new body markdown (no frontmatter, no leading "---"). Use sections like ' +
          '"## Aktueller Stand", "## Eigenschaften", "## Zeitleiste", "## Notizen" if appropriate.',
      },
      logSummary: {
        type: 'string',
        description: 'One-line summary for the audit log. Optional — auto-generated if omitted.',
      },
    },
    required: ['wikiPath', 'newBody'],
    additionalProperties: false,
  },
  available: HOLDER_GATE,
  async handler(input, ctx) {
    refreshLoopActivity(ctx.agent);
    const wikiAbs = resolveWikiAbs(ctx);
    const wikiPath = validateWikiPath(input.wikiPath);
    const fileAbs = join(wikiAbs, `${wikiPath}.md`);
    const existing = await readWithMtime(fileAbs);
    if (!existing) {
      throw new Error(`wiki_edit: page '${wikiPath}' does not exist; use wiki_create instead`);
    }
    const parsed = parseWikiPage(existing.text);
    const today = isoDate();
    const updatedPage = buildWikiPage({
      frontmatter: {
        ...parsed.frontmatter,
        slug: parsed.frontmatter.slug || wikiPath,
        type: parsed.frontmatter.type,
        created: parsed.frontmatter.created || today,
        updated: today,
        ...(parsed.frontmatter.sources ? { sources: parsed.frontmatter.sources } : {}),
        ...(parsed.frontmatter.related ? { related: parsed.frontmatter.related } : {}),
      },
      body: input.newBody.startsWith('\n') ? input.newBody : `\n${input.newBody}`,
    });
    const writeRes = await writeIfMtimeUnchanged(fileAbs, updatedPage, existing.mtimeMs);
    if (writeRes.kind !== 'written') {
      throw new Error(
        `wiki_edit: page '${wikiPath}' changed on disk between read and write; refetch and retry`,
      );
    }
    const summary = input.logSummary ?? `${wikiPath} updated via dream_review`;
    logger.info({ msg: 'wiki.edit_via_review', agent: ctx.agent, wikiPath, summary });
    return { wikiPath, status: 'updated', summary };
  },
};

// ─── wiki_create ────────────────────────────────────────────────────

const CreateInput = z.object({
  wikiPath: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  related: z.array(z.string()).optional(),
});

export const wikiCreate: ToolDefinition<z.infer<typeof CreateInput>> = {
  name: 'wiki_create',
  toolset: 'wiki',
  description:
    'Create a new wiki page. ONLY available while you hold the active dream_review loop. ' +
    'The path must be a sub-folder + slug (e.g. "personen/lisa", "projekte/orbit"). ' +
    'Fails if a page already exists at that path. Pass body content WITHOUT frontmatter ' +
    'and WITHOUT a leading H1 — the title argument is rendered as H1 automatically.',
  inputSchema: CreateInput,
  jsonSchema: {
    type: 'object',
    properties: {
      wikiPath: {
        type: 'string',
        description: 'Wiki page path with subfolder, no .md, e.g. "personen/lisa".',
      },
      type: {
        type: 'string',
        description: 'Frontmatter type — typically "person", "projekt", "konzept", "ort", "werkzeug".',
      },
      title: {
        type: 'string',
        description: 'H1 title for the new page.',
      },
      body: {
        type: 'string',
        description:
          'Body markdown without frontmatter and without H1. Start with "## Aktueller Stand" or another section heading.',
      },
      related: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of related wiki paths (without .md) for the frontmatter.',
      },
    },
    required: ['wikiPath', 'type', 'title', 'body'],
    additionalProperties: false,
  },
  available: HOLDER_GATE,
  async handler(input, ctx) {
    refreshLoopActivity(ctx.agent);
    const wikiAbs = resolveWikiAbs(ctx);
    const wikiPath = validateWikiPath(input.wikiPath);
    if (!wikiPath.includes('/')) {
      throw new Error(`wiki_create: wikiPath '${wikiPath}' must include a subfolder (e.g. 'personen/lisa')`);
    }
    const fileAbs = join(wikiAbs, `${wikiPath}.md`);
    await mkdir(dirname(fileAbs), { recursive: true });
    const pageContent = buildInitialWikiPage({
      slug: wikiPath,
      type: input.type,
      title: input.title,
      body: input.body,
      ...(input.related && input.related.length > 0 ? { related: input.related } : {}),
    });
    const writeRes = await writeIfNotExists(fileAbs, pageContent);
    if (writeRes.kind !== 'written') {
      throw new Error(`wiki_create: page '${wikiPath}' already exists`);
    }
    logger.info({ msg: 'wiki.create_via_review', agent: ctx.agent, wikiPath });
    return { wikiPath, status: 'created' };
  },
};

// ─── wiki_delete ────────────────────────────────────────────────────

const DeleteInput = z.object({
  wikiPath: z.string().min(1),
});

export const wikiDelete: ToolDefinition<z.infer<typeof DeleteInput>> = {
  name: 'wiki_delete',
  toolset: 'wiki',
  description:
    'Delete a wiki page. ONLY available while you hold the active dream_review loop. ' +
    'Use sparingly — usually merging into another page or fixing the content via ' +
    'wiki_edit is the right move. Idempotent: deleting a non-existent page returns ' +
    'success without error.',
  inputSchema: DeleteInput,
  jsonSchema: {
    type: 'object',
    properties: {
      wikiPath: {
        type: 'string',
        description: 'Wiki page path to delete (no .md).',
      },
    },
    required: ['wikiPath'],
    additionalProperties: false,
  },
  available: HOLDER_GATE,
  async handler(input, ctx) {
    refreshLoopActivity(ctx.agent);
    const wikiAbs = resolveWikiAbs(ctx);
    const wikiPath = validateWikiPath(input.wikiPath);
    const fileAbs = join(wikiAbs, `${wikiPath}.md`);
    try {
      await unlink(fileAbs);
      logger.info({ msg: 'wiki.delete_via_review', agent: ctx.agent, wikiPath });
      return { wikiPath, status: 'deleted' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { wikiPath, status: 'already_absent' };
      }
      throw err;
    }
  },
};

export function wikiTools(): ToolDefinition[] {
  return [wikiEdit, wikiCreate, wikiDelete] as ToolDefinition[];
}
