// The migration's second step — the model judges every page the plan
// is unsure about, and every page a rule would move. Still no write.
//
// Why (Rene, 2026-09-29): a rule by folder name gets about half of the
// pages right — `hardware/` held devices AND the projects that bought
// them, `rechtliches/` held a lawsuit that is an event, not a rule. So
// no page moves on a folder name: the rule only proposes a target, and
// the model looks at every page (title, type, the first lines) with
// the wiki map and the names of the entity pages in front of it. The
// answers are grouped by what would happen ("move 12 pages to
// infrastruktur/geraete", "fold 30 pages into projekte/realtimevoice")
// so a person approves groups, not 500 lines.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { ResolvedModel, ThinkingLevel } from '../../config/types.ts';
import { callOneShotLLM } from '../../dream/deep-llm.ts';
import { firstCompleteJson } from '../../dream/json-salvage.ts';
import { logger } from '../../server/logger.ts';
import type { WikiLanguage } from '../language.ts';
import type { WikiMap } from '../map.ts';
import { taxonomyFor, taxonomyPaths } from '../taxonomy.ts';
import { readInventory, type InventoryPage, type MigrationPlan, type PlanItem } from './analyze.ts';

export type PageAction = 'keep' | 'move' | 'fold' | 'unclear';

export interface PageDecision {
  page: string;
  action: PageAction;
  /** move: the folder; fold: the page the content goes into. */
  target: string | null;
  /** move only: a new file name when the old one is not the thing's
   *  name (a date-prefixed journal entry that becomes a device page). */
  name?: string;
  why: string;
  /** What the plan proposed before the model looked. */
  proposed: { action: 'move' | 'fold' | 'review'; target: string | null };
  /** Set when the model's answer was corrected (unknown target, …). */
  corrected?: string;
}

export interface DecisionGroup {
  key: string;
  action: PageAction;
  target: string | null;
  pages: string[];
}

export interface RefinedPlan {
  planId: string;
  createdAt: string;
  model: string;
  batchesTotal: number;
  batchesFailed: number;
  pagesJudged: number;
  decisions: PageDecision[];
  groups: DecisionGroup[];
  /** Carried over from the plan: twins are decided at execution. */
  twins: Array<Extract<PlanItem, { kind: 'unite_twins' }>>;
}

/** One model call — injectable for tests. */
export type AskModel = (args: { system: string; user: string; logCtx: Record<string, unknown> }) => Promise<string>;

export interface RefineArgs {
  plan: MigrationPlan;
  planId: string;
  wikiAbs: string;
  language: WikiLanguage;
  map: WikiMap;
  model: ResolvedModel;
  timeoutMs?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
  batchSize?: number;
  ask?: AskModel;
  onProgress?: (done: number, total: number) => void;
}

interface Judged {
  page: InventoryPage;
  proposed: PageDecision['proposed'];
}

/** The pages the model looks at, with what the plan proposed for each. */
export function pagesToJudge(plan: MigrationPlan, inv: Map<string, InventoryPage>): Judged[] {
  const out: Judged[] = [];
  const seen = new Set<string>();
  const add = (path: string, proposed: PageDecision['proposed']): void => {
    const p = inv.get(path);
    if (!p || seen.has(path)) return;
    seen.add(path);
    out.push({ page: p, proposed });
  };
  for (const it of plan.items) {
    if (it.kind === 'move_folder') for (const p of it.pages) add(p, { action: 'move', target: it.to });
    else if (it.kind === 'fold_report') add(it.page, { action: 'fold', target: it.into });
    else if (it.kind === 'review_pages' || it.kind === 'unclear') for (const p of it.pages) add(p, { action: 'review', target: null });
  }
  return out;
}

const ENTITY_TOPS = new Set(['personen', 'people', 'unternehmen', 'companies', 'projekte', 'projects', 'orte', 'places', 'infrastruktur', 'infrastructure', 'besitz', 'possessions', 'agenten', 'agents']);

