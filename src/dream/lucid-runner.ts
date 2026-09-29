// Lucid single-run orchestrator. Walks wiki BY SUBFOLDER, sends each
// subfolder to Opus with the Lucid system prompt, parses findings,
// then does one cross-subfolder pass with index + page-headers only
// to catch findings that span multiple subfolders.
//
// Why per-subfolder (not single-pass over the whole wiki):
//   1. claude-agent-sdk uses stream-json input — single user message
//      becomes one JSON line on stdin. Claude-cli's line-parser fails
//      on lines > ~50KB (verified: 178KB single-pass aborts in 800ms
//      with "Error parsing streaming input line"). Per-subfolder
//      batches stay under the limit.
//   2. Better focus: Opus reads each subfolder's pages with full
//      attention, less "this page is buried among 70 others" effect.
//      Higher quality findings per call.
//   3. Scales: works for 70 pages and 700 pages alike. For very-
//      large wikis the design later (v2.7+) will add hierarchical
//      clustering inside subfolders.
//
// Output: a LucidRun written to ~/.somora/wiki-lucid/<id>.json that
// the dream tools (dream_list/get/apply/dismiss) surface to the user
// for approval.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config, ResolvedModel } from '../config/types.ts';
import { resolveAnyRef } from '../config/types.ts';
import { resolveObsidianSource } from '../memory/registry.ts';
import { logger } from '../server/logger.ts';
import { callOneShotLLM } from './deep-llm.ts';
import { buildLucidSystemPrompt } from './lucid-prompt.ts';
import { resolveWikiSchema } from '../wiki/language.ts';
import { setRunStatus, writeLucidRun } from './lucid-storage.ts';
import { batchLabel, pageOpening, planLucidBatches, siblingList, type LucidPage } from './lucid-batches.ts';
import { capFindings, structuralFindings } from './lucid-structure.ts';
import { buildWikiMap } from '../wiki/map.ts';
import { loadStructureFile } from '../wiki/structure-file.ts';
import { firstCompleteJson } from './json-salvage.ts';
import type {
  LucidFinding,
  LucidFindingKind,
  LucidFix,
  LucidRun,
} from './lucid-types.ts';

export interface RunLucidArgs {
  config: Config;
  trigger: 'auto' | 'manual';
  signal?: AbortSignal;
}

export interface RunLucidResult {
  runId: string;
  findingsCount: number;
  pagesScanned: number;
  durationMs: number;
  status: LucidRun['status'];
}

