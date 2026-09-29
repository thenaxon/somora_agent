// The migration's first step — the plan, without a single write.
//
// Why (Rene, 2026-09-29): moving a grown wiki onto the template is the
// most delicate thing somora will ever do to an installation. So the
// migration is split: this module reads the whole wiki and writes down
// what it WOULD do, sorted by how sure it is. Rule-based items (a
// folder named `aktien` belongs in `finanzen/depot`) need no model;
// everything else is handed to the model in a later step, page by
// page, and every group is approved by a person before a file moves.
//
// Nothing here touches the wiki. The plan is a file under
// ~/.somora/wiki-migration/ that a person reads first.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { WikiLanguage } from '../language.ts';
import type { StructureFile } from '../structure-file.ts';
import { taxonomyFor, taxonomyPaths, type WikiTaxonomy } from '../taxonomy.ts';

export interface InventoryPage {
  /** Wiki path without .md. */
  path: string;
  folder: string;
  base: string;
  type: string;
  title: string;
  bytes: number;
  /** A date in the file name — the mark of a work report. */
  dated: boolean;
}

export interface Inventory {
  pages: InventoryPage[];
  /** folder → pages directly in it. */
  byFolder: Map<string, InventoryPage[]>;
  /** lowercase basename → pages. */
  byBase: Map<string, InventoryPage[]>;
}

/** One proposed step. `decidedBy: 'rule'` items can run without a
 *  model; `'model'` items are refined by the model in the next step. */
export type PlanItem =
  | { id: number; kind: 'move_folder'; decidedBy: 'rule'; from: string; to: string; pages: string[]; why: string }
  | { id: number; kind: 'unite_twins'; decidedBy: 'model'; name: string; keep: string; drop: string[]; why: string }
  | { id: number; kind: 'fold_report'; decidedBy: 'model'; page: string; into: string | null; why: string }
  | { id: number; kind: 'review_pages'; decidedBy: 'model'; folder: string; pages: string[]; why: string }
  | { id: number; kind: 'describe_folder'; decidedBy: 'model'; folder: string; pages: number; why: string }
  | { id: number; kind: 'unclear'; decidedBy: 'model'; pages: string[]; why: string };

export interface MigrationPlan {
  language: WikiLanguage;
  templateVersion: number;
  createdAt: string;
  pagesTotal: number;
  foldersTotal: number;
  items: PlanItem[];
  summary: Record<PlanItem['kind'], { items: number; pages: number }>;
}

const SKIP_TOP = new Set(['logs', 'templates', 'attachments']);

export async function readInventory(wikiAbs: string): Promise<Inventory> {
  const pages: InventoryPage[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(join(wikiAbs, rel));
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (name.startsWith('.') || name.startsWith('_')) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = await stat(join(wikiAbs, relPath));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth === 0 && SKIP_TOP.has(name)) continue;
        await walk(relPath, depth + 1);
      } else if (name.toLowerCase().endsWith('.md')) {
        if (!rel && name === 'index.md') continue;
        let fm: Record<string, unknown> = {};
        let body = '';
        try {
          const raw = await readFile(join(wikiAbs, relPath), 'utf8');
          const parsed = matter(raw);
          fm = parsed.data as Record<string, unknown>;
          body = parsed.content;
        } catch {
          /* unreadable page: listed without type */
        }
        const base = name.slice(0, -3);
        const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
        pages.push({
          path: relPath.slice(0, -3),
          folder: rel,
          base,
          type: typeof fm.type === 'string' ? fm.type.trim().toLowerCase() : '',
          title: typeof fm.title === 'string' ? fm.title : h1 ?? base,
          bytes: st.size,
          dated: /\d{4}-\d{2}-\d{2}/.test(base),
        });
      }
    }
  };
  await walk('', 0);
  const byFolder = new Map<string, InventoryPage[]>();
  const byBase = new Map<string, InventoryPage[]>();
  for (const p of pages) {
    byFolder.set(p.folder, [...(byFolder.get(p.folder) ?? []), p]);
    const b = p.base.toLowerCase();
    byBase.set(b, [...(byBase.get(b) ?? []), p]);
  }
  return { pages, byFolder, byBase };
}

const topOf = (folder: string): string => folder.split('/')[0] ?? '';

/**
 * Where a grown folder belongs by rule: a template path stays; an
 * alias maps; a template subfolder path given as the wrong parent
 * (e.g. `hosts/cerebro`) follows its alias parent. Null = no rule.
 */
export function ruleTarget(folder: string, taxonomy: WikiTaxonomy, templatePaths: Set<string>): string | null {
  if (!folder) return null;
  if (templatePaths.has(folder)) return folder;
  const parts = folder.split('/');
  const top = parts[0]!;
  const alias = taxonomy.aliases[top];
  if (alias) return alias;
  return null;
}

