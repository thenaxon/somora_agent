// Apply functions for Lint findings (Phase 4 / Stufe 5).
//
// Each LintFinding kind has a corresponding apply-function that
// performs the fix. All writes are mtime-aware via writeIfMtimeUnchanged
// so a user-edit during the apply window aborts safely.
//
// User flow: dream_apply({id, finding_id}) → look up the LintFinding
// in the LintRun, dispatch on kind to one of these functions.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '../server/logger.ts';
import { readWithMtime, writeIfMtimeUnchanged } from './conflict.ts';
import type { LintFinding } from './lint-types.ts';
import { regenerateIndex } from './index-builder.ts';

export interface ApplyContext {
  wikiAbs: string;
}

export type ApplyOutcome =
  | { kind: 'applied'; description: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; error: string };

/** Dispatch on finding.kind to the right apply function. */
export async function applyLintFinding(
  finding: LintFinding,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  switch (finding.kind) {
    case 'broken_wikilink':
      return applyBrokenWikilink(finding, ctx);
    case 'orphan_page':
      return applyOrphanPage(finding, ctx);
    case 'index_missing':
    case 'index_stale':
      return applyIndexFix(ctx);
    case 'one_way_link':
      return applyOneWayLink(finding, ctx);
    default:
      // Exhaustive — TS will flag missing cases.
      return assertNever(finding);
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable lint finding kind: ${JSON.stringify(x)}`);
}

// ─── broken_wikilink ─────────────────────────────────────────────────
//
// Replace `[[broken_target]]` with `[[suggested_target]]` (when the
// suggestion exists). If no suggestion: skip with a clear reason —
// the user has to decide manually whether to remove or what to
// replace it with.

async function applyBrokenWikilink(
  finding: import('./lint-types.ts').BrokenWikilinkFinding,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  if (!finding.suggested_target) {
    return {
      kind: 'skipped',
      reason: 'no replacement target suggested — fix manually or dismiss',
    };
  }
  const pagePath = join(ctx.wikiAbs, `${finding.in_page}.md`);
  const existing = await readWithMtime(pagePath);
  if (!existing) {
    return { kind: 'failed', error: `page ${finding.in_page} no longer exists` };
  }
  // Replace ALL occurrences of [[broken_target]] (or with display text)
  // with [[suggested_target]]. Keeps the original optional |display.
  const re = new RegExp(
    `\\[\\[${escapeRegex(finding.broken_target)}(\\|[^\\]]+)?\\]\\]`,
    'g',
  );
  const updated = existing.text.replace(re, `[[${finding.suggested_target}]]`);
  if (updated === existing.text) {
    return {
      kind: 'skipped',
      reason: 'page text already differs from finding (link may have been fixed manually)',
    };
  }
  const result = await writeIfMtimeUnchanged(pagePath, updated, existing.mtimeMs);
  if (result.kind !== 'written') {
    return { kind: 'skipped', reason: `mtime check failed: ${result.kind}` };
  }
  logger.info({
    msg: 'dream.lucid.applied.broken_wikilink',
    page: finding.in_page,
    from: finding.broken_target,
    to: finding.suggested_target,
  });
  return {
    kind: 'applied',
    description: `Replaced [[${finding.broken_target}]] → [[${finding.suggested_target}]] in ${finding.in_page}`,
  };
}

// ─── orphan_page ─────────────────────────────────────────────────────
//
// User has confirmed the page is dead — delete it. Index regen at end
// of run picks up the removal automatically. No mtime-check on the
// rm itself: if the file has changed since we read it, the user may
// have brought it back to life — better to skip than to delete content.

async function applyOrphanPage(
  finding: import('./lint-types.ts').OrphanPageFinding,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  const pagePath = join(ctx.wikiAbs, `${finding.page}.md`);
  const existing = await readWithMtime(pagePath);
  if (!existing) {
    return { kind: 'skipped', reason: `${finding.page} already gone` };
  }
  // Conservative: only delete if the file is "small enough" to plausibly
  // be a stub or short orphan. This avoids accidentally nuking a page
  // the user just expanded and forgot to add to index. Threshold = 4kb
  // (a substantial page would normally be larger).
  if (existing.text.length > 4096) {
    return {
      kind: 'skipped',
      reason: `${finding.page} is ${existing.text.length} chars (>4kb) — too large to auto-delete; review manually`,
    };
  }
  await rm(pagePath);
  logger.info({ msg: 'dream.lucid.applied.orphan_page', page: finding.page });
  return {
    kind: 'applied',
    description: `Deleted orphan page ${finding.page}.md`,
  };
}

// ─── index_missing / index_stale ─────────────────────────────────────
//
// Both kinds get fixed by regenerating index.md from the current
// wiki tree. We don't surgically patch — full regen is cheaper to
// reason about and keeps the file consistent. This means: applying
// the FIRST index-finding fixes ALL of them in one shot.

let indexRegenLast: Map<string, number> = new Map();

async function applyIndexFix(ctx: ApplyContext): Promise<ApplyOutcome> {
  // Avoid running regenerateIndex multiple times within the same lint
  // apply session (user clicks dream_apply on multiple index findings).
  // The regen reads the wiki tree fresh each time so it's idempotent,
  // but we don't need to do it 6 times if 6 index findings were
  // approved at once.
  const now = Date.now();
  const last = indexRegenLast.get(ctx.wikiAbs) ?? 0;
  if (now - last < 2_000) {
    return {
      kind: 'skipped',
      reason: 'index already regenerated in this run',
    };
  }
  await regenerateIndex({ wikiAbs: ctx.wikiAbs, recentUpdates: [] });
  indexRegenLast.set(ctx.wikiAbs, now);
  logger.info({ msg: 'dream.lucid.applied.index_fix', wikiAbs: ctx.wikiAbs });
  return { kind: 'applied', description: 'Regenerated index.md from current wiki tree' };
}

// ─── one_way_link ────────────────────────────────────────────────────
//
// Add a `[[from_page]]` reference in to_page. We append it to the
// "## Verwandtes" / "## Notizen" section if one exists, else add a
// new "## Verwandtes" section at the end. Conservative: never modifies
// existing prose, only appends.

async function applyOneWayLink(
  finding: import('./lint-types.ts').OneWayLinkFinding,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  const pagePath = join(ctx.wikiAbs, `${finding.to_page}.md`);
  const existing = await readWithMtime(pagePath);
  if (!existing) {
    return { kind: 'failed', error: `${finding.to_page} no longer exists` };
  }
  const linkText = `\n- [[${finding.from_page}]] — back-reference added by Dream-C\n`;
  const headings = ['## Verwandtes', '## Notizen', '## Eigenschaften'];
  let updated: string | null = null;
  for (const h of headings) {
    const idx = existing.text.indexOf(h);
    if (idx === -1) continue;
    // Append at end of the section, before the next "## " or EOF
    const after = existing.text.slice(idx + h.length);
    const nextHeading = after.search(/\n## /);
    const insertAt = nextHeading >= 0 ? idx + h.length + nextHeading : existing.text.length;
    updated = existing.text.slice(0, insertAt) + linkText + existing.text.slice(insertAt);
    break;
  }
  if (!updated) {
    // No existing section to slot into — append a new "Verwandtes"
    // block at the very end.
    const sep = existing.text.endsWith('\n') ? '' : '\n';
    updated = `${existing.text}${sep}\n## Verwandtes\n${linkText}`;
  }
  const result = await writeIfMtimeUnchanged(pagePath, updated, existing.mtimeMs);
  if (result.kind !== 'written') {
    return { kind: 'skipped', reason: `mtime check failed: ${result.kind}` };
  }
  logger.info({
    msg: 'dream.lucid.applied.one_way_link',
    from: finding.from_page,
    to: finding.to_page,
  });
  return {
    kind: 'applied',
    description: `Added [[${finding.from_page}]] back-reference in ${finding.to_page}`,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