/** Names a `fold` may point at: entity pages, listed by folder. */
export function entityIndex(pages: InventoryPage[]): string {
  const by = new Map<string, string[]>();
  for (const p of pages) {
    const top = p.folder.split('/')[0] ?? '';
    if (!ENTITY_TOPS.has(top)) continue;
    // Only the entity pages themselves, not their sub-pages.
    if (p.folder.split('/').length > 1 && !(top === 'infrastruktur' || top === 'infrastructure')) continue;
    by.set(p.folder, [...(by.get(p.folder) ?? []), p.base]);
  }
  return [...by.entries()].sort().map(([f, names]) => `${f}/: ${names.sort().join(', ')}`).join('\n');
}

export function buildRefineSystemPrompt(language: WikiLanguage): string {
  const t = taxonomyFor(language);
  const lang = language === 'de' ? 'German' : 'English';
  return `You are migrating a grown personal wiki (kept in ${lang}) onto a folder template. The one rule: a folder says what KIND of page lives in it — a person, a company, a project, a device, a rule — never what a page is about. Topics live inside pages and in links.

You get: the wiki map (folders that exist, their purpose, page counts, and the template folders not created yet), the names of the entity pages (people, companies, projects, places, devices) a page could be folded into, and a batch of pages with title, type, folder, and their first lines. For every page in the batch decide ONE of:

- "keep": the page is the right kind for the folder it is in. (Also when its folder is a template folder and the page fits it.)
- "move": the page is a page of its own but belongs in another folder — give the folder path from the map (existing or proposed). Never invent a folder. When the page's file name is not the name of the thing it describes (a date-prefixed journal entry that becomes the page of a device or a purchase), add "name": "<lowercase-kebab-case name of the thing>".
- "fold": the page is not a page of its own — a dated work report, a status update, a detail, a sub-topic of an entity — and its content belongs INTO an existing page as a timeline entry or section. Give that page's path (from the entity names). A dated report about a project folds into the project page; a note about a device folds into the device page; a note about a person into the person page.
- "unclear": you cannot tell from what you see.

Judge by the KIND of page, not by the topic. A page whose name starts with an entity's name and describes a detail of it is usually a fold. Knowledge folders (${t.folders.find((f) => f.path.startsWith('wissen') || f.path.startsWith('knowledge'))?.path}) keep only knowledge tied to no specific person, company, project or device. Agent folders keep only agent profiles.

Answer with JSON only: an array with one object per page, in the order given:
[{"page": "<path as given>", "action": "keep|move|fold|unclear", "target": "<folder for move, page path for fold, null otherwise>", "name": "<only for move, only when the file needs a new name>", "why": "<one short sentence>"}]

A page may only "keep" its place when its folder is one the map describes; a page in an undescribed grown folder must move, fold, or be unclear.`;
}

function pageBlock(j: Judged, body: string): string {
  const prop = j.proposed.action === 'review' ? 'no proposal' : `${j.proposed.action}${j.proposed.target ? ` → ${j.proposed.target}` : ' (target unknown)'}`;
  return `<page path="${j.page.path}" type="${j.page.type || '-'}" proposal="${prop}">\n${j.page.title}\n${body}\n</page>`;
}