export async function runLucid(args: RunLucidArgs): Promise<RunLucidResult> {
  const start = Date.now();
  const id = makeRunId(args.trigger);

  // Resolve worker model.
  const ref = args.config.wiki.lucid.model;
  if (!ref) {
    return failedRun(id, args.trigger, start, 0, 'no worker model configured for lucid');
  }
  const workerModel = resolveAnyRef(args.config, ref);
  if (!workerModel) {
    return failedRun(id, args.trigger, start, 0, `worker model '${ref}' did not resolve`);
  }
  const thinking = args.config.wiki.lucid.thinking;
  let lucidPrompt = buildLucidSystemPrompt(resolveWikiSchema(args.config.wiki));

  // Resolve wiki root.
  const obs = resolveObsidianSource(args.config.obsidian);
  if (!obs?.vaultPath) {
    return failedRun(id, args.trigger, start, 0, 'no vault configured');
  }
  const wikiAbs = join(obs.vaultPath, args.config.wiki.vaultSubfolder);

  // Load every page, then cut into calls by size (lucid-batches.ts).
  const { bySubfolder, pagesScanned } = await loadWikiBySubfolder(wikiAbs);
  const allPages: LucidPage[] = [...bySubfolder.values()].flat();

  if (pagesScanned === 0) {
    return failedRun(id, args.trigger, start, 0, 'wiki is empty — no pages to lucid-scan');
  }

  // What every call sees beside its pages: the wiki map (folders, what
  // lives in each, page counts) instead of the whole index.md — the
  // index of a thousand-page wiki is 70 KB on its own.
  const language = args.config.wiki.language ?? 'de';
  const structure = await loadStructureFile(wikiAbs, language);
  const map = await buildWikiMap({ wikiAbs, language, structure });
  const migrated = structure.template_version > 0;
  lucidPrompt = buildLucidSystemPrompt(resolveWikiSchema(args.config.wiki), { migrated });
  const batches = planLucidBatches(allPages, args.config.wiki.lucid.batchChars);

  logger.info({
    msg: 'dream.lucid.start',
    id,
    trigger: args.trigger,
    pagesScanned,
    folders: bySubfolder.size,
    batches: batches.length,
    batchChars: args.config.wiki.lucid.batchChars,
    largest: Math.max(...batches.map((b) => b.chars)),
    migrated,
    templateVersion: structure.template_version,
    workerModel: `${workerModel.providerName}/${workerModel.modelId}`,
  });

  // Persist a running record so failures leave a trace.
  const run: LucidRun = {
    id,
    status: 'running',
    created_at: new Date(start).toISOString(),
    trigger: args.trigger,
    pages_scanned: pagesScanned,
    worker_model_ref: `${workerModel.providerName}/${workerModel.modelId}`,
    findings: [],
  };
  await writeLucidRun(run);

  const allFindings: LucidFinding[] = [];
  let nextId = 1;
  // Structure: facts of the file system, no model needed — or the one
  // hint that the template is not applied here.
  for (const f of structuralFindings(allPages, { migrated, templateVersion: structure.template_version, oversizedChars: args.config.wiki.lucid.oversizedChars }, nextId)) {
    allFindings.push(f);
    nextId = f.id + 1;
  }
  // Coverage. A batch counts as failed when the LLM call errored OR its
  // answer was unreadable — both used to vanish into "0 findings,
  // completed", so a worker that was down for the whole run looked like
  // a clean wiki until the next run a week later.
  let batchesTotal = 0;
  let batchesFailed = 0;
  let aborted = false;

  // ─── Per-batch pass ────────────────────────────────────────────────
  for (const batch of batches) {
    if (args.signal?.aborted) {
      aborted = true;
      break;
    }
    batchesTotal++;
    const subfolder = batchLabel(batch);
    const userMsg = buildBatchUserMessage(map.text, batch, allPages);
    logger.info({
      msg: 'dream.lucid.llm_request',
      id,
      subfolder,
      pagesInBatch: batch.pages.length,
      batchChars: batch.chars,
      messageChars: userMsg.length,
      estimatedTokensIn: Math.ceil((lucidPrompt.length + userMsg.length) / 4),
    });
    let llmText: string;
    try {
      llmText = await callOneShotLLM({
        workerModel,
        systemPrompt: lucidPrompt,
        userMessage: userMsg,
        timeoutMs: 600_000,
        ...(args.signal ? { signal: args.signal } : {}),
        ...(thinking ? { thinking } : {}),
        logCtx: { agent: 'lucid', op: `subfolder:${subfolder}`, slug: id },
      });
    } catch (err) {
      logger.warn({
        msg: 'dream.lucid.subfolder_failed',
        id,
        subfolder,
        err: (err as Error).message,
      });
      if (args.signal?.aborted) {
        aborted = true;
        break;
      }
      batchesFailed++;
      continue; // partial results — proceed with other subfolders
    }
    const subFindings = parseLucidFindings(llmText, `${id}:${subfolder}`, { migrated });
    if (subFindings === null) {
      batchesFailed++;
      continue;
    }
    for (const f of subFindings) {
      allFindings.push({ ...f, id: nextId++ });
    }
  }

  // ─── Cross-subfolder pass (headers only) ──────────────────────────
  // Catches findings that span subfolders without re-sending all bodies.
  if (args.signal?.aborted) aborted = true;
  if (!aborted && bySubfolder.size > 1) {
    batchesTotal++;
    const userMsg = buildCrossSubfolderUserMessage(map.text, bySubfolder, args.config.wiki.lucid.batchChars * 2);
    logger.info({
      msg: 'dream.lucid.llm_request',
      id,
      subfolder: '(cross)',
      messageChars: userMsg.length,
      estimatedTokensIn: Math.ceil((lucidPrompt.length + userMsg.length) / 4),
    });
    try {
      const llmText = await callOneShotLLM({
        workerModel,
        systemPrompt: lucidPrompt,
        userMessage: userMsg,
        timeoutMs: 600_000,
        ...(args.signal ? { signal: args.signal } : {}),
        ...(thinking ? { thinking } : {}),
        logCtx: { agent: 'lucid', op: 'cross', slug: id },
      });
      const xFindings = parseLucidFindings(llmText, `${id}:cross`, { migrated });
      if (xFindings === null) batchesFailed++;
      for (const f of xFindings ?? []) {
        allFindings.push({ ...f, id: nextId++ });
      }
    } catch (err) {
      if (args.signal?.aborted) aborted = true;
      else batchesFailed++;
      logger.warn({
        msg: 'dream.lucid.cross_pass_failed',
        id,
        err: (err as Error).message,
      });
    }
  }

  const capped = capFindings(allFindings, args.config.wiki.lucid.maxFindings);
  if (Object.keys(capped.dropped).length > 0 || capped.duplicates > 0) {
    logger.info({ msg: 'dream.lucid.run_capped', id, found: allFindings.length, kept: capped.kept.length, duplicates: capped.duplicates, dropped: capped.dropped, maxFindings: args.config.wiki.lucid.maxFindings });
  }
  run.findings = capped.kept.map((f, i) => ({ ...f, id: i + 1 }));
  run.batches_total = batchesTotal;
  run.batches_failed = batchesFailed;

  // Failed ≠ empty. An aborted run, or one where no batch produced a
  // readable answer, audited nothing — it must not be booked as a
  // completed run with zero findings. Partial findings stay in the run
  // file for audit. A run where SOME batches failed is still reviewable
  // and completes; the counters say how much of the wiki it covered.
  const nothingRead = batchesTotal > 0 && batchesFailed === batchesTotal;
  if (aborted || nothingRead) {
    const error = aborted
      ? `aborted after ${batchesTotal - batchesFailed} readable of ${batchesTotal} started batch(es) — wiki not fully audited`
      : `all ${batchesTotal} batch(es) failed (worker error or unreadable answer) — wiki not audited`;
    setRunStatus(run, 'failed', error);
    await writeLucidRun(run);
    logger.error({
      msg: 'dream.lucid.failed',
      id,
      error,
      aborted,
      batchesTotal,
      batchesFailed,
      partialFindings: allFindings.length,
    });
    return {
      runId: id,
      findingsCount: allFindings.length,
      pagesScanned,
      durationMs: Date.now() - start,
      status: 'failed',
    };
  }
  if (batchesFailed > 0) {
    logger.warn({ msg: 'dream.lucid.partial_coverage', id, batchesTotal, batchesFailed });
  }
  setRunStatus(run, 'completed');
  await writeLucidRun(run);

  logger.info({
    msg: 'dream.lucid.done',
    id,
    trigger: args.trigger,
    findingsCount: allFindings.length,
    pagesScanned,
    batchesTotal,
    batchesFailed,
    durationMs: Date.now() - start,
    byKind: countByKind(allFindings),
  });

  return {
    runId: id,
    findingsCount: allFindings.length,
    pagesScanned,
    durationMs: Date.now() - start,
    status: 'completed',
  };
}

