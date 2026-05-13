// Project tools — six tools that let an agent manage the project
// pointer-file index (~/.somora/projects/<slug>.md) and pin/unpin a
// project to the current session.
//
// All six are gated on `config.projects.enabled` via the `available`
// probe — when projects are disabled in config.yaml, the tools are
// completely invisible to the model (filtered out by the registry
// before it builds the model-facing tool list).
//
// Why all in one file: six small tools with shared validation helpers
// (entity-cross-check, scheme inference) read better together than
// split into six files with import-chains. If this grows past ~10 tools
// we can re-split by responsibility (read tools vs. write tools).

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import { sessionMetaStore } from '../../storage/sessions.ts';
import { focusProject } from '../../projects/focus.ts';
import { validatePathRef, inferPathType } from '../../projects/scheme.ts';
import {
  deleteProjectFile,
  listProjects,
  projectExists,
  readProject,
  writeProject,
} from '../../projects/store.ts';
import {
  PROJECT_SLUG_RE,
  ProjectFrontmatterSchema,
  ProjectPathSchema,
  type ProjectFrontmatter,
  type ProjectPath,
} from '../../projects/types.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';

// ─── shared helpers ─────────────────────────────────────────────────

function ensureEnabled(ctx: ToolContext): void {
  if (!ctx.config.projects?.enabled) {
    throw new Error('projects.enabled is false in config.yaml — project tools are inactive');
  }
}

function validateEntity(ctx: ToolContext, entitySlug: string): void {
  const entities = ctx.config.projects?.entities ?? [];
  if (entities.length === 0) {
    throw new Error(
      'no entities configured in config.projects.entities — add at least one before creating projects',
    );
  }
  const known = entities.map((e) => e.slug);
  if (!known.includes(entitySlug)) {
    throw new Error(`unknown entity '${entitySlug}' — available: ${known.join(', ')}`);
  }
}