async function firstLines(wikiAbs: string, path: string, chars: number): Promise<string> {
  try {
    const raw = await readFile(join(wikiAbs, `${path}.md`), 'utf8');
    const body = matter(raw).content.replace(/^#\s.+\n/, '').trim();
    return body.length > chars ? `${body.slice(0, chars)} …` : body;
  } catch {
    return '(unreadable)';
  }
}

/** Parse one batch answer; missing or malformed pages become `unclear`. */
export function parseRefineReply(raw: string, batch: Judged[], known: { folders: Set<string>; pages: Set<string>; described?: Set<string> }): PageDecision[] {
  const json = firstCompleteJson(raw, '[') ?? raw;
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    arr = null;
  }
  const byPage = new Map<string, Record<string, unknown>>();
  if (Array.isArray(arr)) {
    for (const o of arr) {
      if (o && typeof o === 'object' && typeof (o as Record<string, unknown>).page === 'string') byPage.set(String((o as Record<string, unknown>).page).replace(/\.md$/i, ''), o as Record<string, unknown>);
    }
  }
  const norm = (s: string): string => s.replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');
  return batch.map((j) => {
    const o = byPage.get(j.page.path);
    const why = o && typeof o.why === 'string' ? o.why.trim() : '';
    if (!o) return { page: j.page.path, action: 'unclear', target: null, why: 'no answer for this page', proposed: j.proposed, corrected: 'missing' };
    const action = typeof o.action === 'string' ? o.action.trim().toLowerCase() : '';
    const target = typeof o.target === 'string' && o.target.trim() ? norm(o.target) : null;
    const keepAllowed = !known.described || !j.page.folder || known.described.has(j.page.folder);
    const keptWrong = (): PageDecision => ({ page: j.page.path, action: 'unclear', target: null, why: `${why} [kept in ${j.page.folder}, a folder the template does not describe]`, proposed: j.proposed, corrected: 'keep in undescribed folder' });
    if (action === 'keep') return keepAllowed ? { page: j.page.path, action: 'keep', target: null, why, proposed: j.proposed } : keptWrong();
    if (action === 'move') {
      if (!target) return { page: j.page.path, action: 'unclear', target: null, why: why || 'move without a folder', proposed: j.proposed, corrected: 'move without target' };
      if (!known.folders.has(target)) return { page: j.page.path, action: 'unclear', target: null, why: `${why} [wanted folder ${target}, which is neither existing nor proposed]`, proposed: j.proposed, corrected: `unknown folder ${target}` };
      const nameRaw = typeof o.name === 'string' ? o.name.trim().toLowerCase().replace(/\.md$/, '') : '';
      const name = /^[a-z0-9][a-z0-9-]{1,80}$/.test(nameRaw) && nameRaw !== j.page.base.toLowerCase() ? nameRaw : undefined;
      if (target === j.page.folder && !name) return keepAllowed ? { page: j.page.path, action: 'keep', target: null, why, proposed: j.proposed, corrected: 'move to own folder = keep' } : keptWrong();
      return { page: j.page.path, action: 'move', target, ...(name ? { name } : {}), why, proposed: j.proposed };
    }
    if (action === 'fold') {
      if (!target || !known.pages.has(target)) return { page: j.page.path, action: 'unclear', target: null, why: `${why} [wanted page ${target ?? '?'}, which does not exist]`, proposed: j.proposed, corrected: `unknown page ${target ?? '?'}` };
      if (target === j.page.path) return { page: j.page.path, action: 'keep', target: null, why, proposed: j.proposed, corrected: 'fold into itself = keep' };
      return { page: j.page.path, action: 'fold', target, why, proposed: j.proposed };
    }
    return { page: j.page.path, action: 'unclear', target: null, why: why || `unknown action "${action}"`, proposed: j.proposed, ...(action !== 'unclear' ? { corrected: `unknown action ${action}` } : {}) };
  });
}

export function groupDecisions(decisions: PageDecision[]): DecisionGroup[] {
  const groups = new Map<string, DecisionGroup>();
  for (const d of decisions) {
    const key = `${d.action}:${d.target ?? ''}`;
    const g = groups.get(key) ?? { key, action: d.action, target: d.target, pages: [] };
    g.pages.push(d.page);
    groups.set(key, g);
  }
  const order: Record<PageAction, number> = { move: 0, fold: 1, keep: 2, unclear: 3 };
  return [...groups.values()].sort((a, b) => order[a.action] - order[b.action] || b.pages.length - a.pages.length || a.key.localeCompare(b.key));
}