function failedRun(
  id: string,
  trigger: 'auto' | 'manual',
  start: number,
  pagesScanned: number,
  error: string,
): RunLucidResult {
  logger.error({ msg: 'dream.lucid.failed', id, error });
  const run: LucidRun = {
    id,
    status: 'failed',
    created_at: new Date(start).toISOString(),
    trigger,
    pages_scanned: pagesScanned,
    worker_model_ref: '',
    findings: [],
    error,
  };
  void writeLucidRun(run).catch(() => {});
  return {
    runId: id,
    findingsCount: 0,
    pagesScanned,
    durationMs: Date.now() - start,
    status: 'failed',
  };
}

// ─── wiki loading ───────────────────────────────────────────────────

async function loadWikiBySubfolder(wikiAbs: string): Promise<{
  bySubfolder: Map<string, Array<{ wikiPath: string; markdown: string }>>;
  pagesScanned: number;
}> {
  const bySubfolder = new Map<string, Array<{ wikiPath: string; markdown: string }>>();
  let total = 0;

  let topLevel;
  try {
    topLevel = await readdir(wikiAbs, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { bySubfolder, pagesScanned: 0 };
    }
    throw err;
  }

  for (const e of topLevel) {
    if (e.name.startsWith('.') || e.name === 'logs' || e.name === 'index.md' || e.name.startsWith('_')) continue;
    if (e.isDirectory()) {
      const subfolder = e.name;
      const pages: Array<{ wikiPath: string; markdown: string }> = [];
      await walkPages(wikiAbs, subfolder, pages);
      if (pages.length > 0) {
        bySubfolder.set(subfolder, pages);
        total += pages.length;
      }
    } else if (e.isFile() && e.name.endsWith('.md')) {
      // Pages in the wiki root — a grown wiki has them.
      try {
        const md = await readFile(join(wikiAbs, e.name), 'utf8');
        const list = bySubfolder.get('(root)') ?? [];
        list.push({ wikiPath: e.name.replace(/\.md$/, ''), markdown: md });
        bySubfolder.set('(root)', list);
        total++;
      } catch (err) {
        logger.warn({ msg: 'dream.lucid.page_unreadable', path: join(wikiAbs, e.name), err: (err as Error).message });
      }
    }
  }

  return { bySubfolder, pagesScanned: total };
}

