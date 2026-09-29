// The migration's third step — executing what a person approved.
//
// The only step that writes into the wiki, and it does so in a fixed
// order with a way back: a full copy of the wiki first (no backup, no
// run), then the approved moves, then the approved folds (a page's
// substance carried into the page it belongs to, the original kept
// under logs/<reports>/), then the approved unions of same-name pages,
// then every [[link]] in the wiki pointed at the new places, empty
// folders removed, the structure file stamped with the template
// version, index and log regenerated, and the search index rebuilt.
// Every item is recorded with its outcome in execution.json; a failed
// item never stops the others, and a page is never half-written (temp
// file + rename). `dryRun` walks the same path and writes nothing —
// not even the backup — listing what would happen.

import { cp, mkdir, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedModel, ThinkingLevel } from '../../config/types.ts';
import { callOneShotLLM } from '../../dream/deep-llm.ts';
import { firstCompleteJson } from '../../dream/json-salvage.ts';
import { logger } from '../../server/logger.ts';
import { regenerateIndex } from '../index-builder.ts';
import { wikiSchemaFor, type WikiLanguage } from '../language.ts';
import { appendLogEntries, type LogEntry } from '../log-builder.ts';
import { describeFolder, loadStructureFile, saveStructureFile } from '../structure-file.ts';
import { taxonomyFor } from '../taxonomy.ts';
import { buildWikiPage, parseWikiPage } from '../templates.ts';
import type { PageDecision, RefinedPlan } from './refine.ts';

export type GroupDecision = 'pending' | 'approved' | 'dismissed';

export interface Approvals {
  planId: string;
  /** group key (`move:<folder>` / `fold:<page>`) → decision */
  groups: Record<string, { status: GroupDecision; at: string }>;
  /** twin name → decision */
  twins: Record<string, { status: GroupDecision; at: string }>;
}

export const emptyApprovals = (planId: string): Approvals => ({ planId, groups: {}, twins: {} });

export type AskModel = (args: { system: string; user: string; logCtx: Record<string, unknown> }) => Promise<string>;

export interface ExecutionItem {
  kind: 'move' | 'fold' | 'unite';
  page: string;
  target: string;
  status: 'planned' | 'done' | 'failed' | 'skipped';
  note?: string;
}

export interface ExecutionResult {
  planId: string;
  dryRun: boolean;
  backupDir: string | null;
  startedAt: string;
  finishedAt: string;
  items: ExecutionItem[];
  counts: { move: number; fold: number; unite: number; failed: number; skipped: number };
  linksRewritten: number;
  pagesWithLinksRewritten: number;
  foldersRemoved: string[];
  reindex?: { indexed: number; skipped: number } | { error: string };
}

export interface ExecuteArgs {
  planId: string;
  wikiAbs: string;
  language: WikiLanguage;
  refined: RefinedPlan;
  approvals: Approvals;
  model: ResolvedModel;
  /** Where the copy of the wiki goes. Required unless dryRun. */
  backupDir: string | null;
  dryRun: boolean;
  timeoutMs?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  ask?: AskModel;
  /** Folds into DIFFERENT target pages run side by side (default 4);
   *  folds into the same page always run one after the other. */
  concurrency?: number;
  reindex?: () => Promise<{ indexed: number; skipped: number }>;
  onProgress?: (done: number, total: number, item: ExecutionItem) => void;
  now?: () => Date;
}

const norm = (p: string): string => p.replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');
const baseOf = (p: string): string => p.split('/').pop()!;
const folderOf = (p: string): string => p.split('/').slice(0, -1).join('/');

/** The report archive folder per language. */
export function reportsFolder(language: WikiLanguage): string {
  return language === 'de' ? 'logs/berichte' : 'logs/reports';
}

// ── what is approved ─────────────────────────────────────────────────

export interface Work {
  moves: Map<string, string>; // page → new page path
  folds: Map<string, string>; // page → target page (before chain resolution)
  unites: Array<{ name: string; keep: string; drop: string[] }>;
}

