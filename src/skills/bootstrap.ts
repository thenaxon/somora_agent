// Bootstrap built-in skills.
//
// somora ships some skills in its own package (under templates/skills/<slug>/)
// and seeds them into the user's `~/.somora/skills/<slug>/` directory so the
// regular Loader (src/skills/load.ts) — which reads ONLY from
// ~/.somora/skills/ — picks them up without any second source-of-truth.
//
// Update behavior is driven by SHA-256 content hashes recorded in
// ~/.somora/.skill-seed-state.json. The matrix:
//
//   user dir exists?  user-hash == state.seededHash?  action
//   ────────────────  ────────────────────────────    ──────────────────────
//   no                n/a                              seed (copy template)
//   yes               yes (or no state but adopting)   silent update from new template
//   yes               no (user has edited)             leave alone, warn-log
//   yes               no state                         adopt: record current hash, no overwrite
//
// State file is rewritten atomically (temp + rename) so a crash mid-write
// never leaves a half-written manifest.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../server/logger.ts';
import { SOMORA_VERSION } from '../version.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const USER_SKILLS_DIR = join(SOMORA_HOME, 'skills');
const STATE_FILE = join(SOMORA_HOME, '.skill-seed-state.json');

// Resolve <package>/templates/skills/ relative to this file's location. Works
// both from the dev tree (src/skills/bootstrap.ts → ../../templates/skills/)
// and the npm-installed location.
const HERE = dirname(fileURLToPath(import.meta.url));
export const BUILTIN_SKILLS_DIR = resolve(HERE, '..', '..', 'templates', 'skills');

const RESERVED_FOLDERS = new Set(['_templates']);

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface SeedStateEntry {
  seededHash: string;
  seededAt: string;
  fromSomoraVersion: string;
}

interface SeedState {
  version: 1;
  skills: Record<string, SeedStateEntry>;
}

export type SeedAction = 'seeded' | 'updated' | 'user_edited' | 'adopted' | 'unchanged' | 'error';

export interface SeedOutcome {
  slug: string;
  action: SeedAction;
  reason?: string;
}

export interface SeedReport {
  total: number;
  outcomes: SeedOutcome[];
}

function sha256(buf: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

async function readState(): Promise<SeedState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SeedState>;
    if (parsed.version === 1 && parsed.skills && typeof parsed.skills === 'object') {
      return { version: 1, skills: parsed.skills };
    }
    logger.warn({ msg: 'skills.bootstrap_state_invalid_shape', file: STATE_FILE });
    return { version: 1, skills: {} };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { version: 1, skills: {} };
    logger.warn({
      msg: 'skills.bootstrap_state_read_failed',
      err: (err as Error).message,
    });
    return { version: 1, skills: {} };
  }
}

async function writeState(state: SeedState): Promise<void> {
  // Tempfile lives in the same dir as the target so the final rename stays
  // on one filesystem (avoids EXDEV when /tmp is tmpfs and ~ is a real disk).
  await fs.mkdir(dirname(STATE_FILE), { recursive: true });
  const tmpPath = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await fs.rename(tmpPath, STATE_FILE);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function listBuiltinSlugs(): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Package shipped without templates/ — nothing to seed. Not an error.
      return [];
    }
    throw err;
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (RESERVED_FOLDERS.has(e.name)) continue;
    if (!SLUG_RE.test(e.name)) {
      logger.warn({ msg: 'skills.bootstrap_skip_invalid_dir', slug: e.name });
      continue;
    }
    out.push(e.name);
  }
  out.sort();
  return out;
}