async function walkPages(
  rootAbs: string,
  relPath: string,
  out: Array<{ wikiPath: string; markdown: string }>,
): Promise<void> {
  const dir = join(rootAbs, relPath);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const sub = `${relPath}/${e.name}`;
    if (e.isDirectory()) {
      await walkPages(rootAbs, sub, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      const full = join(rootAbs, sub);
      try {
        const md = await readFile(full, 'utf8');
        const wikiPath = sub.replace(/\.md$/, '');
        out.push({ wikiPath, markdown: md });
      } catch (err) {
        logger.warn({
          msg: 'dream.lucid.page_unreadable',
          path: full,
          err: (err as Error).message,
        });
      }
    }
  }
}

// ─── prompt-building ────────────────────────────────────────────────

/** Exported for tests. */
export function buildBatchUserMessage(mapText: string, batch: import('./lucid-batches.ts').LucidBatch, all: LucidPage[]): string {
  const pageBlocks = batch.pages
    .map((p) => `<wiki_page slug="${p.wikiPath}">\n${p.markdown.trim()}\n</wiki_page>`)
    .join('\n\n');
  const siblings = siblingList(batch, all);
  return [
    `Folder under review: ${batch.folder}/${batch.of > 1 ? ` — part ${batch.part} of ${batch.of}` : ''}`,
    `Pages in this part: ${batch.pages.length}`,
    'Focus your findings on issues WITHIN these pages. Issues that span',
    'folders will be checked in a separate pass — do not surface them here.',
    '',
    mapText,
    '',
    ...(siblings ? [`<sibling_pages folder="${batch.folder === '(root)' ? '(root)' : batch.folder.split('/')[0]}">`, siblings, '</sibling_pages>', ''] : []),
    pageBlocks,
  ].join('\n');
}

/** Exported for tests. Headers only; `maxChars` shortens the openings
 *  when a thousand pages would not fit. */