export async function analyzeWiki(args: { wikiAbs: string; language: WikiLanguage; structure: StructureFile; taxonomy?: WikiTaxonomy; now?: Date }): Promise<MigrationPlan> {
  const taxonomy = args.taxonomy ?? taxonomyFor(args.language);
  const templatePaths = new Set(taxonomyPaths(taxonomy));
  const inv = await readInventory(args.wikiAbs);
  const items: PlanItem[] = [];
  let id = 1;
  const described = new Map(args.structure.folders.map((f) => [f.path, f.purpose]));
  const agentsFolder = taxonomy.folders.find((f) => f.path === 'agenten' || f.path === 'agents')?.path ?? 'agents';
  const projectsFolder = taxonomy.folders.find((f) => f.path === 'projekte' || f.path === 'projects')?.path ?? 'projects';
  const knowledgeFolder = taxonomy.folders.find((f) => f.path === 'wissen' || f.path === 'knowledge')?.path ?? 'knowledge';
  const projectBases = (inv.byFolder.get(projectsFolder) ?? []).map((p) => p.base.toLowerCase()).sort((a, b) => b.length - a.length);

  // 1. Twins: the same name in several folders. Keep the copy in a
  //    template folder (or the larger one); the union of the two
  //    bodies is the model's job.
  const twinPages = new Set<string>();
  for (const [name, pages] of inv.byBase) {
    if (pages.length < 2) continue;
    const ranked = [...pages].sort((a, b) => Number(templatePaths.has(b.folder)) - Number(templatePaths.has(a.folder)) || b.bytes - a.bytes);
    const keep = ranked[0]!;
    items.push({ id: id++, kind: 'unite_twins', decidedBy: 'model', name, keep: keep.path, drop: ranked.slice(1).map((p) => p.path), why: `${pages.length} pages named "${name}" in different folders` });
    for (const p of pages) twinPages.add(p.path);
  }

  // 2. Dated reports: fold into the project page they concern.
  const reportPages = new Set<string>();
  for (const p of inv.pages) {
    if (!p.dated || twinPages.has(p.path)) continue;
    if (p.folder === projectsFolder) continue; // a dated project page is the model's call in the review below
    const base = p.base.toLowerCase();
    const into = projectBases.find((b) => base.startsWith(b + '-') || base.includes('-' + b + '-')) ?? null;
    items.push({ id: id++, kind: 'fold_report', decidedBy: 'model', page: p.path, into: into ? `${projectsFolder}/${into}` : null, why: into ? `dated report, name matches project ${into}` : 'dated report, project to be found by the model' });
    reportPages.add(p.path);
  }

  // 3. Folders: by rule where an alias exists, otherwise a per-page
  //    review. Pages already handled above are left out of the lists.
  const handled = (p: InventoryPage): boolean => twinPages.has(p.path) || reportPages.has(p.path);
  const foldersSeen = new Set<string>();
  for (const [folder, pages] of [...inv.byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    foldersSeen.add(folder);
    const rest = pages.filter((p) => !handled(p)).map((p) => p.path);
    if (!folder) {
      if (rest.length > 0) items.push({ id: id++, kind: 'unclear', decidedBy: 'model', pages: rest, why: 'pages in the wiki root' });
      continue;
    }
    const top = topOf(folder);
    const target = ruleTarget(folder, taxonomy, templatePaths);
    if (target && target !== folder) {
      if (rest.length > 0) items.push({ id: id++, kind: 'move_folder', decidedBy: 'rule', from: folder, to: target, pages: rest, why: `"${top}" is a known name for ${target}` });
      continue;
    }
    if (target === folder) {
      // A template folder. Its pages need a look only where the
      // folder is a catch-all or an agent's own folder.
      // In the agents folder a page typed `agent` is a profile and stays.
      const toReview = top === agentsFolder ? pages.filter((p) => !handled(p) && p.type !== 'agent').map((p) => p.path) : rest;
      if ((top === knowledgeFolder || top === agentsFolder) && toReview.length > 0) {
        items.push({ id: id++, kind: 'review_pages', decidedBy: 'model', folder, pages: toReview, why: top === agentsFolder ? 'only agent profiles stay here; work belongs to the projects' : 'only knowledge tied to no person, company or device stays here' });
      }
      continue;
    }
    // Under a template top folder but not a template path
    // (agenten/hans, projekte/somora, personen/rene-siegl, …).
    if (templatePaths.has(top)) {
      if (rest.length > 0) {
        const why = top === agentsFolder
          ? 'an agent\'s own folder: reports go to the projects, the rest is judged page by page'
          : top === projectsFolder
            ? 'sub-pages of a project: fold into the project page or keep as its own page'
            : 'sub-pages under an entity: fold into the entity page or keep';
        items.push({ id: id++, kind: 'review_pages', decidedBy: 'model', folder, pages: rest, why });
      }
      continue;
    }
    // Unknown top folder without a rule.
    if (rest.length > 0) items.push({ id: id++, kind: 'review_pages', decidedBy: 'model', folder, pages: rest, why: `no rule for "${top}" — folder judged page by page` });
  }

  // 4. Folders that stay and have no description.
  for (const folder of foldersSeen) {
    if (!folder || !templatePaths.has(folder)) continue;
    if ((described.get(folder) ?? '').trim()) continue;
    const tpl = taxonomyPaths(taxonomy).includes(folder);
    if (tpl) continue; // the template describes it
    items.push({ id: id++, kind: 'describe_folder', decidedBy: 'model', folder, pages: inv.byFolder.get(folder)?.length ?? 0, why: 'folder stays but has no description' });
  }

  const summary = {} as MigrationPlan['summary'];
  for (const kind of ['move_folder', 'unite_twins', 'fold_report', 'review_pages', 'describe_folder', 'unclear'] as const) summary[kind] = { items: 0, pages: 0 };
  for (const it of items) {
    summary[it.kind].items++;
    summary[it.kind].pages += it.kind === 'move_folder' || it.kind === 'review_pages' || it.kind === 'unclear' ? it.pages.length : it.kind === 'unite_twins' ? it.drop.length + 1 : it.kind === 'fold_report' ? 1 : it.pages;
  }
  return {
    language: args.language,
    templateVersion: taxonomy.version,
    createdAt: (args.now ?? new Date()).toISOString(),
    pagesTotal: inv.pages.length,
    foldersTotal: [...inv.byFolder.keys()].filter(Boolean).length,
    items,
    summary,
  };
}

/** The plan as a page a person reads — headings per kind, sure things first. */
export function renderPlan(plan: MigrationPlan): string {
  const de = plan.language === 'de';
  const L: string[] = [];
  L.push(de ? '# Migrationsplan (Probelauf — nichts wurde verschoben)' : '# Migration plan (dry run — nothing was moved)');
  L.push('', `${de ? 'Erstellt' : 'Created'}: ${plan.createdAt.slice(0, 16).replace('T', ' ')} · ${de ? 'Seiten' : 'pages'}: ${plan.pagesTotal} · ${de ? 'Ordner' : 'folders'}: ${plan.foldersTotal} · ${de ? 'Vorlage' : 'template'} v${plan.templateVersion}`, '');
  L.push(de ? '| Schritt | Einträge | Seiten | entscheidet |' : '| Step | Items | Pages | decided by |', '|---|---|---|---|');
  const names: Record<PlanItem['kind'], [string, string, string]> = {
    move_folder: ['Ordner nach Regel verschieben', 'Move folder by rule', 'rule'],
    unite_twins: ['Gleichnamige Seiten vereinen', 'Unite same-name pages', 'model + you'],
    fold_report: ['Berichte in Projektseiten einarbeiten', 'Fold reports into project pages', 'model + you'],
    review_pages: ['Seiten einzeln beurteilen', 'Judge pages one by one', 'model + you'],
    describe_folder: ['Ordner beschreiben', 'Describe folder', 'model'],
    unclear: ['Unklar', 'Unclear', 'you'],
  };
  for (const kind of Object.keys(names) as PlanItem['kind'][]) {
    const s = plan.summary[kind];
    L.push(`| ${de ? names[kind][0] : names[kind][1]} | ${s.items} | ${s.pages} | ${names[kind][2]} |`);
  }
  const section = (kind: PlanItem['kind']): void => {
    const its = plan.items.filter((i) => i.kind === kind);
    if (its.length === 0) return;
    L.push('', `## ${de ? names[kind][0] : names[kind][1]}`, '');
    for (const it of its) {
      switch (it.kind) {
        case 'move_folder':
          L.push(`- #${it.id} \`${it.from}/\` → \`${it.to}/\` (${it.pages.length} ${de ? 'Seiten' : 'pages'}) — ${it.why}`);
          break;
        case 'unite_twins':
          L.push(`- #${it.id} **${it.name}**: ${de ? 'behalten' : 'keep'} \`${it.keep}\`, ${de ? 'einarbeiten' : 'fold in'} ${it.drop.map((d) => `\`${d}\``).join(', ')}`);
          break;
        case 'fold_report':
          L.push(`- #${it.id} \`${it.page}\` → ${it.into ? `\`${it.into}\`` : de ? '(Projekt offen)' : '(project open)'}`);
          break;
        case 'review_pages':
          L.push(`- #${it.id} \`${it.folder}/\` (${it.pages.length} ${de ? 'Seiten' : 'pages'}) — ${it.why}`);
          break;
        case 'describe_folder':
          L.push(`- #${it.id} \`${it.folder}/\` (${it.pages} ${de ? 'Seiten' : 'pages'})`);
          break;
        case 'unclear':
          L.push(`- #${it.id} ${it.why}: ${it.pages.map((p) => `\`${p}\``).join(', ')}`);
          break;
      }
    }
  };
  for (const kind of Object.keys(names) as PlanItem['kind'][]) section(kind);
  return L.join('\n') + '\n';
}
