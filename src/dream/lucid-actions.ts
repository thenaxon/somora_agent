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
import type { ResolvedModel, ThinkingLevel } from '../config/types.ts';
import type { WikiLanguage } from '../wiki/language.ts';
import { readFile, stat } from 'node:fs/promises';
import { archivePage, parseUniteReply, relinkWiki, reportsFolder, uniteSystemPrompt, uniteUserMessage } from '../wiki/migration/execute.ts';
import { movePage } from '../wiki/move-page.ts';
import { callOneShotLLM } from './deep-llm.ts';

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
  /** Needed by unite_pages (the merged body is written by a model) and
   *  move_page (the target folder is checked against the map). */
  language?: WikiLanguage;
  model?: ResolvedModel;
  thinking?: ThinkingLevel;
  /** Test seam: replaces the model call. */
  ask?: (args: { system: string; user: string }) => Promise<string>;
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
    case 'add_link':
      return applyAddLink(fix, ctx);
    case 'unite_pages':
      return applyUnitePages(fix, ctx);
    case 'move_page':
      return applyMovePage(fix, ctx);
  }
}

// ─── add_link ───────────────────────────────────────────────────────

/**
 * Turn the first plain mention of `phrase` into [[target|phrase]].
 * Plain means: not inside an existing [[link]], not in a heading, not
 * in a code fence or inline code, not in the frontmatter. Returns null
 * when there is no such mention. Exported for tests.
 */
export function addLinkToBody(body: string, phrase: string, target: string): string | null {
  const lines = body.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*#/.test(line)) continue;
    // Mask what must not be touched, then search the mask for the phrase.
    const masked = line
      .replace(/\[\[[^\]]*\]\]/g, (m) => ' '.repeat(m.length))
      .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
      .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => ' '.repeat(m.length));
    const at = masked.indexOf(phrase);
    if (at < 0) continue;
    // Whole words only: no letter or digit glued to either side.
    const before = at > 0 ? line[at - 1]! : ' ';
    const after = at + phrase.length < line.length ? line[at + phrase.length]! : ' ';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
    const link = target.split('/').pop() === phrase ? `[[${target}]]` : `[[${target}|${phrase}]]`;
    lines[i] = line.slice(0, at) + link + line.slice(at + phrase.length);
    return lines.join('\n');
  }
  return null;
}

async function applyAddLink(fix: Extract<LucidFinding['fix'], { kind: 'add_link' }>, ctx: LucidActionContext): Promise<LucidApplyOutcome> {
  const file = join(ctx.wikiAbs, `${fix.wikiPath}.md`);
  const targetExists = await stat(join(ctx.wikiAbs, `${fix.target}.md`)).then((s) => s.isFile(), () => false);
  if (!targetExists) return { kind: 'skipped', reason: `target page ${fix.target} does not exist` };
  const existing = await readWithMtime(file);
  if (!existing) return { kind: 'skipped', reason: `page ${fix.wikiPath} does not exist` };
  const page = parseWikiPage(existing.text);
  if (new RegExp(`\\[\\[${fix.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\||#|\\]\\])`, 'i').test(page.body)) {
    return { kind: 'skipped', reason: `${fix.wikiPath} already links ${fix.target}` };
  }
  const next = addLinkToBody(page.body, fix.phrase, fix.target);
  if (next === null) return { kind: 'skipped', reason: `phrase "${fix.phrase}" not found as plain text in ${fix.wikiPath}` };
  page.body = next;
  page.frontmatter.updated = isoDate();
  const res = await writeIfMtimeUnchanged(file, buildWikiPage(page), existing.mtimeMs);
  if (res.kind !== 'written') return { kind: 'failed', error: `${fix.wikiPath} changed on disk while linking` };
  logger.info({ msg: 'dream.lucid.link_added', wikiPath: fix.wikiPath, target: fix.target, phrase: fix.phrase });
  return { kind: 'applied', detail: `linked "${fix.phrase}" in ${fix.wikiPath} to ${fix.target}` };
}