export function approvedWork(refined: RefinedPlan, approvals: Approvals): Work {
  const byPage = new Map(refined.decisions.map((d) => [d.page, d]));
  const approvedPages = new Set(refined.groups.filter((g) => approvals.groups[g.key]?.status === 'approved').flatMap((g) => g.pages));
  const unites = refined.twins.filter((t) => approvals.twins[t.name]?.status === 'approved').map((t) => chooseSurvivor(t, byPage, approvedPages));
  // A dropped copy is united, whatever else was decided for it; the
  // survivor may move (the union follows it) but is never folded away.
  const dropped = new Set(unites.flatMap((u) => u.drop));
  const kept = new Set(unites.map((u) => u.keep));
  const moves = new Map<string, string>();
  const folds = new Map<string, string>();
  for (const g of refined.groups) {
    if (approvals.groups[g.key]?.status !== 'approved') continue;
    for (const p of g.pages) {
      const d = byPage.get(p);
      if (!d || dropped.has(p)) continue;
      if (d.action === 'move' && d.target) moves.set(p, `${d.target}/${d.name ?? baseOf(p)}`);
      else if (d.action === 'fold' && d.target && !kept.has(p)) folds.set(p, d.target);
    }
  }
  return { moves, folds, unites };
}

/**
 * Which twin survives: the copy the model gave a home — a keep in a
 * described folder first, then a move — before the plan's own pick
 * (template folder, then size). 2026-09-29, English demo: `mortgage`
 * existed in money/ and notes/; the plan kept the larger notes/ copy,
 * the model had said money/mortgage → finances/loans and notes/mortgage
 * unclear, and the union landed in a folder the template does not know.
 */
export function chooseSurvivor(t: { name: string; keep: string; drop: string[] }, byPage: Map<string, PageDecision>, approvedPages: Set<string> = new Set()): { name: string; keep: string; drop: string[] } {
  const all = [t.keep, ...t.drop];
  const rank = (p: string): number => {
    const d = byPage.get(p);
    if (!d) return p === t.keep ? 2 : 3;
    if (d.action === 'keep') return 0;
    if (d.action === 'move' && approvedPages.has(p)) return 1;
    return p === t.keep ? 2 : 3;
  };
  const sorted = [...all].sort((a, b) => rank(a) - rank(b) || all.indexOf(a) - all.indexOf(b));
  return { name: t.name, keep: sorted[0]!, drop: sorted.slice(1) };
}

/**
 * Where a page is after the moves, following fold chains (A into B, B
 * into C → A into C). A cycle or a chain over 8 hops resolves to null.
 */
export function resolveTarget(page: string, work: Work): string | null {
  let cur = page;
  for (let hops = 0; hops < 8; hops++) {
    const moved = work.moves.get(cur);
    if (moved) return moved; // a moved page is a final place
    const folded = work.folds.get(cur);
    if (!folded) return cur;
    if (folded === page) return null;
    cur = folded;
  }
  return null;
}

// ── links ────────────────────────────────────────────────────────────

