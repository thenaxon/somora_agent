// Deep file actions — write wiki page, delete source memory file,
// merge updates back into a wiki page.
//
// As of v2.2 the stub-pattern is gone. After successful promote/merge
// the source memory file gets DELETED, not stubbed. Wiki is the
// single source of truth.
//
// All wiki writes go through the mtime-conflict helpers from
// `../wiki/conflict.ts`: if a wiki page changed since we last read it,
// we abort and let the next run pick it up. Memory-file delete is
// best-effort and logs on failure but doesn't roll back the wiki write
// (Deep is idempotent on collision — next run sees the wiki page
// exists and routes to merge).
//
// See `private/dream-system-v2.md`.

import { mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import matter from 'gray-matter';

import { logger } from '../server/logger.ts';
import { readWithMtime, writeIfMtimeUnchanged, writeIfNotExists } from '../wiki/conflict.ts';
import {
  buildInitialWikiPage,
  buildWikiPage,
  parseWikiPage,
} from '../wiki/templates.ts';

/** Defensive guard: strip a leading YAML frontmatter block if the LLM
 *  worker accidentally serialized one into the body field. The Deep
 *  prompt asks for body-only; this is a safety net so any future model
 *  drift can't reproduce the 2026-05-09 Lucid double-frontmatter bug. */
function stripLeadingFrontmatter(body: string): string {
  const trimmed = body.replace(/^[\s﻿]+/, '');
  if (!trimmed.startsWith('---')) return body;
  const parsed = matter(trimmed);
  if (Object.keys(parsed.data).length === 0) return body;
  return parsed.content.startsWith('\n') ? parsed.content : `\n${parsed.content}`;
}
import type {
  CandidateOutcome,
  MemoryFateDecision,
  PromotionCandidate,
} from '../wiki/types.ts';

export interface ActionContext {
  /** Absolute path to the wiki root (<vault>/<wiki-subfolder>). */
  wikiAbs: string;
}

/**
 * Apply a "promote" decision: create the wiki page, then delete the
 * source memory file.
 *
 * Failure modes:
 *  - wiki page already exists at the target path → caller should have
 *    routed via decideMerge instead. We defer to writeIfNotExists and
 *    return `failed` (the runner can retry on next pass — wiki content
 *    will then be visible to Opus and decision will route to merge).
 *  - memory file delete fails (e.g. EBUSY): log warn, return promoted
 *    anyway; next Deep run sees the un-deleted memory plus the now-
 *    existing wiki page and will route to merge (idempotent).
 */
export async function applyPromote(args: {
  candidate: PromotionCandidate;
  decision: Extract<MemoryFateDecision, { kind: 'promote' }>;
  ctx: ActionContext;
}): Promise<CandidateOutcome> {
  const { candidate, decision, ctx } = args;
  const wikiPath = decision.slug; // e.g. "personen/luca"
  const wikiFileAbs = join(ctx.wikiAbs, `${wikiPath}.md`);

  // Build the new wiki page content.
  const wikiPageContent = buildInitialWikiPage({
    slug: wikiPath,
    type: decision.type,
    title: decision.title,
    body: stripLeadingFrontmatter(decision.body),
    sources: [`${candidate.agent}/${candidate.slug}`],
    related: decision.related,
  });

  // Step 1: create wiki page (must NOT exist yet).
  await mkdir(dirname(wikiFileAbs), { recursive: true });
  const writeWiki = await writeIfNotExists(wikiFileAbs, wikiPageContent);
  if (writeWiki.kind !== 'written') {
    // Wiki page already exists — collision. Idempotent recovery: leave
    // memory file alone, next Deep run sees the wiki page exists and
    // will route this candidate via merge instead.
    logger.info({
      msg: 'dream.deep.promote_collision_left_for_next_run',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      wikiPath,
    });
    return {
      kind: 'failed',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      error: `wiki page ${wikiPath} already exists; next Deep run will treat as merge candidate`,
    };
  }

  // Step 2: delete source memory file. Best-effort.
  await deleteSourceMemory(candidate, 'promote');

  return {
    kind: 'promoted',
    agent: candidate.agent,
    memorySlug: candidate.slug,
    wikiPath,
    logSummary: `${wikiPath} promoted from ${candidate.agent}/${candidate.slug}`,
  };
}

/**
 * Apply a "merge" decision: rewrite the existing wiki page with the
 * updated body, preserve frontmatter (refresh `updated`, append source
 * pointer if new, merge `related`), then delete the source memory file.
 *
 * Wiki write is mtime-aware. If the wiki page changed since we read
 * it, abort the merge — the memory file stays untouched and gets
 * re-evaluated next run.
 */
export async function applyMerge(args: {
  candidate: PromotionCandidate;
  decision: Extract<MemoryFateDecision, { kind: 'merge' }>;
  ctx: ActionContext;
  wikiPageMtimeMs: number;
}): Promise<CandidateOutcome> {
  const { candidate, decision, ctx, wikiPageMtimeMs } = args;
  const wikiPath = decision.wikiPath;
  const wikiFileAbs = join(ctx.wikiAbs, `${wikiPath}.md`);

  // Re-read wiki page to get current content + parse fm. We don't
  // trust the caller's snapshot — we need the latest-known fm.
  const existing = await readWithMtime(wikiFileAbs);
  if (!existing) {
    return {
      kind: 'failed',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      error: `wiki page ${wikiPath} no longer exists`,
    };
  }
  if (existing.mtimeMs !== wikiPageMtimeMs) {
    // Snapshot drifted. Bail — memory file stays for next run.
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: `wiki page ${wikiPath} edited externally between read and write; will retry next run`,
      transient: true,
    };
  }
  const parsed = parseWikiPage(existing.text);

  // Refresh frontmatter: `updated` to today; merge `related`; append source.
  const today = isoDate();
  const sourcesSet = new Set<string>(
    Array.isArray(parsed.frontmatter.sources) ? parsed.frontmatter.sources : [],
  );
  sourcesSet.add(`${candidate.agent}/${candidate.slug}`);
  const relatedSet = new Set<string>(
    Array.isArray(parsed.frontmatter.related) ? parsed.frontmatter.related : [],
  );
  if (decision.related) {
    for (const r of decision.related) relatedSet.add(r);
  }
  const cleanBody = stripLeadingFrontmatter(decision.body);
  const newPage = buildWikiPage({
    frontmatter: {
      ...parsed.frontmatter,
      slug: parsed.frontmatter.slug || wikiPath,
      type: parsed.frontmatter.type,
      created: parsed.frontmatter.created || today,
      updated: today,
      sources: [...sourcesSet],
      ...(relatedSet.size > 0 ? { related: [...relatedSet] } : {}),
    },
    body: cleanBody.startsWith('\n') ? cleanBody : `\n${cleanBody}`,
  });

  // Step 1: write wiki page (mtime check)
  const writeWiki = await writeIfMtimeUnchanged(wikiFileAbs, newPage, existing.mtimeMs);
  if (writeWiki.kind !== 'written') {
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: `wiki page ${wikiPath} write failed: ${writeWiki.kind}`,
      transient: true,
    };
  }

  // Step 2: delete source memory file. Best-effort.
  await deleteSourceMemory(candidate, 'merge');

  return {
    kind: 'merged',
    agent: candidate.agent,
    memorySlug: candidate.slug,
    wikiPath,
    logSummary: decision.logSummary,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Delete the source memory file after successful wiki-write. Best-
 *  effort: a failure here doesn't roll back the wiki — Deep is
 *  idempotent (next run sees memory file + wiki page, routes to
 *  merge). Log loudly so it's visible. */
async function deleteSourceMemory(
  candidate: PromotionCandidate,
  via: 'promote' | 'merge',
): Promise<void> {
  try {
    await unlink(candidate.path);
    logger.debug({
      msg: 'dream.deep.memory_unlinked',
      agent: candidate.agent,
      slug: candidate.slug,
      via,
    });
  } catch (err) {
    logger.warn({
      msg: 'dream.deep.memory_unlink_failed',
      agent: candidate.agent,
      slug: candidate.slug,
      path: candidate.path,
      err: (err as Error).message,
      hint: 'wiki was written; next Deep run will see the wiki page exists and route as merge',
    });
  }
}

function isoDate(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
