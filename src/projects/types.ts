// Project schemas. A "project" in somora is a curated POINTER FILE that
// indexes existing storage locations (Obsidian notes, local paths,
// research artifacts, GDrive URLs, remote-resource paths) under one
// named handle. It is NOT a new storage layer — content stays in its
// existing homes and the agent uses its regular tools (file_read,
// obsidian_get, wiki_get, web_fetch, resource_*) to dig in.
//
// Storage: ~/.somora/projects/<slug>.md, Markdown with YAML
// frontmatter. Body intentionally empty in v1 — free notes belong in
// a linked .md file referenced as a `path`, not inside the project
// pointer.
//
// Path-type inference is scheme-driven (see scheme.ts) — the stored
// shape is just `{ref, label?}`. At render time we infer `local` /
// `url` / `resource` from the `ref` itself.
//
// Entities are a controlled vocabulary defined centrally in
// config.projects.entities. The agent picks FROM that list when
// creating projects (validated at write time), preventing STT
// mishearings like "enofhom" from becoming new phantom entities.

import { z } from 'zod';

/** Slug pattern for projects. Lowercase kebab-case to keep filename
 *  hygiene predictable and case-insensitive systems happy. */
export const PROJECT_SLUG_RE = /^[a-z0-9_-]+$/;

/** Path entry as stored. `type` is intentionally NOT a field — it gets
 *  inferred from `ref` at read/render time via scheme.ts. */
export const ProjectPathSchema = z.object({
  ref: z.string().min(1),
  label: z.string().min(1).optional(),
});
export type ProjectPath = z.infer<typeof ProjectPathSchema>;

/** Frontmatter shape persisted in the project .md file. */
export const ProjectFrontmatterSchema = z.object({
  /** Slug = filename without extension. Mirrored in the frontmatter for
   *  round-trip robustness if a file gets renamed by hand. */
  slug: z.string().regex(PROJECT_SLUG_RE),
  /** Display name. Free-form human-readable. */
  name: z.string().min(1),
  /** Entity slug — must match one of `config.projects.entities[].slug`
   *  at write time. Not validated by the schema itself (config-relative). */
  entity: z.string().min(1),
  description: z.string().optional(),
  /** CSS color string (hex, rgb(), name). Not validated for format. */
  color: z.string().optional(),
  /** Freeform tags. Optional, no central vocabulary — orthogonal to
   *  `entity`. Used for filter queries like "list all wip projects". */
  tags: z.array(z.string().min(1)).default([]),
  /** ISO timestamp set at create time. */
  created: z.string().min(1),
  /** ISO timestamp bumped on every successful update. */
  updated: z.string().min(1),
  /** Optional soft-expiry — pure metadata in v1, no worker auto-archives. */
  expires: z.string().nullable().optional(),
  /** Soft-delete flag. `project_list` filters these out by default. */
  archived: z.boolean().default(false),
  archivedAt: z.string().optional(),
  archiveReason: z.string().optional(),
  /** Pointer list. Type is scheme-inferred at use time. */
  paths: z.array(ProjectPathSchema).default([]),
});
export type ProjectFrontmatter = z.infer<typeof ProjectFrontmatterSchema>;
