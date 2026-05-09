// Regenerate the wiki's index.md after a Dream-B run.
//
// Strategy: walk the wiki sub-folder, group pages by sub-folder, build
// a clean Markdown table of contents. The "Letzte Updates" section is
// derived from the most recent log entries.
//
// See `private/wiki-design.md` § "index.md-Format".

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { logger } from '../server/logger.ts';
import { parseWikiPage } from './templates.ts';

interface PageEntry {
  slug: string; // relative to wiki root, no .md
  subfolder: string; // top-level subdir (or '' for root pages)
  title: string;
  description: string;
}

export async function regenerateIndex(args: {
  wikiAbs: string;
  recentUpdates: Array<{ wikiPath: string; summary: string; date: string }>;
}): Promise<void> {
  const pages = await collectPages(args.wikiAbs);
  const bySubfolder = new Map<string, PageEntry[]>();
  for (const p of pages) {
    if (!bySubfolder.has(p.subfolder)) bySubfolder.set(p.subfolder, []);
    bySubfolder.get(p.subfolder)!.push(p);
  }
  for (const list of bySubfolder.values()) {
    list.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  const lines: string[] = [
    '# somora-Wiki Index',
    '',
    `Letztes Update: ${nowIsoMinute()} von Dream-B`,
    '',
  ];

  // Headed sections per subfolder, alphabetical. Root-level pages
  // (no subfolder, e.g. someone manually adds a page at wiki root)
  // come last under "## Sonstiges".
  const subfolders = [...bySubfolder.keys()].filter((s) => s !== '').sort();
  for (const sf of subfolders) {
    lines.push(`## ${capitalize(sf)}`);
    for (const p of bySubfolder.get(sf)!) {
      lines.push(`- [[${p.slug}]]${p.description ? ` — ${p.description}` : ''}`);
    }
    lines.push('');
  }
  if (bySubfolder.has('')) {
    lines.push('## Sonstiges');
    for (const p of bySubfolder.get('')!) {
      lines.push(`- [[${p.slug}]]${p.description ? ` — ${p.description}` : ''}`);
    }
    lines.push('');
  }

  // Recent updates (last 10 from caller's accumulation)
  if (args.recentUpdates.length > 0) {
    lines.push('## Letzte Updates');
    for (const u of args.recentUpdates.slice(0, 10)) {
      lines.push(`- ${u.date}: [[${u.wikiPath}]] — ${u.summary}`);
    }
    lines.push('');
  }

  const indexPath = join(args.wikiAbs, 'index.md');
  await writeFile(indexPath, lines.join('\n'), 'utf8');
  logger.info({
    msg: 'wiki.index.regenerated',
    pages: pages.length,
    subfolders: subfolders.length,
    recentUpdates: args.recentUpdates.length,
  });
}

async function collectPages(wikiAbs: string): Promise<PageEntry[]> {
  const out: PageEntry[] = [];
  await walk(wikiAbs, wikiAbs, out);
  return out;
}

async function walk(
  root: string,
  current: string,
  out: PageEntry[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'logs' && current === root) continue; // skip logs dir
    if (e.name === 'index.md' && current === root) continue; // skip index itself
    const full = join(current, e.name);
    if (e.isDirectory()) {
      await walk(root, full, out);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      try {
        const raw = await readFile(full, 'utf8');
        const parsed = parseWikiPage(raw);
        const rel = relative(root, full).replace(/\.md$/, '');
        const parts = rel.split(/[/\\]/);
        const subfolder = parts.length > 1 ? parts[0]! : '';
        const description =
          typeof parsed.frontmatter.description === 'string'
            ? parsed.frontmatter.description
            : extractFirstSentence(parsed.body);
        out.push({
          slug: rel,
          subfolder,
          title: parsed.frontmatter.slug || rel,
          description,
        });
      } catch (err) {
        logger.warn({ msg: 'wiki.index.page_unreadable', path: full, err: (err as Error).message });
      }
    }
  }
}

function extractFirstSentence(body: string): string {
  // Skip H1, blank lines; take the first prose line up to ~120 chars.
  const lines = body.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (t.startsWith('---')) continue;
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }
  return '';
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

function nowIsoMinute(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min} UTC`;
}
