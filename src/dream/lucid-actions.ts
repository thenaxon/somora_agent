// Lucid apply functions. One handler per fix-kind. Each takes a
// finding (with its embedded fix) and the wikiAbs context, applies
// the fix to disk, and returns a structured outcome.
//
// Mtime-aware writes: a wiki page that changed since the Lucid run
// gets the apply skipped — user is told to re-run Lucid.

import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import matter from 'gray-matter';

import { logger } from '../server/logger.ts';
import {
  readWithMtime,
  writeIfMtimeUnchanged,
  writeIfNotExists,
} from '../wiki/conflict.ts';
import { buildInitialWikiPage, buildWikiPage, parseWikiPage } from '../wiki/templates.ts';
import type { LucidFinding } from './lucid-types.ts';

/**
 * Strip a leading YAML frontmatter block from LLM-generated body, if
 * the worker accidentally emitted one. The Lucid prompt asks for body-only,
 * but Opus occasionally serializes the full page (frontmatter + body) into
 * `newBody`. Without this guard the apply path produces double-frontmatter
 * pages (verified bug 2026-05-09: 12 pages corrupted).
 */
function stripLeadingFrontmatter(body: string): string {
  const trimmed = body.replace(/^[\s﻿]+/, '');
  if (!trimmed.startsWith('---')) return body;
  const parsed = matter(trimmed);
  if (Object.keys(parsed.data).length === 0) return body;
  return parsed.content.startsWith('\n') ? parsed.content : `\n${parsed.content}`;
}

export interface LucidActionContext {
  /** Absolute path to <vault>/<wiki-subfolder>. */
  wikiAbs: string;
}

export type LucidApplyOutcome =
  | {
      kind: 'applied';
      detail: string;
    }
  | {
      kind: 'skipped';
      reason: string;
    }
  | {
      kind: 'failed';
      error: string;
    };

export async function applyLucidFinding(
  finding: LucidFinding,
  ctx: LucidActionContext,
): Promise<LucidApplyOutcome> {
  const fix = finding.fix;
  switch (fix.kind) {
    case 'update_page':
      return applyUpdatePage(fix.wikiPath, fix.newBody, fix.logSummary, ctx);
    case 'create_page':
      return applyCreatePage(fix, ctx);
    case 'delete_page':
      return applyDeletePage(fix.wikiPath, ctx);
    case 'no_op':
      return {
        kind: 'skipped',
        reason: 'informational finding — no apply action; dismiss when reviewed',
      };
  }
}

// ─── update_page ────────────────────────────────────────────────────

async function applyUpdatePage(
  wikiPath: string,
  newBody: string,
  logSummary: string,
  ctx: LucidActionContext,
): Promise<LucidApplyOutcome> {
  const fileAbs = join(ctx.wikiAbs, `${wikiPath}.md`);
  const existing = await readWithMtime(fileAbs);
  if (!existing) {
    return {
      kind: 'failed',
      error: `wiki page ${wikiPath} no longer exists — cannot update`,
    };
  }
  const parsed = parseWikiPage(existing.text);
  const today = isoDate();
  const cleanBody = stripLeadingFrontmatter(newBody);
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
    body: cleanBody.startsWith('\n') ? cleanBody : `\n${cleanBody}`,
  });
  const writeRes = await writeIfMtimeUnchanged(fileAbs, updatedPage, existing.mtimeMs);
  if (writeRes.kind !== 'written') {
    return {
      kind: 'skipped',
      reason: `${wikiPath} edited externally since Lucid scan; re-run Lucid before applying`,
    };
  }
  logger.info({ msg: 'lucid.applied.update_page', wikiPath, logSummary });
  return { kind: 'applied', detail: `${wikiPath} updated` };
}

// ─── create_page ────────────────────────────────────────────────────

async function applyCreatePage(
  fix: Extract<LucidFinding['fix'], { kind: 'create_page' }>,
  ctx: LucidActionContext,
): Promise<LucidApplyOutcome> {
  const fileAbs = join(ctx.wikiAbs, `${fix.wikiPath}.md`);
  await mkdir(dirname(fileAbs), { recursive: true });
  const cleanBody = stripLeadingFrontmatter(fix.body);
  const pageContent = buildInitialWikiPage({
    slug: fix.wikiPath,
    type: fix.type,
    title: fix.title,
    body: cleanBody,
    ...(fix.related && fix.related.length > 0 ? { related: fix.related } : {}),
  });
  const writeRes = await writeIfNotExists(fileAbs, pageContent);
  if (writeRes.kind !== 'written') {
    return {
      kind: 'skipped',
      reason: `${fix.wikiPath} already exists — possibly created since Lucid scan`,
    };
  }
  logger.info({ msg: 'lucid.applied.create_page', wikiPath: fix.wikiPath, logSummary: fix.logSummary });
  return { kind: 'applied', detail: `${fix.wikiPath} created` };
}

// ─── delete_page ────────────────────────────────────────────────────

async function applyDeletePage(
  wikiPath: string,
  ctx: LucidActionContext,
): Promise<LucidApplyOutcome> {
  const fileAbs = join(ctx.wikiAbs, `${wikiPath}.md`);
  try {
    await unlink(fileAbs);
    logger.info({ msg: 'lucid.applied.delete_page', wikiPath });
    return { kind: 'applied', detail: `${wikiPath} deleted` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'skipped', reason: `${wikiPath} already gone` };
    }
    return {
      kind: 'failed',
      error: `delete failed: ${(err as Error).message}`,
    };
  }
}

function isoDate(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