function validatePathsArray(paths: ProjectPath[], ctx: ToolContext): void {
  const errors: string[] = [];
  for (const p of paths) {
    const result = validatePathRef(p.ref, ctx.config);
    if (!result.ok) errors.push(result.error);
  }
  if (errors.length > 0) {
    throw new Error(`path validation failed: ${errors.join('; ')}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Compact projection of a project for `project_list` — strips the
 *  paths array so the list result stays small. Callers fetch full
 *  details via project_get when they need the pointers. */
interface ProjectSummary {
  slug: string;
  name: string;
  entity: string;
  description?: string;
  color?: string;
  tags: string[];
  created: string;
  updated: string;
  expires?: string | null;
  archived: boolean;
  pathCount: number;
}

function toSummary(p: ProjectFrontmatter): ProjectSummary {
  const summary: ProjectSummary = {
    slug: p.slug,
    name: p.name,
    entity: p.entity,
    tags: p.tags,
    created: p.created,
    updated: p.updated,
    archived: p.archived,
    pathCount: p.paths.length,
  };
  if (p.description !== undefined) summary.description = p.description;
  if (p.color !== undefined) summary.color = p.color;
  if (p.expires !== undefined) summary.expires = p.expires;
  return summary;
}

// ─── entity_list ─────────────────────────────────────────────────────

const EntityListInput = z.object({}).strict();

export const entityList: ToolDefinition<z.infer<typeof EntityListInput>> = {
  name: 'entity_list',
  toolset: 'projects',
  description:
    'List the entities configured in config.projects.entities — the controlled vocabulary for ' +
    'project-creation. Call this BEFORE project_create if you are unsure which entity slug ' +
    'matches the user\'s intent (e.g. you heard a fuzzy STT transcript). Entities are CURATED ' +
    'by the user in config.yaml; you cannot extend the list via tools.',
  inputSchema: EntityListInput,
  jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
  available: (ctx) => Boolean(ctx.config.projects?.enabled),
  async handler(_input, ctx) {
    ensureEnabled(ctx);
    return { entities: ctx.config.projects?.entities ?? [] };
  },
};

// ─── project_list ────────────────────────────────────────────────────

const ProjectListInput = z
  .object({
    entity: z.string().optional().describe('Filter to projects matching this entity slug.'),
    tag: z.string().optional().describe('Filter to projects whose tags include this string.'),
    includeArchived: z.boolean().default(false).describe('Include soft-deleted projects.'),
  })
  .strict();

export const projectList: ToolDefinition<z.infer<typeof ProjectListInput>> = {
  name: 'project_list',
  toolset: 'projects',
  description:
    'List configured projects with light metadata. Returns slug, name, entity, description, ' +
    'color, tags, timestamps, archived state, and path count — but NOT the full paths array. ' +
    'Use project_get to fetch a single project\'s full pointer-list. Filters: `entity` and ' +
    '`tag` are AND-combined. Archived projects are hidden by default — pass ' +
    'includeArchived:true to see them.',
  inputSchema: ProjectListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      entity: { type: 'string', description: 'Filter to projects matching this entity slug.' },
      tag: { type: 'string', description: 'Filter to projects whose tags include this string.' },
      includeArchived: {
        type: 'boolean',
        description: 'Include soft-deleted projects (default false).',
      },
    },
    additionalProperties: false,
  },
  available: (ctx) => Boolean(ctx.config.projects?.enabled),
  async handler(input, ctx) {
    ensureEnabled(ctx);
    const all = await listProjects();
    const filtered = all.filter((p) => {
      if (!input.includeArchived && p.archived) return false;
      if (input.entity && p.entity !== input.entity) return false;
      if (input.tag && !p.tags.includes(input.tag)) return false;
      return true;
    });
    return { projects: filtered.map(toSummary), total: filtered.length };
  },
};

// ─── project_get ─────────────────────────────────────────────────────

const ProjectGetInput = z
  .object({
    slug: z.string().regex(PROJECT_SLUG_RE).describe('Project slug to fetch.'),
  })
  .strict();

export const projectGet: ToolDefinition<z.infer<typeof ProjectGetInput>> = {
  name: 'project_get',
  toolset: 'projects',
  description:
    'Fetch a single project\'s full frontmatter — all fields including the paths array with ' +
    'per-path scheme inference (`local` / `url` / `resource`). Returns 404-style error if the ' +
    'slug does not exist.',
  inputSchema: ProjectGetInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'Project slug to fetch.' },
    },
    required: ['slug'],
    additionalProperties: false,
  },
  available: (ctx) => Boolean(ctx.config.projects?.enabled),
  async handler(input, ctx) {
    ensureEnabled(ctx);
    const project = await readProject(input.slug);
    if (!project) {
      throw new Error(`project '${input.slug}' does not exist`);
    }
    // Decorate paths with inferred type for the agent's convenience.
    const decoratedPaths = project.paths.map((p) => {
      const inferred = inferPathType(p.ref);
      return {
        ref: p.ref,
        ...(p.label ? { label: p.label } : {}),
        type: inferred?.type ?? 'unknown',
        ...(inferred?.resource ? { resource: inferred.resource } : {}),
      };
    });
    return { project: { ...project, paths: decoratedPaths } };
  },
};

// ─── project_create ──────────────────────────────────────────────────

const CreateInput = z
  .object({
    slug: z.string().regex(PROJECT_SLUG_RE).describe('New unique project slug (lowercase kebab-case).'),
    name: z.string().min(1).describe('Display name.'),
    entity: z
      .string()
      .min(1)
      .describe('Entity slug — MUST match one of config.projects.entities. Call entity_list first if unsure.'),
    description: z.string().optional(),
    color: z.string().optional().describe('CSS color (hex like "#4f46e5" or name).'),
    tags: z.array(z.string().min(1)).default([]),
    expires: z.string().nullable().optional().describe('ISO date string for soft-expiry, or null.'),
    paths: z.array(ProjectPathSchema).default([]).describe('Initial pointer list (can be empty).'),
  })
  .strict();

export const projectCreate: ToolDefinition<z.infer<typeof CreateInput>> = {
  name: 'project_create',
  toolset: 'projects',
  description:
    'Create a new project pointer file under ~/.somora/projects/<slug>.md with frontmatter ' +
    'metadata + an initial pointer list. Slug must be unique (kebab-case). Entity is ' +
    'validated against config.projects.entities — use entity_list first if uncertain. Paths ' +
    'use scheme inference: `~/path` or `/path` → local, `https://...` etc. → url, ' +
    '`<resource-slug>:/path` → resource (cross-checked against config.resources). Multiple ' +
    'paths in one call: pass them all in `paths`.',
  inputSchema: CreateInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'New unique project slug (lowercase kebab-case).' },
      name: { type: 'string', description: 'Display name.' },
      entity: {
        type: 'string',
        description: 'Entity slug — MUST match one of config.projects.entities.',
      },
      description: { type: 'string' },
      color: { type: 'string', description: 'CSS color (hex like "#4f46e5" or name).' },
      tags: { type: 'array', items: { type: 'string' } },
      expires: { type: ['string', 'null'], description: 'ISO date for soft-expiry, or null.' },
      paths: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            label: { type: 'string' },
          },
          required: ['ref'],
          additionalProperties: false,
        },
      },
    },
    required: ['slug', 'name', 'entity'],
    additionalProperties: false,
  },
  available: (ctx) => Boolean(ctx.config.projects?.enabled),
  async handler(input, ctx) {
    ensureEnabled(ctx);
    validateEntity(ctx, input.entity);
    if (await projectExists(input.slug)) {
      throw new Error(`project '${input.slug}' already exists`);
    }
    validatePathsArray(input.paths, ctx);

    const now = nowIso();
    const project: ProjectFrontmatter = ProjectFrontmatterSchema.parse({
      slug: input.slug,
      name: input.name,
      entity: input.entity,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      tags: input.tags,
      created: now,
      updated: now,
      ...(input.expires !== undefined ? { expires: input.expires } : {}),
      archived: false,
      paths: input.paths,
    });
    await writeProject(project);
    logger.info({
      msg: 'project.created',
      slug: project.slug,
      entity: project.entity,
      pathCount: project.paths.length,
      agent: ctx.agent,
      session: ctx.session,
    });
    return { project };
  },
};