const WIKILINK = /\[\[([^\]|#]+)((?:#[^\]|]*)?)((?:\|[^\]]*)?)\]\]/g;
const MDLINK = /(\]\()([^)\s]+\.md)(\))/g;

/**
 * Rewrite links in one page body. `renames` maps old path → new path
 * (both without .md). A `[[basename]]` link is rewritten only when that
 * basename's page vanished (folded or united): after a plain move
 * Obsidian still resolves it by name. Returns the new body and count.
 */
export function rewriteLinks(body: string, renames: Map<string, string>, vanishedBases: Map<string, string>): { body: string; count: number } {
  const lower = new Map([...renames].map(([k, v]) => [k.toLowerCase(), v]));
  let count = 0;
  let out = body.replace(WIKILINK, (m, p: string, hash: string, alias: string) => {
    const key = norm(p.trim()).toLowerCase();
    let to = lower.get(key);
    if (!to && !key.includes('/')) to = vanishedBases.get(key);
    if (!to) return m;
    count++;
    return `[[${to}${hash}${alias}]]`;
  });
  out = out.replace(MDLINK, (m, open: string, p: string, close: string) => {
    const to = lower.get(norm(p).toLowerCase());
    if (!to) return m;
    count++;
    return `${open}${to}.md${close}`;
  });
  return { body: out, count };
}

/**
 * Rewrite a whole page: the [[links]] in its text AND the paths in its
 * frontmatter `related:` list (2026-09-29: the first live migration
 * rewrote 1683 links and left 393 `related:` entries pointing at moved
 * pages — Lucid found them as dead refs the same evening). Returns the
 * new text and how many references changed; the text is rebuilt only
 * when something changed.
 */
export function rewritePageRefs(raw: string, renames: Map<string, string>, vanishedBases: Map<string, string>): { text: string; count: number } {
  const lower = new Map([...renames].map(([k, v]) => [k.toLowerCase(), v]));
  const links = rewriteLinks(raw, renames, vanishedBases);
  let count = links.count;
  let text = links.body;
  const page = parseWikiPage(text);
  if (page.frontmatter.related?.length) {
    const next: string[] = [];
    let changed = 0;
    for (const r of page.frontmatter.related) {
      const key = norm(String(r)).toLowerCase();
      let to = lower.get(key);
      if (!to && !key.includes('/')) to = vanishedBases.get(key);
      if (to && to !== r) changed++;
      const v = to ?? String(r);
      if (!next.includes(v)) next.push(v);
    }
    if (changed > 0 || next.length !== page.frontmatter.related.length) {
      count += changed;
      page.frontmatter.related = next;
      text = buildWikiPage(page);
    }
  }
  return { text, count };
}

/** The renames a finished run recorded, for a second pass over the links. */
export function renamesFromExecution(r: Pick<ExecutionResult, 'items'>): { renames: Map<string, string>; vanished: Map<string, string> } {
  const renames = new Map<string, string>();
  const vanished = new Map<string, string>();
  for (const it of r.items) {
    if (it.status !== 'done') continue;
    if (it.kind === 'move') renames.set(it.page, it.target);
    else if (it.kind === 'fold') {
      renames.set(it.page, it.target);
      vanished.set(baseOf(it.page).toLowerCase(), it.target);
    } else if (it.kind === 'unite') {
      for (const d of it.page.split(' + ')) {
        renames.set(d, it.target);
        vanished.set(baseOf(d).toLowerCase(), it.target);
      }
    }
  }
  return { renames, vanished };
}

/** One pass over every page: links and `related:` pointed at the new
 *  places. Used at the end of a run and by `relink` afterwards. */
export async function relinkWiki(wikiAbs: string, renames: Map<string, string>, vanished: Map<string, string>, dryRun = false): Promise<{ refs: number; pages: number }> {
  let refs = 0;
  let pages = 0;
  if (renames.size === 0) return { refs, pages };
  for (const rel of await listPages(wikiAbs)) {
    const file = join(wikiAbs, `${rel}.md`);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const r = rewritePageRefs(raw, renames, vanished);
    if (r.count === 0) continue;
    refs += r.count;
    pages++;
    if (!dryRun) await writeAtomic(file, r.text);
  }
  return { refs, pages };
}

// ── page text helpers ────────────────────────────────────────────────

/** Append `entry` at the end of the `## heading` section, or add the section. */
export function insertUnderHeading(body: string, heading: string, entry: string): string {
  const lines = body.split('\n');
  const h = heading.replace(/^#+\s*/, '').trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!) && lines[i]!.replace(/^##\s+/, '').trim().toLowerCase() === h) {
      start = i;
      break;
    }
  }
  const clean = entry.trim();
  if (start < 0) {
    return `${body.replace(/\s+$/, '')}\n\n## ${heading.replace(/^#+\s*/, '').trim()}\n${clean}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##?\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  // Trim blank lines at the section end, add the entry, keep one blank line before the next section.
  let cut = end;
  while (cut > start + 1 && lines[cut - 1]!.trim() === '') cut--;
  const before = lines.slice(0, cut);
  const after = lines.slice(end);
  return [...before, clean, ...(after.length > 0 ? ['', ...after] : [])].join('\n') + (after.length === 0 && !body.endsWith('\n') ? '' : after.length === 0 ? '\n' : '');
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

const today = (now: () => Date): string => now().toISOString().slice(0, 10);

// ── the run ──────────────────────────────────────────────────────────

export async function executeMigration(args: ExecuteArgs): Promise<ExecutionResult> {
  const now = args.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const { wikiAbs, language, dryRun } = args;
  const schema = wikiSchemaFor(language);
  const work = approvedWork(args.refined, args.approvals);
  const items: ExecutionItem[] = [];
  const renames = new Map<string, string>();
  const vanished = new Map<string, string>(); // basename → target
  const logEntries: LogEntry[] = [];
  const total = work.moves.size + work.folds.size + work.unites.length;
  let done = 0;
  const progress = (it: ExecutionItem): void => {
    done++;
    args.onProgress?.(done, total, it);
  };
  const ask: AskModel = args.ask ?? (async (a) => callOneShotLLM({
    workerModel: args.model,
    systemPrompt: a.system,
    userMessage: a.user,
    timeoutMs: args.timeoutMs ?? 240_000,
    logCtx: a.logCtx,
    ...(args.thinking ? { thinking: args.thinking } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  }));
  const exists = (rel: string): Promise<boolean> => stat(join(wikiAbs, `${rel}.md`)).then((s) => s.isFile(), () => false);

  logger.info({ msg: 'wiki.migration.execute_start', planId: args.planId, dryRun, moves: work.moves.size, folds: work.folds.size, unites: work.unites.length, backupDir: args.backupDir });

  // 0. Backup — the whole wiki folder, verified by file count.
  let backupDir: string | null = null;
  if (!dryRun) {
    if (!args.backupDir) throw new Error('backupDir is required for a real run');
    backupDir = args.backupDir;
    await mkdir(dirname(backupDir), { recursive: true });
    await cp(wikiAbs, backupDir, { recursive: true, errorOnExist: true, force: false });
    const [a, b] = await Promise.all([countFiles(wikiAbs), countFiles(backupDir)]);
    if (a !== b) throw new Error(`backup incomplete: ${b} of ${a} files copied to ${backupDir}`);
    logger.info({ msg: 'wiki.migration.backup_done', planId: args.planId, files: a, backupDir });
  }

  // 1. Moves.
  for (const [page, to] of work.moves) {
    if (args.signal?.aborted) break;
    const it: ExecutionItem = { kind: 'move', page, target: to, status: 'planned' };
    items.push(it);
    try {
      if (!(await exists(page))) throw new Error('page no longer exists');
      if (await exists(to)) {
        it.status = 'skipped';
        it.note = 'a page already exists at the target — left for a union';
      } else if (!dryRun) {
        const raw = await readFile(join(wikiAbs, `${page}.md`), 'utf8');
        const parsed = parseWikiPage(raw);
        parsed.frontmatter.slug = to;
        parsed.frontmatter.updated = today(now);
        await mkdir(join(wikiAbs, folderOf(to)), { recursive: true });
        await writeAtomic(join(wikiAbs, `${to}.md`), buildWikiPage(parsed));
        await unlink(join(wikiAbs, `${page}.md`));
        it.status = 'done';
        renames.set(page, to);
        logEntries.push({ wikiPath: to, kind: 'updated', summary: language === 'de' ? `verschoben von ${page}` : `moved from ${page}`, ts: now().getTime() });
      } else {
        renames.set(page, to);
      }
    } catch (err) {
      it.status = 'failed';
      it.note = (err as Error).message;
    }
    progress(it);
  }

  // 2. Folds — source's substance into the target, original archived.
  //    Grouped by target: one page is only ever rewritten by one fold
  //    at a time; different targets run side by side.
  const reports = reportsFolder(language);
  const foldItems = new Map<string, ExecutionItem>();
  const byTarget = new Map<string, string[]>();
  for (const [page] of work.folds) {
    const target = resolveTarget(page, work);
    const it: ExecutionItem = { kind: 'fold', page, target: target ?? '?', status: 'planned' };
    items.push(it);
    foldItems.set(page, it);
    const key = target ?? `?${page}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), page]);
  }
  const runFold = async (page: string): Promise<void> => {
    const it = foldItems.get(page)!;
    const target = resolveTarget(page, work);
    try {
      if (!target) throw new Error('fold chain has no end (cycle)');
      if (!(await exists(page))) throw new Error('page no longer exists');
      const targetNow = renames.get(target) ?? target;
      if (!(await exists(targetNow)) && !dryRun) throw new Error(`target ${targetNow} does not exist`);
      it.target = targetNow;
      if (dryRun) {
        renames.set(page, targetNow);
        vanished.set(baseOf(page).toLowerCase(), targetNow);
      } else {
        const srcRaw = await readFile(join(wikiAbs, `${page}.md`), 'utf8');
        const dstRaw = await readFile(join(wikiAbs, `${targetNow}.md`), 'utf8');
        const dst = parseWikiPage(dstRaw);
        const reply = await ask({ system: foldSystemPrompt(language, schema.sections.timeline), user: foldUserMessage(page, srcRaw, targetNow, dstRaw), logCtx: { op: 'wiki-migration-fold', planId: args.planId, page } });
        const parsed = parseFoldReply(reply, schema.sections.timeline);
        if (!parsed) throw new Error('model reply unreadable');
        dst.body = insertUnderHeading(dst.body, parsed.heading, parsed.entry);
        dst.frontmatter.updated = today(now);
        dst.frontmatter.sources = [...new Set([...(dst.frontmatter.sources ?? []), `wiki:${page}`])];
        await writeAtomic(join(wikiAbs, `${targetNow}.md`), buildWikiPage(dst));
        await archivePage(wikiAbs, reports, page, srcRaw, targetNow, today(now));
        await unlink(join(wikiAbs, `${page}.md`));
        renames.set(page, targetNow);
        vanished.set(baseOf(page).toLowerCase(), targetNow);
        it.status = 'done';
        it.note = `${parsed.heading}: ${parsed.entry.split('\n')[0]!.slice(0, 120)}`;
        logEntries.push({ wikiPath: targetNow, kind: 'updated', summary: language === 'de' ? `${baseOf(page)} eingearbeitet` : `${baseOf(page)} folded in`, ts: now().getTime() });
      }
    } catch (err) {
      it.status = 'failed';
      it.note = (err as Error).message;
    }
    progress(it);
  };
  const queues = [...byTarget.values()];
  const width = Math.max(1, Math.min(args.concurrency ?? 4, queues.length || 1));
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < queues.length) {
      if (args.signal?.aborted) return;
      const q = queues[next++]!;
      for (const page of q) await runFold(page);
    }
  }));

  // 3. Unions of same-name pages.
  for (const u of work.unites) {
    if (args.signal?.aborted) break;
    const keep = renames.get(u.keep) ?? u.keep;
    const it: ExecutionItem = { kind: 'unite', page: u.drop.join(' + '), target: keep, status: 'planned' };
    items.push(it);
    try {
      const drops = u.drop.map((d) => renames.get(d) ?? d);
      if (dryRun) {
        for (const d of drops) {
          renames.set(d, keep);
          vanished.set(baseOf(d).toLowerCase(), keep);
        }
      } else {
        if (!(await exists(keep))) throw new Error(`surviving page ${keep} does not exist`);
        const keepRaw = await readFile(join(wikiAbs, `${keep}.md`), 'utf8');
        const dropRaws: Array<{ path: string; raw: string }> = [];
        for (const d of drops) {
          if (await exists(d)) dropRaws.push({ path: d, raw: await readFile(join(wikiAbs, `${d}.md`), 'utf8') });
        }
        if (dropRaws.length === 0) throw new Error('none of the other pages exists any more');
        const reply = await ask({ system: uniteSystemPrompt(language), user: uniteUserMessage(keep, keepRaw, dropRaws), logCtx: { op: 'wiki-migration-unite', planId: args.planId, page: keep } });
        const body = parseUniteReply(reply);
        if (!body) throw new Error('model reply unreadable');
        const page = parseWikiPage(keepRaw);
        if (body.length < Math.min(page.body.length, 2000) * 0.5) throw new Error(`merged body suspiciously short (${body.length} chars for a ${page.body.length}-char page)`);
        page.body = body.startsWith('\n') ? body : `\n${body}`;
        page.frontmatter.updated = today(now);
        page.frontmatter.sources = [...new Set([...(page.frontmatter.sources ?? []), ...dropRaws.map((d) => `wiki:${d.path}`)])];
        await writeAtomic(join(wikiAbs, `${keep}.md`), buildWikiPage(page));
        for (const d of dropRaws) {
          await archivePage(wikiAbs, reports, d.path, d.raw, keep, today(now));
          await unlink(join(wikiAbs, `${d.path}.md`));
          renames.set(d.path, keep);
          vanished.set(baseOf(d.path).toLowerCase(), keep);
        }
        it.status = 'done';
        logEntries.push({ wikiPath: keep, kind: 'updated', summary: language === 'de' ? `vereint mit ${dropRaws.map((d) => d.path).join(', ')}` : `united with ${dropRaws.map((d) => d.path).join(', ')}`, ts: now().getTime() });
      }
    } catch (err) {
      it.status = 'failed';
      it.note = (err as Error).message;
    }
    progress(it);
  }

  // 4. Links and `related:` across the whole wiki.
  const relinked = await relinkWiki(wikiAbs, renames, vanished, dryRun);
  const linksRewritten = relinked.refs;
  const pagesWithLinksRewritten = relinked.pages;

  // 5. Empty folders.
  const foldersRemoved: string[] = [];
  if (!dryRun) await removeEmptyFolders(wikiAbs, '', foldersRemoved);

  // 6. Structure file, log, index, search index.
  if (!dryRun) {
    try {
      const structure = await loadStructureFile(wikiAbs, language);
      const tax = taxonomyFor(language);
      for (const f of tax.folders) {
        if (await stat(join(wikiAbs, f.path)).then((s) => s.isDirectory(), () => false)) describeFolder(structure, { path: f.path, purpose: f.purpose, origin: 'template' });
        for (const s of f.subfolders ?? []) {
          if (await stat(join(wikiAbs, s.path)).then((x) => x.isDirectory(), () => false)) describeFolder(structure, { path: s.path, purpose: s.purpose, origin: 'template' });
        }
      }
      structure.folders = structure.folders.filter((f) => !foldersRemoved.includes(f.path));
      structure.template_version = tax.version;
      await saveStructureFile(wikiAbs, structure);
    } catch (err) {
      logger.warn({ msg: 'wiki.migration.structure_update_failed', err: (err as Error).message });
    }
    try {
      if (logEntries.length > 0) await appendLogEntries({ wikiAbs, entries: logEntries, schema });
      await regenerateIndex({ wikiAbs, recentUpdates: logEntries.slice(-10).map((e) => ({ wikiPath: e.wikiPath, summary: e.summary, date: new Date(e.ts).toISOString().slice(0, 10) })), schema });
    } catch (err) {
      logger.warn({ msg: 'wiki.migration.index_update_failed', err: (err as Error).message });
    }
  }
  let reindex: ExecutionResult['reindex'];
  if (!dryRun && args.reindex) {
    try {
      reindex = await args.reindex();
    } catch (err) {
      reindex = { error: (err as Error).message };
    }
  }

  const counts = {
    move: items.filter((i) => i.kind === 'move' && i.status === 'done').length,
    fold: items.filter((i) => i.kind === 'fold' && i.status === 'done').length,
    unite: items.filter((i) => i.kind === 'unite' && i.status === 'done').length,
    failed: items.filter((i) => i.status === 'failed').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
  };
  const result: ExecutionResult = { planId: args.planId, dryRun, backupDir, startedAt, finishedAt: now().toISOString(), items, counts, linksRewritten, pagesWithLinksRewritten, foldersRemoved, ...(reindex ? { reindex } : {}) };
  logger.info({ msg: 'wiki.migration.execute_done', planId: args.planId, dryRun, ...counts, linksRewritten, foldersRemoved: foldersRemoved.length, reindex });
  return result;
}