async function readSkillMd(skillDir: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(join(skillDir, 'SKILL.md'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      await copyRecursive(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function replaceSkillDir(src: string, dst: string): Promise<void> {
  // Write to a sibling temp dir, then atomically swap. If dst exists, rename
  // the old one aside, move new into place, then remove old. This keeps a
  // momentary backup in case the swap is interrupted between the two renames.
  const parent = dirname(dst);
  await fs.mkdir(parent, { recursive: true });
  const stagePath = `${dst}.seed-${process.pid}-${Date.now()}`;
  const backupPath = `${dst}.old-${process.pid}-${Date.now()}`;
  await copyRecursive(src, stagePath);
  let dstExists = false;
  try {
    await fs.access(dst);
    dstExists = true;
  } catch {
    /* nothing to back up */
  }
  if (dstExists) {
    await fs.rename(dst, backupPath);
  }
  try {
    await fs.rename(stagePath, dst);
  } catch (err) {
    if (dstExists) {
      // Restore the original on failure.
      await fs.rename(backupPath, dst).catch(() => {});
    }
    throw err;
  }
  if (dstExists) {
    await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function processOne(
  slug: string,
  state: SeedState,
): Promise<SeedOutcome> {
  const builtinDir = join(BUILTIN_SKILLS_DIR, slug);
  const builtinSkillMd = await readSkillMd(builtinDir);
  if (!builtinSkillMd) {
    return { slug, action: 'error', reason: 'built-in SKILL.md missing in package' };
  }
  const builtinHash = sha256(builtinSkillMd);

  const userDir = join(USER_SKILLS_DIR, slug);
  const userSkillMd = await readSkillMd(userDir);

  if (userSkillMd === null) {
    // Case 1: user dir does not exist → seed.
    await replaceSkillDir(builtinDir, userDir);
    state.skills[slug] = {
      seededHash: builtinHash,
      seededAt: new Date().toISOString(),
      fromSomoraVersion: SOMORA_VERSION,
    };
    logger.info({ msg: 'skills.builtin_seeded', slug, hash: builtinHash });
    return { slug, action: 'seeded' };
  }

  const userHash = sha256(userSkillMd);
  const prev = state.skills[slug];

  if (!prev) {
    // Case 4: user dir exists but no state entry → adopt without overwriting.
    state.skills[slug] = {
      seededHash: userHash,
      seededAt: new Date().toISOString(),
      fromSomoraVersion: SOMORA_VERSION,
    };
    logger.info({ msg: 'skills.bootstrap_adopt', slug, hash: userHash });
    return { slug, action: 'adopted' };
  }

  if (userHash === builtinHash) {
    // Already up to date.
    return { slug, action: 'unchanged' };
  }

  if (userHash === prev.seededHash) {
    // Case 2: user has not edited since last seed → silent update.
    await replaceSkillDir(builtinDir, userDir);
    const oldHash = prev.seededHash;
    state.skills[slug] = {
      seededHash: builtinHash,
      seededAt: new Date().toISOString(),
      fromSomoraVersion: SOMORA_VERSION,
    };
    logger.info({
      msg: 'skills.builtin_updated',
      slug,
      oldHash,
      newHash: builtinHash,
    });
    return { slug, action: 'updated' };
  }

  // Case 3: user has edited their copy. Leave alone, warn-log.
  logger.warn({
    msg: 'skills.builtin_user_edited',
    slug,
    hint: `run 'somora skill update ${slug}' to re-seed from the bundled template`,
  });
  return {
    slug,
    action: 'user_edited',
    reason: `user has edited '${slug}', not overwriting`,
  };
}

/**
 * Seed built-in skills into ~/.somora/skills/. Called once at server start,
 * before the first loadAvailableSkills(). Returns a report so callers can log
 * a summary. Individual failures are captured per-slug and don't abort the
 * whole pass.
 */
export async function seedBuiltinSkills(): Promise<SeedReport> {
  logger.info({ msg: 'skills.bootstrap_start', from: BUILTIN_SKILLS_DIR });
  await fs.mkdir(USER_SKILLS_DIR, { recursive: true });
  const state = await readState();
  const slugs = await listBuiltinSlugs();
  const outcomes: SeedOutcome[] = [];
  for (const slug of slugs) {
    try {
      outcomes.push(await processOne(slug, state));
    } catch (err) {
      logger.warn({
        msg: 'skills.builtin_seed_failed',
        slug,
        err: (err as Error).message,
      });
      outcomes.push({
        slug,
        action: 'error',
        reason: (err as Error).message,
      });
    }
  }
  try {
    await writeState(state);
  } catch (err) {
    logger.warn({
      msg: 'skills.bootstrap_state_write_failed',
      err: (err as Error).message,
    });
  }
  const counts = outcomes.reduce<Record<SeedAction, number>>(
    (acc, o) => {
      acc[o.action] = (acc[o.action] ?? 0) + 1;
      return acc;
    },
    { seeded: 0, updated: 0, user_edited: 0, adopted: 0, unchanged: 0, error: 0 },
  );
  logger.info({
    msg: 'skills.bootstrap_done',
    total: outcomes.length,
    counts,
  });
  return { total: outcomes.length, outcomes };
}

/**
 * Force-overwrite a single user skill from its bundled template. Used by
 * `somora skill update <slug>`. Throws if the slug is not a built-in.
 */
export async function forceUpdateBuiltinSkill(slug: string): Promise<void> {
  if (RESERVED_FOLDERS.has(slug) || !SLUG_RE.test(slug)) {
    throw new Error(`invalid slug: ${slug}`);
  }
  const builtinDir = join(BUILTIN_SKILLS_DIR, slug);
  const builtinSkillMd = await readSkillMd(builtinDir);
  if (!builtinSkillMd) {
    throw new Error(`'${slug}' is not a built-in skill (not found in package templates)`);
  }
  const userDir = join(USER_SKILLS_DIR, slug);
  await replaceSkillDir(builtinDir, userDir);
  const state = await readState();
  state.skills[slug] = {
    seededHash: sha256(builtinSkillMd),
    seededAt: new Date().toISOString(),
    fromSomoraVersion: SOMORA_VERSION,
  };
  await writeState(state);
  logger.info({ msg: 'skills.builtin_force_updated', slug });
}

/** Return list of slug names that have a built-in template in the package. */
export async function listBuiltinSkillSlugs(): Promise<string[]> {
  return listBuiltinSlugs();
}
