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

import {
  isLoopHolder,
  noteWikiToolCall,
  refreshLoopActivity,
} from '../../dream/loop-state.ts';
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

/** Enforce the per-turn cap before doing any work. Throws an error
 *  the model can read and react to ("describe the next change and
 *  wait for the user before continuing"). */
function enforcePerTurnCap(toolName: string): void {
  const probe = noteWikiToolCall();
  if (probe.ok) return;
  throw new Error(
    `${toolName}: per-turn wiki cap reached (${probe.cap} edits per turn). ` +
      `STOP — describe the next change in your reply and wait for the user to confirm before doing more. ` +
      `The cap resets on the user's next message.`,
  );
}

function applyFrontmatterOps(
  current: Record<string, unknown>,
  ops: {
    relatedAdd?: string[];
    relatedRemove?: string[];
    sourcesAdd?: string[];
    sourcesRemove?: string[];
  },
): Record<string, unknown> {
  const next = { ...current };
  const relatedSet = new Set<string>(
    Array.isArray(current.related) ? (current.related as string[]) : [],
  );
  for (const r of ops.relatedAdd ?? []) relatedSet.add(r);
  for (const r of ops.relatedRemove ?? []) relatedSet.delete(r);
  if (relatedSet.size > 0) next.related = [...relatedSet];
  else delete next.related;

  const sourcesSet = new Set<string>(
    Array.isArray(current.sources) ? (current.sources as string[]) : [],
  );
  for (const s of ops.sourcesAdd ?? []) sourcesSet.add(s);
  for (const s of ops.sourcesRemove ?? []) sourcesSet.delete(s);
  if (sourcesSet.size > 0) next.sources = [...sourcesSet];
  else delete next.sources;

  return next;
}

// ─── wiki_edit ──────────────────────────────────────────────────────

const EditInput = z
  .object({
    wikiPath: z.string().min(1),
    newBody: z.string().optional(),
    relatedAdd: z.array(z.string()).optional(),
    relatedRemove: z.array(z.string()).optional(),
    sourcesAdd: z.array(z.string()).optional(),
    sourcesRemove: z.array(z.string()).optional(),
    logSummary: z.string().optional(),
  })
  .refine(
    (v) =>
      typeof v.newBody === 'string' ||
      (v.relatedAdd && v.relatedAdd.length > 0) ||
      (v.relatedRemove && v.relatedRemove.length > 0) ||
      (v.sourcesAdd && v.sourcesAdd.length > 0) ||
      (v.sourcesRemove && v.sourcesRemove.length > 0),
    { message: 'wiki_edit needs at least one of: newBody, relatedAdd, relatedRemove, sourcesAdd, sourcesRemove' },
  );