export function buildCrossSubfolderUserMessage(
  mapText: string,
  bySubfolder: Map<string, Array<{ wikiPath: string; markdown: string }>>,
  maxChars = 200_000,
): string {
  // Headers + first-section summary per page; not full bodies. This
  // pass catches contradictions / wanted_pages / dead_refs that span
  // subfolders without re-shipping all bodies.
  const build = (chars: number): string => {
    const summaryBlocks: string[] = [];
    for (const [subfolder, pages] of bySubfolder) {
      const lines: string[] = [`### ${subfolder}/`];
      for (const p of pages) lines.push(`- [[${p.wikiPath}]] — ${pageOpening(p.markdown, chars)}`);
      summaryBlocks.push(lines.join('\n'));
    }
    return summaryBlocks.join('\n\n');
  };
  let summaries = build(200);
  for (const chars of [120, 80, 40]) {
    if (summaries.length + mapText.length <= maxChars) break;
    summaries = build(chars);
  }
  return [
    `Cross-subfolder pass — ${bySubfolder.size} subfolders, page-headers only.`,
    'Look for findings that span MULTIPLE subfolders: contradictions where',
    'two pages in different subfolders disagree, wanted_pages where multiple',
    'subfolders reference a missing slug, etc. Single-subfolder issues were',
    'covered in a previous pass — skip them.',
    '',
    'OUTPUT FORMAT: Same JSON schema as before — exactly one JSON object',
    'with a "findings" array. No prose, no narration, no commentary.',
    'If no cross-subfolder findings, return {"findings": []}.',
    '',
    mapText,
    '',
    '<page_headers>',
    summaries,
    '</page_headers>',
  ].join('\n');
}

function extractFirstSection(markdown: string): string {
  // Strip frontmatter, take first ~200 chars of body.
  let body = markdown;
  if (body.startsWith('---\n')) {
    const fmEnd = body.indexOf('\n---\n', 4);
    if (fmEnd >= 0) body = body.slice(fmEnd + 5);
  }
  // Skip H1 if present.
  const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('# '));
  const text = lines.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

// ─── parsing ────────────────────────────────────────────────────────

/** Active finding kinds — only these are produced by current Lucid prompt
 *  and accepted by the parser. Legacy kinds (stale_claim, outdated,
 *  inconsistent_xref) remain in LucidFindingKind for archive compat
 *  but no longer round-trip through the LLM call. */
const VALID_KINDS = new Set<LucidFindingKind>([
  'contradiction',
  'dead_ref',
  'wanted_page',
  'link_suggestion',
  'duplicate_page',
  'misfiled_page',
]);

/** Kinds the model may only produce in a wiki on the template. */
const STRUCTURE_KINDS = new Set<LucidFindingKind>(['misfiled_page']);

/** Hard cap matching the prompt instruction. If the LLM emits more we
 *  truncate to keep the user-review surface manageable. */
const MAX_FINDINGS_PER_RUN = 8;

function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const fenceEnd = text.lastIndexOf('```');
    if (fenceEnd > 0) {
      text = text.slice(text.indexOf('\n') + 1, fenceEnd).trim();
    }
  }
  return text;
}

/** null = the answer was unreadable (not JSON, or no `findings` array);
 *  the caller counts the batch as failed. [] = a readable "nothing found". */