// ── helpers ──────────────────────────────────────────────────────────

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += await countFiles(join(dir, e.name));
    else n++;
  }
  return n;
}

async function listPages(wikiAbs: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(join(wikiAbs, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && e.name === 'logs') continue;
      out.push(...(await listPages(wikiAbs, r)));
    } else if (e.name.endsWith('.md')) out.push(r.slice(0, -3));
  }
  return out;
}

async function removeEmptyFolders(wikiAbs: string, rel: string, removed: string[]): Promise<boolean> {
  const abs = join(wikiAbs, rel);
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || (!rel && e.name === 'logs')) {
        empty = false;
        continue;
      }
      if (!(await removeEmptyFolders(wikiAbs, r, removed))) empty = false;
    } else empty = false;
  }
  if (empty && rel) {
    try {
      await rmdir(abs);
      removed.push(rel);
      return true;
    } catch {
      return false;
    }
  }
  return empty;
}

async function archivePage(wikiAbs: string, reports: string, page: string, raw: string, mergedInto: string, date: string): Promise<void> {
  const parsed = parseWikiPage(raw);
  parsed.frontmatter.merged_into = mergedInto;
  parsed.frontmatter.original_path = page;
  parsed.frontmatter.archived = date;
  const file = join(wikiAbs, reports, `${page.replace(/\//g, '--')}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeAtomic(file, buildWikiPage(parsed));
}

// ── prompts ──────────────────────────────────────────────────────────

const langName = (l: WikiLanguage): string => (l === 'de' ? 'German' : 'English');

export function foldSystemPrompt(language: WikiLanguage, timelineHeading: string): string {
  return `You fold one wiki page (the SOURCE) into another (the TARGET) of a personal wiki kept in ${langName(language)}. The source is not a page of its own any more — a dated work report, a status, a detail of the entity the target describes. Write the entry that carries the source's substance into the target:
- for a dated report, decision or event: a timeline line "- YYYY-MM-DD: …" (one to three lines; the result, the numbers and names that matter; the date from the source)
- for a detail of the entity: a short paragraph or a few bullets under the fitting EXISTING heading of the target
Write in ${langName(language)}. Do not repeat what the target already says; add only what is new. Keep [[links]] from the source that still matter. Answer with JSON only: {"heading": "<an existing ## heading of the target, or \\"${timelineHeading}\\">", "entry": "<markdown>"}`;
}

export function foldUserMessage(srcPath: string, srcRaw: string, dstPath: string, dstRaw: string): string {
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…` : s);
  return `<target path="${dstPath}">\n${cut(dstRaw, 16_000)}\n</target>\n\n<source path="${srcPath}">\n${cut(srcRaw, 12_000)}\n</source>\n\nAnswer as JSON: {"heading": "...", "entry": "..."}`;
}

