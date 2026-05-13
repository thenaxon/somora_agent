// Project file CRUD. Storage layout:
//
//   ~/.somora/projects/<slug>.md
//
// One Markdown+YAML-frontmatter file per project. Body is intentionally
// empty in v1 — the project IS its frontmatter. Free-form notes that
// "belong to" a project live in separate .md files referenced via
// `paths`, not inside the project file itself.
//
// Writes are atomic via tmp+rename (same pattern as sessionMetaStore).
// All validation against config (entity vs. config.projects.entities,
// resource refs vs. config.resources) is done by callers in the tools
// layer — this module trusts its inputs schema-wise and just does I/O.

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import { PROJECT_SLUG_RE, ProjectFrontmatterSchema, type ProjectFrontmatter } from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const PROJECTS_DIR = join(SOMORA_HOME, 'projects');

function projectPath(slug: string): string {
  if (!PROJECT_SLUG_RE.test(slug)) {
    throw new Error(`invalid project slug '${slug}' — must match ${PROJECT_SLUG_RE.source}`);
  }
  return join(PROJECTS_DIR, `${slug}.md`);
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function ensureDir(): Promise<void> {
  await mkdir(PROJECTS_DIR, { recursive: true });
}

/**
 * Read and parse a project file. Returns null when the file doesn't
 * exist (caller decides 404 vs. create-new). Throws on schema-invalid
 * content so an editor-corrupted file doesn't silently pass through.
 */
export async function readProject(slug: string): Promise<ProjectFrontmatter | null> {
  let raw: string;
  try {
    raw = await readFile(projectPath(slug), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const parsed = matter(raw);
  const data = parsed.data ?? {};
  // Slug is mirrored in the frontmatter for round-trip robustness; if a
  // user renamed the file by hand and the inner slug now disagrees,
  // trust the FILENAME and overwrite the frontmatter slug at next write.
  // For read, return what's on disk — the caller can decide.
  const result = ProjectFrontmatterSchema.safeParse({ ...data, slug });
  if (!result.success) {
    throw new Error(
      `project '${slug}' has invalid frontmatter: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

export async function projectExists(slug: string): Promise<boolean> {
  try {
    await stat(projectPath(slug));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * Atomic write — tmp+rename pattern. Adds a unique tmp suffix so
 * concurrent writers (rare but possible: multi-agent flows) don't race
 * the same `<path>.tmp` filename. Same precedent as sessionMetaStore.
 */
export async function writeProject(project: ProjectFrontmatter): Promise<void> {
  await ensureDir();
  const path = projectPath(project.slug);
  // gray-matter.stringify expects (body, data). Empty body for v1.
  const content = matter.stringify('', project);
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

/**
 * List all projects on disk. Returns parsed frontmatters; files that
 * fail schema validation are SKIPPED (logged in caller's responsibility
 * — store stays silent so list() never throws on one broken file).
 * Sorted by `updated` desc.
 */
export async function listProjects(): Promise<ProjectFrontmatter[]> {
  let entries: string[];
  try {
    entries = await readdir(PROJECTS_DIR);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const slugs = entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .filter((s) => PROJECT_SLUG_RE.test(s));
  const projects: ProjectFrontmatter[] = [];
  for (const slug of slugs) {
    try {
      const p = await readProject(slug);
      if (p) projects.push(p);
    } catch {
      // skip broken files silently — list() shouldn't fail entirely on
      // one corrupt frontmatter
    }
  }
  projects.sort((a, b) => b.updated.localeCompare(a.updated));
  return projects;
}

/**
 * Hard-delete a project file. NOT exposed via tools in v1 — soft-delete
 * (archive flag) is the user-facing path. This is here for completeness
 * + future admin commands. Manual `rm ~/.somora/projects/<slug>.md` is
 * the v1 escape hatch.
 */
export async function deleteProjectFile(slug: string): Promise<boolean> {
  try {
    await unlink(projectPath(slug));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/** Helper exposed for tests / smoke scripts that need the concrete path. */
export function projectFilePath(slug: string): string {
  return projectPath(slug);
}