export async function refinePlan(args: RefineArgs): Promise<RefinedPlan> {
  const t0 = Date.now();
  const invAll = await readInventory(args.wikiAbs);
  const inv = new Map(invAll.pages.map((p) => [p.path, p]));
  const judged = pagesToJudge(args.plan, inv);
  const known = {
    folders: new Set([...args.map.folders.map((f) => f.path), ...args.map.planned.map((p) => p.path), ...taxonomyPaths(taxonomyFor(args.language))]),
    pages: new Set(invAll.pages.map((p) => p.path)),
    // Where a page may stay: template folders and folders a person or
    // Deep described. A grown folder nobody described is no home.
    described: new Set([...taxonomyPaths(taxonomyFor(args.language)), ...args.map.folders.filter((f) => f.purpose && f.origin !== 'unknown').map((f) => f.path), ...args.map.planned.map((p) => p.path)]),
  };
  const system = buildRefineSystemPrompt(args.language);
  const context = `${args.map.text}\n\n<entity_pages>\n${entityIndex(invAll.pages)}\n</entity_pages>`;
  const size = Math.max(1, args.batchSize ?? 25);
  const batches: Judged[][] = [];
  for (let i = 0; i < judged.length; i += size) batches.push(judged.slice(i, i + size));
  const modelRef = `${args.model.providerName}/${args.model.modelId}`;
  const ask: AskModel = args.ask ?? (async (a) => callOneShotLLM({
    workerModel: args.model,
    systemPrompt: a.system,
    userMessage: a.user,
    timeoutMs: args.timeoutMs ?? 240_000,
    logCtx: a.logCtx,
    ...(args.thinking ? { thinking: args.thinking } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  }));
  logger.info({ msg: 'wiki.migration.refine_start', planId: args.planId, pages: judged.length, batches: batches.length, model: modelRef });
  const decisions: PageDecision[] = [];
  let failed = 0;
  for (let b = 0; b < batches.length; b++) {
    if (args.signal?.aborted) break;
    const batch = batches[b]!;
    const blocks: string[] = [];
    for (const j of batch) blocks.push(pageBlock(j, await firstLines(args.wikiAbs, j.page.path, 500)));
    const user = `${context}\n\n<pages>\n${blocks.join('\n\n')}\n</pages>\n\nAnswer as JSON: one object per page, ${batch.length} in all.`;
    try {
      const raw = await ask({ system, user, logCtx: { op: 'wiki-migration', planId: args.planId, batch: b + 1 } });
      const parsed = parseRefineReply(raw, batch, known);
      decisions.push(...parsed);
      logger.info({
        msg: 'wiki.migration.refine_batch',
        planId: args.planId,
        batch: b + 1,
        of: batches.length,
        pages: batch.length,
        keep: parsed.filter((d) => d.action === 'keep').length,
        move: parsed.filter((d) => d.action === 'move').length,
        fold: parsed.filter((d) => d.action === 'fold').length,
        unclear: parsed.filter((d) => d.action === 'unclear').length,
        corrected: parsed.filter((d) => d.corrected).length,
      });
    } catch (err) {
      failed++;
      logger.warn({ msg: 'wiki.migration.refine_batch_failed', planId: args.planId, batch: b + 1, err: (err as Error).message });
      for (const j of batch) decisions.push({ page: j.page.path, action: 'unclear', target: null, why: `model call failed: ${(err as Error).message}`, proposed: j.proposed, corrected: 'batch failed' });
    }
    args.onProgress?.(b + 1, batches.length);
  }
  const out: RefinedPlan = {
    planId: args.planId,
    createdAt: new Date().toISOString(),
    model: modelRef,
    batchesTotal: batches.length,
    batchesFailed: failed,
    pagesJudged: decisions.length,
    decisions,
    groups: groupDecisions(decisions),
    twins: args.plan.items.filter((i): i is Extract<PlanItem, { kind: 'unite_twins' }> => i.kind === 'unite_twins'),
  };
  logger.info({ msg: 'wiki.migration.refine_done', planId: args.planId, pages: decisions.length, batchesFailed: failed, groups: out.groups.length, ms: Date.now() - t0 });
  return out;
}

export function renderRefinedPlan(r: RefinedPlan, language: WikiLanguage): string {
  const de = language === 'de';
  const L: string[] = [];
  L.push(de ? '# Migrationsplan, vom Modell beurteilt (nichts wurde verschoben)' : '# Migration plan, judged by the model (nothing was moved)');
  L.push('', `${de ? 'Modell' : 'Model'}: ${r.model} · ${de ? 'Seiten' : 'pages'}: ${r.pagesJudged} · ${de ? 'Aufrufe' : 'calls'}: ${r.batchesTotal}${r.batchesFailed ? ` (${r.batchesFailed} ${de ? 'fehlgeschlagen' : 'failed'})` : ''}`, '');
  const n = (a: PageAction): number => r.decisions.filter((d) => d.action === a).length;
  L.push(de ? '| Ergebnis | Seiten |' : '| Outcome | Pages |', '|---|---|');
  L.push(`| ${de ? 'bleibt' : 'keep'} | ${n('keep')} |`, `| ${de ? 'verschieben' : 'move'} | ${n('move')} |`, `| ${de ? 'einarbeiten' : 'fold'} | ${n('fold')} |`, `| ${de ? 'unklar' : 'unclear'} | ${n('unclear')} |`);
  if (r.twins.length > 0) L.push(`| ${de ? 'gleichnamige Seiten vereinen' : 'unite same-name pages'} | ${r.twins.reduce((s, t) => s + t.drop.length + 1, 0)} |`);
  const label: Record<PageAction, string> = de
    ? { move: 'Verschieben nach', fold: 'Einarbeiten in', keep: 'Bleibt in', unclear: 'Unklar' }
    : { move: 'Move to', fold: 'Fold into', keep: 'Stays in', unclear: 'Unclear' };
  for (const action of ['move', 'fold', 'unclear', 'keep'] as const) {
    const gs = r.groups.filter((g) => g.action === action);
    if (gs.length === 0) continue;
    L.push('', `## ${label[action]}`);
    for (const g of gs) {
      if (action === 'keep') {
        // Keeps are grouped by the folder they stay in — short.
        continue;
      }
      L.push('', `### ${g.target ? `\`${g.target}\`` : de ? 'ohne Ziel' : 'no target'} (${g.pages.length})`, '');
      for (const p of g.pages) {
        const d = r.decisions.find((x) => x.page === p)!;
        L.push(`- \`${p}\`${d.name ? ` → \`${d.name}\`` : ''} — ${d.why}${d.corrected ? ` _(${d.corrected})_` : ''}`);
      }
    }
    if (action === 'keep') {
      const byFolder = new Map<string, number>();
      for (const g of gs) for (const p of g.pages) {
        const f = p.split('/').slice(0, -1).join('/');
        byFolder.set(f, (byFolder.get(f) ?? 0) + 1);
      }
      L.push('');
      for (const [f, c] of [...byFolder.entries()].sort()) L.push(`- \`${f || '/'}\`: ${c}`);
    }
  }
  if (r.twins.length > 0) {
    L.push('', de ? '## Gleichnamige Seiten vereinen (Inhalt wird beim Ausführen zusammengeführt)' : '## Unite same-name pages (content is merged when executed)', '');
    for (const t of r.twins) L.push(`- **${t.name}**: ${de ? 'behalten' : 'keep'} \`${t.keep}\`, ${de ? 'einarbeiten' : 'fold in'} ${t.drop.map((d) => `\`${d}\``).join(', ')}`);
  }
  return L.join('\n') + '\n';
}