// ─── project_update ──────────────────────────────────────────────────

// UpdateOp union. Lives only in this file because it's tool-API surface,
// not stored — the on-disk shape is always the frontmatter snapshot.
const SetFieldOp = z.object({
  op: z.literal('set_field'),
  field: z.enum(['name', 'description', 'color', 'expires']),
  value: z.string().nullable(),
});
const AddPathOp = z.object({
  op: z.literal('add_path'),
  ref: z.string().min(1),
  label: z.string().min(1).optional(),
});
const RemovePathOp = z.object({
  op: z.literal('remove_path'),
  ref: z.string().min(1),
});
const SetTagsOp = z.object({
  op: z.literal('set_tags'),
  tags: z.array(z.string().min(1)),
});
const ArchiveOp = z.object({
  op: z.literal('archive'),
  reason: z.string().optional(),
});
const UnarchiveOp = z.object({
  op: z.literal('unarchive'),
});

const UpdateOpSchema = z.discriminatedUnion('op', [
  SetFieldOp,
  AddPathOp,
  RemovePathOp,
  SetTagsOp,
  ArchiveOp,
  UnarchiveOp,
]);
type UpdateOp = z.infer<typeof UpdateOpSchema>;

const UpdateInput = z
  .object({
    slug: z.string().regex(PROJECT_SLUG_RE),
    ops: z.array(UpdateOpSchema).min(1).describe('Mutations to apply, in order. Transactional.'),
  })
  .strict();

function applyOps(
  current: ProjectFrontmatter,
  ops: UpdateOp[],
  ctx: ToolContext,
): ProjectFrontmatter {
  // Work on a shallow clone so a mid-op failure leaves the caller's
  // copy untouched (we re-throw and skip the write).
  const next: ProjectFrontmatter = {
    ...current,
    tags: [...current.tags],
    paths: current.paths.map((p) => ({ ...p })),
  };
  for (const op of ops) {
    switch (op.op) {
      case 'set_field': {
        if (op.field === 'name') {
          if (op.value === null || op.value.trim().length === 0) {
            throw new Error("set_field name: value must be a non-empty string");
          }
          next.name = op.value;
        } else if (op.field === 'description') {
          if (op.value === null) {
            delete next.description;
          } else {
            next.description = op.value;
          }
        } else if (op.field === 'color') {
          if (op.value === null) {
            delete next.color;
          } else {
            next.color = op.value;
          }
        } else if (op.field === 'expires') {
          next.expires = op.value;
        }
        break;
      }
      case 'add_path': {
        const result = validatePathRef(op.ref, ctx.config);
        if (!result.ok) throw new Error(`add_path '${op.ref}': ${result.error}`);
        if (next.paths.some((p) => p.ref === op.ref)) {
          throw new Error(`add_path: ref '${op.ref}' already in paths`);
        }
        next.paths.push({ ref: op.ref, ...(op.label ? { label: op.label } : {}) });
        break;
      }
      case 'remove_path': {
        const idx = next.paths.findIndex((p) => p.ref === op.ref);
        if (idx < 0) {
          const known = next.paths.map((p) => p.ref).join(', ') || '(none)';
          throw new Error(`remove_path: no path with ref '${op.ref}' to remove (available: ${known})`);
        }
        next.paths.splice(idx, 1);
        break;
      }
      case 'set_tags': {
        // Replaces the full tags array — semantic equivalent to a set
        // operation. Per-tag add/remove ops would be possible but the
        // common use-case is "update the tag list to X" so a single
        // replace covers it cleaner.
        next.tags = [...op.tags];
        break;
      }
      case 'archive': {
        next.archived = true;
        next.archivedAt = nowIso();
        if (op.reason !== undefined) next.archiveReason = op.reason;
        break;
      }
      case 'unarchive': {
        next.archived = false;
        delete next.archivedAt;
        delete next.archiveReason;
        break;
      }
    }
  }
  return next;
}