// ─── unite_pages ────────────────────────────────────────────────────

async function applyUnitePages(fix: Extract<LucidFinding['fix'], { kind: 'unite_pages' }>, ctx: LucidActionContext): Promise<LucidApplyOutcome> {
  const language = ctx.language ?? 'de';
  const ask = ctx.ask ?? (ctx.model
    ? async (a: { system: string; user: string }) => callOneShotLLM({ workerModel: ctx.model!, systemPrompt: a.system, userMessage: a.user, timeoutMs: 240_000, logCtx: { op: 'lucid-unite', keep: fix.keep }, ...(ctx.thinking ? { thinking: ctx.thinking } : {}) })
    : null);
  if (!ask) return { kind: 'failed', error: 'unite_pages needs a model (wiki.lucid.model)' };
  const keepFile = join(ctx.wikiAbs, `${fix.keep}.md`);
  const keepRaw = await readWithMtime(keepFile);
  if (!keepRaw) return { kind: 'skipped', reason: `surviving page ${fix.keep} does not exist` };
  const drops: Array<{ path: string; raw: string }> = [];
  for (const d of fix.drop) {
    try {
      drops.push({ path: d, raw: await readFile(join(ctx.wikiAbs, `${d}.md`), 'utf8') });
    } catch {
      /* already gone */
    }
  }
  if (drops.length === 0) return { kind: 'skipped', reason: 'none of the other pages exists any more' };
  const reply = await ask({ system: uniteSystemPrompt(language), user: uniteUserMessage(fix.keep, keepRaw.text, drops) });
  const body = parseUniteReply(reply);
  if (!body) return { kind: 'failed', error: 'model reply unreadable' };
  const page = parseWikiPage(keepRaw.text);
  if (body.length < Math.min(page.body.length, 2000) * 0.5) return { kind: 'failed', error: `merged body suspiciously short (${body.length} chars for a ${page.body.length}-char page)` };
  page.body = body.startsWith('\n') ? body : `\n${body}`;
  page.frontmatter.updated = isoDate();
  page.frontmatter.sources = [...new Set([...(page.frontmatter.sources ?? []), ...drops.map((d) => `wiki:${d.path}`)])];
  const res = await writeIfMtimeUnchanged(keepFile, buildWikiPage(page), keepRaw.mtimeMs);
  if (res.kind !== 'written') return { kind: 'failed', error: `${fix.keep} changed on disk while uniting` };
  const renames = new Map<string, string>();
  const vanished = new Map<string, string>();
  for (const d of drops) {
    await archivePage(ctx.wikiAbs, reportsFolder(language), d.path, d.raw, fix.keep, isoDate());
    await unlink(join(ctx.wikiAbs, `${d.path}.md`));
    renames.set(d.path, fix.keep);
    vanished.set(d.path.split('/').pop()!.toLowerCase(), fix.keep);
  }
  const linked = await relinkWiki(ctx.wikiAbs, renames, vanished);
  logger.info({ msg: 'dream.lucid.pages_united', keep: fix.keep, drop: drops.map((d) => d.path), ...linked });
  return { kind: 'applied', detail: `united ${drops.map((d) => d.path).join(', ')} into ${fix.keep} (archived under ${reportsFolder(language)}/, ${linked.refs} references repointed)` };
}

// ─── move_page ──────────────────────────────────────────────────────

async function applyMovePage(fix: Extract<LucidFinding['fix'], { kind: 'move_page' }>, ctx: LucidActionContext): Promise<LucidApplyOutcome> {
  try {
    const r = await movePage({ wikiAbs: ctx.wikiAbs, language: ctx.language ?? 'de', from: fix.from, to: fix.to });
    logger.info({ msg: 'dream.lucid.page_moved', ...r });
    return { kind: 'applied', detail: `moved ${r.from} → ${r.to} (${r.linksRewritten} references repointed)` };
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message };
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
