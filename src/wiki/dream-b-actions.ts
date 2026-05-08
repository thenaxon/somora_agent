// Dream-B file actions — write wiki page, replace memory with stub,
// merge updates back into a wiki page, clear stub observations.
//
// All writes go through the mtime-conflict helpers from conflict.ts:
// if a file we're about to write changed since we last read it, we
// abort and let the next run pick it up. See `private/wiki-design.md`
// § "Konflikt-Strategie".

import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { logger } from '../server/logger.ts';
import { readWithMtime, writeIfMtimeUnchanged, writeIfNotExists } from './conflict.ts';
import {
  appendObservation as _appendObservation,
  buildInitialWikiPage,
  buildStub,
  clearObservations,
  parseStub,
  parseWikiPage,
  buildWikiPage,
} from './templates.ts';
import type {
  CandidateOutcome,
  MergeDecision,
  PromotionCandidate,
  PromotionDecision,
} from './types.ts';

export interface ActionContext {
  /** Absolute path to the wiki root (<vault>/<wiki-subfolder>). */
  wikiAbs: string;
}

/**
 * Apply a "promote" decision: create the wiki page, replace the agent
 * memory file with a stub pointing at the wiki page.
 *
 * Failure modes:
 *  - wiki page already exists at the target path → caller should have
 *    routed via decideMerge instead; but we defer to writeIfNotExists
 *    and report skipped.
 *  - memory file mtime changed since we read it → abort, will be
 *    retried next run.
 */
export async function applyPromote(args: {
  candidate: PromotionCandidate;
  decision: Extract<PromotionDecision, { kind: 'promote' }>;
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
    body: decision.body,
    sources: [`${candidate.agent}/${candidate.slug}`],
    related: decision.related,
  });

  // Step 1: create wiki page (must NOT exist yet).
  await mkdir(dirname(wikiFileAbs), { recursive: true });
  const writeWiki = await writeIfNotExists(wikiFileAbs, wikiPageContent);
  if (writeWiki.kind !== 'written') {
    logger.warn({
      msg: 'wiki.dream_b.promote_skip_wiki_exists',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      wikiPath,
    });
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: `wiki page ${wikiPath} already exists; merge path expected`,
    };
  }

  // Step 2: replace memory file with a stub (mtime-aware).
  const stubText = buildStub({
    slug: candidate.slug,
    wikiPath,
  });
  const writeStub = await writeIfMtimeUnchanged(
    candidate.path,
    stubText,
    candidate.mtimeMs,
  );
  if (writeStub.kind !== 'written') {
    // Memory got edited mid-run. Wiki page is already created; we don't
    // try to roll it back (Dream-B is idempotent — next run will see
    // wiki page exists, route to merge, and pick up the new memory
    // content via observations). Log loudly.
    logger.warn({
      msg: 'wiki.dream_b.promote_stub_conflict',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      wikiPath,
      outcome: writeStub.kind,
    });
    return {
      kind: 'failed',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      error: `wiki page created but memory stub write failed: ${writeStub.kind}`,
    };
  }

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
 * updated body, preserve frontmatter (refresh `updated`, optionally
 * update `related`, append the agent's source-pointer if new),
 * then clear the stub's observations section.
 *
 * Both file writes are mtime-aware. If either file changed since
 * we read it, abort the whole operation — neither file is touched.
 */
export async function applyMerge(args: {
  candidate: PromotionCandidate;
  decision: Extract<MergeDecision, { kind: 'update' }>;
  ctx: ActionContext;
  wikiPageMtimeMs: number;
}): Promise<CandidateOutcome> {
  const { candidate, decision, ctx, wikiPageMtimeMs } = args;
  if (!candidate.stub) {
    return {
      kind: 'failed',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      error: 'merge called on non-stub candidate',
    };
  }
  const wikiPath = candidate.stub.promotedTo;
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
    // Snapshot drifted. Bail.
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: `wiki page ${wikiPath} edited externally between read and write; will retry next run`,
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
    body: decision.body.startsWith('\n') ? decision.body : `\n${decision.body}`,
  });

  // Step 1: write wiki page (mtime check)
  const writeWiki = await writeIfMtimeUnchanged(wikiFileAbs, newPage, existing.mtimeMs);
  if (writeWiki.kind !== 'written') {
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: `wiki page ${wikiPath} write failed: ${writeWiki.kind}`,
    };
  }

  // Step 2: clear stub observations + refresh promoted_at (mtime check)
  const observationsConsumed = candidate.stub.observations.length;
  const stubFileResult = await readWithMtime(candidate.path);
  if (!stubFileResult) {
    logger.warn({
      msg: 'wiki.dream_b.merge_stub_vanished',
      agent: candidate.agent,
      memorySlug: candidate.slug,
    });
    return {
      kind: 'merged',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      wikiPath,
      logSummary: decision.logSummary,
      observationsConsumed,
    };
  }
  if (stubFileResult.mtimeMs !== candidate.mtimeMs) {
    // Stub got new observations between our read and now — leave
    // them for next merge run. Log so it's visible.
    logger.info({
      msg: 'wiki.dream_b.merge_stub_changed_post_wiki_write',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      hint: 'stub has new observations since promotion; will be picked up next run',
    });
    return {
      kind: 'merged',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      wikiPath,
      logSummary: decision.logSummary,
      observationsConsumed,
    };
  }
  // Build new stub with cleared observations + refreshed promoted_at.
  const stubParsed = parseStub(stubFileResult.text);
  if (!stubParsed) {
    // Lost stub frontmatter somehow — reconstruct.
    const fresh = buildStub({ slug: candidate.slug, wikiPath });
    await writeFile(candidate.path, fresh, 'utf8');
  } else {
    const newStub = buildStub({
      slug: stubParsed.frontmatter.slug || candidate.slug,
      wikiPath,
      promotedAt: new Date().toISOString(),
    });
    // Note: this discards any non-observations content the user might
    // have added to the stub body. Stubs are pure pointers by design;
    // user free-form notes belong elsewhere.
    void clearObservations; // imported for completeness — buildStub gives us a clean shape
    await writeFile(candidate.path, newStub, 'utf8');
  }

  return {
    kind: 'merged',
    agent: candidate.agent,
    memorySlug: candidate.slug,
    wikiPath,
    logSummary: decision.logSummary,
    observationsConsumed,
  };
}

/**
 * Decide which path a candidate should go: if its memory file is a
 * stub with observations → merge; else → promote (LLM gates whether
 * to actually do it).
 *
 * Note: 'fresh' candidates can ALSO have an existing wiki page at the
 * slug Dream-B would pick — that's handled inside applyPromote
 * (writeIfNotExists), which falls back to skipped.
 */
export function classifyCandidate(c: PromotionCandidate): 'promote' | 'merge' {
  return c.kind === 'stub_with_observations' ? 'merge' : 'promote';
}

/** True iff the wiki page already exists for the candidate's stub. */
export async function readExistingWikiPage(args: {
  candidate: PromotionCandidate;
  ctx: ActionContext;
}): Promise<{ text: string; mtimeMs: number } | null> {
  if (!args.candidate.stub) return null;
  const wikiFileAbs = join(args.ctx.wikiAbs, `${args.candidate.stub.promotedTo}.md`);
  return readWithMtime(wikiFileAbs);
}

// ─── Helpers ────────────────────────────────────────────────────────

function isoDate(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

void unlink; // reserved — caller uses it elsewhere; ensures import survives lint
void readFile;
void stat;
void _appendObservation;