export function parseFoldReply(raw: string, timelineHeading: string): { heading: string; entry: string } | null {
  const json = firstCompleteJson(raw, '{') ?? raw;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const entry = typeof o.entry === 'string' ? o.entry.trim() : '';
    if (!entry) return null;
    const heading = (typeof o.heading === 'string' && o.heading.trim() ? o.heading : timelineHeading).replace(/^#+\s*/, '').trim();
    return { heading, entry };
  } catch {
    return null;
  }
}

export function uniteSystemPrompt(language: WikiLanguage): string {
  return `Two or more pages of a personal wiki kept in ${langName(language)} describe the same thing under the same name in different folders. Write the FULL body of the surviving page (no frontmatter, keep its "# Title" line and its "## " section structure) that integrates everything the other pages add — facts, numbers, dates, links — without repeating what is already there. When two pages contradict each other, keep both statements with their dates in the timeline. Write in ${langName(language)}. Answer with JSON only: {"body": "<full markdown body>"}`;
}

export function uniteUserMessage(keep: string, keepRaw: string, drops: Array<{ path: string; raw: string }>): string {
  const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…` : s);
  return `<surviving path="${keep}">\n${cut(keepRaw, 20_000)}\n</surviving>\n\n${drops.map((d) => `<other path="${d.path}">\n${cut(d.raw, 12_000)}\n</other>`).join('\n\n')}\n\nAnswer as JSON: {"body": "..."}`;
}

export function parseUniteReply(raw: string): string | null {
  const json = firstCompleteJson(raw, '{') ?? raw;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const body = typeof o.body === 'string' ? o.body.replace(/^---[\s\S]*?---\n/, '').trim() : '';
    return body || null;
  } catch {
    return null;
  }
}

export function renderExecution(r: ExecutionResult, language: WikiLanguage): string {
  const de = language === 'de';
  const L: string[] = [];
  L.push(de ? `# Migration ${r.dryRun ? '(Probelauf — nichts geschrieben)' : 'ausgeführt'}` : `# Migration ${r.dryRun ? '(dry run — nothing written)' : 'executed'}`);
  L.push('', `${r.startedAt.slice(0, 16).replace('T', ' ')} → ${r.finishedAt.slice(11, 16)}${r.backupDir ? ` · ${de ? 'Backup' : 'backup'}: \`${r.backupDir}\`` : ''}`, '');
  L.push(de ? '| Schritt | erledigt |' : '| Step | done |', '|---|---|');
  L.push(`| ${de ? 'verschoben' : 'moved'} | ${r.counts.move} |`, `| ${de ? 'eingearbeitet' : 'folded'} | ${r.counts.fold} |`, `| ${de ? 'vereint' : 'united'} | ${r.counts.unite} |`, `| ${de ? 'fehlgeschlagen' : 'failed'} | ${r.counts.failed} |`, `| ${de ? 'übersprungen' : 'skipped'} | ${r.counts.skipped} |`, `| ${de ? 'Links umgeschrieben' : 'links rewritten'} | ${r.linksRewritten} (${r.pagesWithLinksRewritten} ${de ? 'Seiten' : 'pages'}) |`, `| ${de ? 'leere Ordner entfernt' : 'empty folders removed'} | ${r.foldersRemoved.length} |`);
  if (r.reindex) L.push(`| ${de ? 'Suchindex' : 'search index'} | ${'error' in r.reindex ? r.reindex.error : `${r.reindex.indexed} ${de ? 'neu' : 'indexed'}, ${r.reindex.skipped} ${de ? 'unverändert' : 'unchanged'}`} |`);
  const failed = r.items.filter((i) => i.status === 'failed');
  if (failed.length > 0) {
    L.push('', de ? '## Fehlgeschlagen' : '## Failed', '');
    for (const i of failed) L.push(`- ${i.kind} \`${i.page}\` → \`${i.target}\`: ${i.note ?? ''}`);
  }
  L.push('', de ? '## Alle Schritte' : '## All steps', '');
  for (const i of r.items) L.push(`- ${i.status === 'done' ? '✓' : i.status === 'failed' ? '✗' : i.status === 'skipped' ? '–' : '·'} ${i.kind} \`${i.page}\` → \`${i.target}\`${i.note && i.status !== 'failed' ? ` — ${i.note}` : ''}`);
  if (r.foldersRemoved.length > 0) L.push('', de ? '## Entfernte leere Ordner' : '## Removed empty folders', '', ...r.foldersRemoved.map((f) => `- \`${f}/\``));
  return L.join('\n') + '\n';
}