export const wikiEdit: ToolDefinition<z.infer<typeof EditInput>> = {
  name: 'wiki_edit',
  toolset: 'wiki',
  description:
    'Update an existing wiki page. ONLY available while you hold the active dream_review loop. ' +
    'You can change the body, the frontmatter `related:` list, the frontmatter `sources:` list, or ' +
    'any combination — pass only the fields you want to touch.\n' +
    '\n' +
    "Body edit: pass `newBody` WITHOUT '---' frontmatter delimiters and WITHOUT a leading H1. The " +
    'existing title stays unless you replace the whole body explicitly.\n' +
    '\n' +
    'Frontmatter edits: use `relatedAdd` / `relatedRemove` / `sourcesAdd` / `sourcesRemove` (each an ' +
    'array of strings). These mutate the existing list — pass the slugs to add/remove, not the full ' +
    'replacement list. Useful for fixing dead refs in `related:` (call with relatedRemove: ["dead/page"]).\n' +
    '\n' +
    "The `updated` field is auto-refreshed on any edit. Mtime-aware: if the page changed on disk " +
    "since the last read, the write fails and you should refetch + retry.",
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
          'Optional. Full new body markdown (no frontmatter, no leading "---"). Use sections like ' +
          '"## Aktueller Stand", "## Eigenschaften", "## Zeitleiste", "## Notizen" if appropriate. ' +
          'Omit when only the frontmatter (related/sources) needs to change.',
      },
      relatedAdd: {
        type: 'array',
        items: { type: 'string' },
        description: 'Slugs to add to the `related:` frontmatter list. Idempotent.',
      },
      relatedRemove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Slugs to remove from `related:`. Use this to clear dead refs without touching body.',
      },
      sourcesAdd: {
        type: 'array',
        items: { type: 'string' },
        description: 'Strings to add to the `sources:` frontmatter list. Idempotent.',
      },
      sourcesRemove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Strings to remove from `sources:`.',
      },
      logSummary: {
        type: 'string',
        description: 'One-line summary for the audit log. Optional — auto-generated if omitted.',
      },
    },
    required: ['wikiPath'],
    additionalProperties: false,
  },
  available: HOLDER_GATE,
  async handler(input, ctx) {
    enforcePerTurnCap('wiki_edit');
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
    const fmNext = applyFrontmatterOps(parsed.frontmatter, {
      ...(input.relatedAdd ? { relatedAdd: input.relatedAdd } : {}),
      ...(input.relatedRemove ? { relatedRemove: input.relatedRemove } : {}),
      ...(input.sourcesAdd ? { sourcesAdd: input.sourcesAdd } : {}),
      ...(input.sourcesRemove ? { sourcesRemove: input.sourcesRemove } : {}),
    });
    fmNext.slug = (parsed.frontmatter.slug as string) || wikiPath;
    fmNext.type = parsed.frontmatter.type;
    fmNext.created = (parsed.frontmatter.created as string) || today;
    fmNext.updated = today;
    const bodyOut =
      typeof input.newBody === 'string'
        ? input.newBody.startsWith('\n')
          ? input.newBody
          : `\n${input.newBody}`
        : parsed.body;
    const updatedPage = buildWikiPage({
      // applyFrontmatterOps preserves all unknown fields, builder
      // re-orders the standard ones; cast back to the typed shape.
      frontmatter: fmNext as typeof parsed.frontmatter,
      body: bodyOut,
    });
    const writeRes = await writeIfMtimeUnchanged(fileAbs, updatedPage, existing.mtimeMs);
    if (writeRes.kind !== 'written') {
      throw new Error(
        `wiki_edit: page '${wikiPath}' changed on disk between read and write; refetch and retry`,
      );
    }
    const summary = input.logSummary ?? `${wikiPath} updated via dream_review`;
    logger.info({
      msg: 'wiki.edit_via_review',
      agent: ctx.agent,
      wikiPath,
      summary,
      bodyChanged: typeof input.newBody === 'string',
      relatedAdd: input.relatedAdd?.length ?? 0,
      relatedRemove: input.relatedRemove?.length ?? 0,
      sourcesAdd: input.sourcesAdd?.length ?? 0,
      sourcesRemove: input.sourcesRemove?.length ?? 0,
    });
    return {
      wikiPath,
      status: 'updated',
      summary,
      bodyChanged: typeof input.newBody === 'string',
      frontmatterChanged:
        (input.relatedAdd?.length ?? 0) +
          (input.relatedRemove?.length ?? 0) +
          (input.sourcesAdd?.length ?? 0) +
          (input.sourcesRemove?.length ?? 0) >
        0,
    };
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
    'The path must be a sub-folder + slug (e.g. "personen/jane-doe", "projekte/orbit"). ' +
    'Fails if a page already exists at that path. Pass body content WITHOUT frontmatter ' +
    'and WITHOUT a leading H1 — the title argument is rendered as H1 automatically.',
  inputSchema: CreateInput,
  jsonSchema: {
    type: 'object',
    properties: {
      wikiPath: {
        type: 'string',
        description: 'Wiki page path with subfolder, no .md, e.g. "personen/jane-doe".',
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
    enforcePerTurnCap('wiki_create');
    refreshLoopActivity(ctx.agent);
    const wikiAbs = resolveWikiAbs(ctx);
    const wikiPath = validateWikiPath(input.wikiPath);
    if (!wikiPath.includes('/')) {
      throw new Error(`wiki_create: wikiPath '${wikiPath}' must include a subfolder (e.g. 'personen/jane-doe')`);
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
    enforcePerTurnCap('wiki_delete');
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
