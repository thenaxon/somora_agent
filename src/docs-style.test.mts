// docs/ is read by people on docs.somora.ai and by agents from the
// installed copy. Two guards keep it readable and whole:
//
//   1. Every relative link resolves — the file exists and, when the link
//      names a section, that section exists (GitHub's anchor rules).
//   2. Pages written to the reading style keep it: no dash-inserted
//      asides, no wall-of-text paragraphs, links collected under a
//      closing "See also". LEGACY lists the pages not rewritten yet; a
//      page leaves the list when it is rewritten and never returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const pages = readdirSync(docs).filter((f) => f.endsWith('.md')).sort();
const read = (f: string) => readFileSync(resolve(docs, f), 'utf8');

/** Longest prose paragraph a rewritten page may have, in words. */
const MAX_PARAGRAPH_WORDS = 80;

/** Pages still in the old style. Shrinks; never grows. */
const LEGACY = new Set([
  'agents.md', 'api.md', 'browser.md', 'builder.md', 'cache-strategy.md', 'compaction.md', 'display.md',
  'dream-phases.md', 'files.md', 'imagegen.md', 'index.md', 'lsp.md', 'mcp.md', 'models.md', 'projects.md',
  'realtime-voice.md', 'resources.md', 'sampling.md', 'security.md', 'sentinel.md', 'setup.md', 'skills.md',
  'team.md', 'thinking.md', 'tmux.md', 'tools.md', 'videogen.md', 'voice.md', 'web.md', 'wiki.md',
]);

/** `DOCS_STYLE_PAGES=a.md,b.md` checks those pages although they are
 *  still listed — for trying a rewrite before taking it off the list. */
const FORCED = new Set((process.env.DOCS_STYLE_PAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean));

/** Markdown with fenced code blocks blanked (line count preserved). */
function withoutFences(md: string): string {
  let inside = false;
  return md
    .split('\n')
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) {
        inside = !inside;
        return '';
      }
      return inside ? '' : l;
    })
    .join('\n');
}

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to
 *  hyphens (so "A — b" becomes `a--b`), `-1`, `-2` … for repeats. */
function anchorsOf(md: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of withoutFences(md).split('\n')) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '').replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

test('every relative link in docs/ resolves, section included', () => {
  const anchorCache = new Map<string, Set<string>>();
  const anchors = (f: string) => {
    if (!anchorCache.has(f)) anchorCache.set(f, anchorsOf(read(f)));
    return anchorCache.get(f)!;
  };
  const broken: string[] = [];
  for (const page of pages) {
    const body = withoutFences(read(page)).replace(/`[^`\n]*`/g, '');
    for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto: …
      const [path, anchor] = target.split('#') as [string, string | undefined];
      // Only links into docs/ are checked; `../src/…` and absolute example paths are not ours to verify here.
      if (path && !/^[\w.-]+\.md$/.test(path)) {
        if (path.startsWith('../') && !existsSync(resolve(docs, path))) broken.push(`${page}: ${target} (no such file)`);
        continue;
      }
      const file = path || page;
      if (!pages.includes(file)) {
        broken.push(`${page}: ${target} (no such page)`);
        continue;
      }
      if (anchor && !anchors(file).has(decodeURIComponent(anchor))) broken.push(`${page}: ${target} (no such section)`);
    }
  }
  assert.deepEqual(broken, []);
});

test('rewritten pages keep the reading style', () => {
  const problems: string[] = [];
  for (const page of pages) {
    if (LEGACY.has(page) && !FORCED.has(page)) continue;
    const md = read(page);
    const prose = withoutFences(md).replace(/`[^`\n]*`/g, '`x`');
    const lines = prose.split('\n');
    lines.forEach((l, i) => {
      if (l.includes('—')) problems.push(`${page}:${i + 1}: em dash — write two sentences, or use a colon`);
    });
    // Paragraphs: consecutive plain lines (no table, heading, list, quote).
    let words = 0;
    let start = 0;
    const flush = (end: number) => {
      if (words > MAX_PARAGRAPH_WORDS) problems.push(`${page}:${start + 1}: paragraph of ${words} words (max ${MAX_PARAGRAPH_WORDS}) ending at line ${end}`);
      words = 0;
    };
    lines.forEach((l, i) => {
      const plain = l.trim() !== '' && !/^\s*(\||#|>|[-*+] |\d+\. )/.test(l);
      const continuesItem = /^\s{2,}\S/.test(l);
      if (!plain && !continuesItem) {
        flush(i);
        start = i + 1;
        if (/^\s*([-*+] |\d+\. |>)/.test(l)) words = l.trim().split(/\s+/).length;
        return;
      }
      if (words === 0) start = i;
      words += l.trim().split(/\s+/).length;
    });
    flush(lines.length);
    const h2 = lines.filter((l) => /^## /.test(l));
    if (h2[h2.length - 1] !== '## See also') problems.push(`${page}: the last section must be "## See also"`);
    if (!/^# \S/.test(lines[0] ?? '')) problems.push(`${page}: first line must be the H1`);
    if ((lines[2] ?? '').startsWith('#') || (lines[2] ?? '').trim() === '') problems.push(`${page}: the H1 is followed by a short plain introduction`);
  }
  assert.deepEqual(problems, []);
});

test('the legacy list names only existing pages', () => {
  for (const p of LEGACY) assert.ok(pages.includes(p), `${p} is in LEGACY but not in docs/`);
});