export const projectUpdate: ToolDefinition<z.infer<typeof UpdateInput>> = {
  name: 'project_update',
  toolset: 'projects',
  description:
    'Apply one or more mutations to a project transactionally. Pass an `ops` array; all ops ' +
    'validate first, then a single write happens. If ANY op fails, NOTHING is written. ' +
    'Supported ops: ' +
    '`set_field` (name/description/color/expires — value=null clears optional fields except name), ' +
    '`add_path` (ref + optional label, scheme + resource cross-check), ' +
    '`remove_path` (by ref), ' +
    '`set_tags` (replaces full tag array), ' +
    '`archive` (soft-delete with optional reason), ' +
    '`unarchive` (restore). ' +
    'Entity cannot be mutated — delete and recreate to move a project between entities. ' +
    'Slug cannot be renamed in v1 (would break session links).',
  inputSchema: UpdateInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      ops: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string' },
          },
          required: ['op'],
          additionalProperties: true,
        },
        description:
          'Array of UpdateOp objects. Each must have an `op` field naming one of: ' +
          'set_field, add_path, remove_path, set_tags, archive, unarchive. ' +
          'Op-specific fields follow per shape.',
      },
    },
    required: ['slug', 'ops'],
    additionalProperties: false,
  },
  available: (ctx) => Boolean(ctx.config.projects?.enabled),
  async handler(input, ctx) {
    ensureEnabled(ctx);
    const current = await readProject(input.slug);
    if (!current) {
      throw new Error(`project '${input.slug}' does not exist`);
    }
    const next = applyOps(current, input.ops, ctx);
    next.updated = nowIso();
    await writeProject(next);
    logger.info({
      msg: 'project.updated',
      slug: next.slug,
      opCount: input.ops.length,
      opTypes: input.ops.map((o) => o.op),
      agent: ctx.agent,
      session: ctx.session,
    });
    return { project: next };
  },
};

// ─── project_focus ───────────────────────────────────────────────────

const FocusInput = z
  .object({
    slug: z
      .string()
      .regex(PROJECT_SLUG_RE)
      .nullable()
      .describe('Project slug to pin, or null to clear focus.'),
  })
  .strict();

export const projectFocus: ToolDefinition<z.infer<typeof FocusInput>> = {
  name: 'project_focus',
  toolset: 'projects',
  description:
    'Pin a project to the current session, or clear the current pin. When pinned, the project ' +
    'name + pointer list lands in the system prompt tail for every subsequent turn of this ' +
    'session, so the agent knows which paths matter. Pass `slug: null` (or omit handling) to ' +
    'unpin and remove project context. Idempotent — re-pinning the same project is a noop.',
  inputSchema: FocusInput,
  jsonSchema: {
    type: 'object',
    properties: {
      slug: { type: ['string', 'null'], description: 'Project slug to pin, or null to clear focus.' },
    },
    required: ['slug'],
    additionalProperties: false,
  },
  available: (ctx) => Boolean(ctx.config.projects?.enabled),
  async handler(input, ctx) {
    ensureEnabled(ctx);
    if (!ctx.session) {
      throw new Error('project_focus requires a session context — no session id available');
    }
    const result = await focusProject({
      agent: ctx.agent,
      session: ctx.session,
      slug: input.slug,
      via: 'tool',
      metaStore: sessionMetaStore,
    });
    return result;
  },
};

// ─── bundle export ──────────────────────────────────────────────────

export function projectTools(): ToolDefinition[] {
  return [
    entityList,
    projectList,
    projectGet,
    projectCreate,
    projectUpdate,
    projectFocus,
  ] as ToolDefinition[];
}

// Re-export deleteProjectFile so admin / future tools can use it
// without reaching into the store module. Currently unused — kept for
// the eventual `project_purge` admin path.
export { deleteProjectFile };