export function parseLucidFindings(raw: string, runId: string, opts: { migrated?: boolean } = { migrated: true }): LucidFinding[] | null {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // A complete object with a sentence after it is still an answer
    // (both parse failures in the live logs up to 2026-09-21 had this
    // shape). A cut-off or broken object is not.
    const candidate = firstCompleteJson(text, '{');
    let recovered: unknown;
    if (candidate !== null) {
      try {
        recovered = JSON.parse(candidate);
      } catch {
        recovered = undefined;
      }
    }
    if (recovered === undefined) {
      logger.warn({
        msg: 'dream.lucid.parse_failed',
        runId,
        err: (err as Error).message,
        sample: text.slice(0, 300),
      });
      return null;
    }
    logger.info({ msg: 'dream.lucid.answer_recovered', runId, droppedChars: text.length - candidate!.length });
    parsed = recovered;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).findings)) {
    logger.warn({ msg: 'dream.lucid.parse_failed', runId, err: 'no findings array in answer', sample: text.slice(0, 300) });
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const list = obj.findings as unknown[];
  const out: LucidFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const kind = f.kind;
    if (typeof kind !== 'string' || !VALID_KINDS.has(kind as LucidFindingKind)) continue;
    if (!opts.migrated && STRUCTURE_KINDS.has(kind as LucidFindingKind)) continue;
    const reason = typeof f.reason === 'string' ? f.reason : '';
    if (!reason) continue;
    const affectedPages = Array.isArray(f.affected_pages)
      ? f.affected_pages.filter((p): p is string => typeof p === 'string')
      : [];
    // Current Lucid output is description-only — every finding becomes
    // a `no_op` fix. The user walks through findings via dream_review
    // and writes any actual changes through the loop-scoped wiki_*
    // tools. Legacy fix shapes (update_page etc.) are still parsed if
    // present so old archived runs continue to render correctly, but
    // current runs default to no_op.
    const fix: LucidFix = parseFix(f.fix) ?? {
      kind: 'no_op',
      note: reason,
    };
    out.push({
      id: out.length + 1,
      kind: kind as LucidFindingKind,
      status: 'pending',
      affected_pages: affectedPages,
      reason,
      fix,
    });
    if (out.length >= MAX_FINDINGS_PER_RUN) {
      logger.info({
        msg: 'dream.lucid.findings_capped',
        runId,
        cap: MAX_FINDINGS_PER_RUN,
        emittedByModel: list.length,
      });
      break;
    }
  }
  return out;
}

function parseFix(raw: unknown): LucidFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  switch (f.kind) {
    case 'update_page': {
      const wikiPath = typeof f.wikiPath === 'string' ? f.wikiPath : '';
      const newBody = typeof f.newBody === 'string' ? f.newBody : '';
      const logSummary = typeof f.logSummary === 'string' ? f.logSummary : '';
      if (!wikiPath || !newBody || !logSummary) return null;
      return { kind: 'update_page', wikiPath, newBody, logSummary };
    }
    case 'create_page': {
      const subfolder = typeof f.subfolder === 'string' ? f.subfolder : '';
      const wikiPath = typeof f.wikiPath === 'string' ? f.wikiPath : '';
      const type = typeof f.type === 'string' ? f.type : '';
      const title = typeof f.title === 'string' ? f.title : '';
      const body = typeof f.body === 'string' ? f.body : '';
      const logSummary = typeof f.logSummary === 'string' ? f.logSummary : '';
      if (!subfolder || !wikiPath || !type || !title || !body || !logSummary) return null;
      const related = Array.isArray(f.related)
        ? f.related.filter((r): r is string => typeof r === 'string')
        : undefined;
      return {
        kind: 'create_page',
        subfolder,
        wikiPath,
        type,
        title,
        body,
        logSummary,
        ...(related && related.length > 0 ? { related } : {}),
      };
    }
    case 'delete_page': {
      const wikiPath = typeof f.wikiPath === 'string' ? f.wikiPath : '';
      const logSummary = typeof f.logSummary === 'string' ? f.logSummary : '';
      if (!wikiPath || !logSummary) return null;
      return { kind: 'delete_page', wikiPath, logSummary };
    }
    case 'no_op': {
      const note = typeof f.note === 'string' ? f.note : '';
      if (!note) return null;
      return { kind: 'no_op', note };
    }
    default:
      return null;
  }
}

function countByKind(findings: LucidFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    out[f.kind] = (out[f.kind] ?? 0) + 1;
  }
  return out;
}

function makeRunId(trigger: 'auto' | 'manual'): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}-${hh}${mm}${ss}_${trigger}_lucid`;
}

