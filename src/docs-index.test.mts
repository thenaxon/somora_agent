// docs/ is also the source of docs.somora.ai: the site builds its sidebar
// from the `## All pages` section of docs/index.md (one table per group,
// first column `[Page name](file.md)`), and uses each page's H1 as the
// menu name. A page missing from the section still appears on the site,
// but under "More" — this test keeps that from happening unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const index = readFileSync(resolve(docs, 'index.md'), 'utf8');
const pages = readdirSync(docs).filter((f) => f.endsWith('.md') && f !== 'index.md').sort();

test('every docs page is listed once under "## All pages" in docs/index.md', () => {
  const start = index.indexOf('\n## All pages');
  assert.ok(start > 0, 'docs/index.md has no "## All pages" section');
  const section = index.slice(start + 1);
  assert.ok(!/\n## /.test(section.slice(14)), '"## All pages" must be the last ## section of docs/index.md');
  const listed = [...section.matchAll(/^\| \[[^\]]+\]\(([a-z0-9-]+\.md)\)/gm)].map((m) => m[1]!);
  const missing = pages.filter((p) => !listed.includes(p));
  const unknown = listed.filter((p) => !pages.includes(p));
  const dupes = listed.filter((p, i) => listed.indexOf(p) !== i);
  assert.deepEqual({ missing, unknown, dupes }, { missing: [], unknown: [], dupes: [] }, 'add a row to the right group (docs/index.md → All pages)');
  assert.ok(/\n### /.test(section), 'pages are grouped under ### headings');
});

test('every docs page starts with a short H1 (the sidebar name)', () => {
  const long: string[] = [];
  for (const p of pages) {
    const first = readFileSync(resolve(docs, p), 'utf8').split('\n')[0] ?? '';
    assert.match(first, /^# \S/, `${p}: first line must be the H1`);
    assert.ok(!first.startsWith('---'), `${p}: no frontmatter — GitHub renders it as a table`);
    if (first.length > 40 || first.includes(' — ')) long.push(`${p}: ${first}`);
  }
  assert.deepEqual(long, [], 'keep the H1 to a few words; put the long version in the line below');
});
