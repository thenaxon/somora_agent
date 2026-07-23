// Tests for wiki frontmatter date handling (2026-07-23).
//
// Run: npx tsx src/wiki/templates.test.mts
//
// Regression (Juni-Audit): Obsidian writes frontmatter dates UNQUOTED
// (`created: 2026-05-01`), which js-yaml parses into a Date object, not a
// string. parseWikiPage used to keep only `typeof === 'string'` values and
// blank the rest, so a Date-valued `created` became '' — then wiki_edit's
// `parsed.created || today` replaced the blank with today's date, silently
// destroying the real creation date on EVERY edit of an Obsidian page.

import assert from 'node:assert/strict';

import { coerceWikiDate, parseWikiPage, buildWikiPage } from './templates.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ── coerceWikiDate unit ───────────────────────────────────────────────
{
  check('string passes through', coerceWikiDate('2026-05-01') === '2026-05-01');
  check(
    'Date → YYYY-MM-DD (UTC calendar day)',
    coerceWikiDate(new Date('2026-05-01T00:00:00Z')) === '2026-05-01',
    coerceWikiDate(new Date('2026-05-01T00:00:00Z')),
  );
  check('undefined → empty', coerceWikiDate(undefined) === '');
  check('null → empty', coerceWikiDate(null) === '');
  check('invalid Date → empty', coerceWikiDate(new Date('nonsense')) === '');
  check('number → empty (not a date)', coerceWikiDate(20260501) === '');
}

// ── the live bug: an UNQUOTED date in real frontmatter ────────────────
{
  // js-yaml parses the unquoted date into a Date; this is exactly what an
  // Obsidian-authored page looks like on disk.
  const raw = [
    '---',
    'slug: rene',
    'type: person',
    'created: 2026-05-01', // unquoted → Date after parse
    'updated: 2026-05-10',
    '---',
    '',
    '# Rene',
    '',
    'Body text.',
  ].join('\n');

  const page = parseWikiPage(raw);
  check(
    'unquoted created survives as a string',
    page.frontmatter.created === '2026-05-01',
    `got '${page.frontmatter.created}'`,
  );
  check(
    'unquoted updated survives as a string',
    page.frontmatter.updated === '2026-05-10',
    `got '${page.frontmatter.updated}'`,
  );
}

// ── wiki_edit round-trip must NOT reset created to today ───────────────
{
  const raw = ['---', 'slug: x', 'type: konzept', 'created: 2024-01-15', 'updated: 2024-01-15', '---', '', '# X', ''].join('\n');
  const parsed = parseWikiPage(raw);
  // Replicates the exact expression in tools/wiki/tools.ts:
  const today = '2026-07-23';
  const createdAfterEdit = (parsed.frontmatter.created as string) || today;
  check(
    'created preserved through the wiki_edit expression',
    createdAfterEdit === '2024-01-15',
    `got '${createdAfterEdit}'`,
  );

  // And the rebuilt page still carries the original creation date.
  const rebuilt = buildWikiPage({
    frontmatter: { ...parsed.frontmatter, created: createdAfterEdit, updated: today },
    body: parsed.body,
  });
  check('rebuilt page keeps original created', rebuilt.includes('2024-01-15'), rebuilt.slice(0, 120));
  const reparsed = parseWikiPage(rebuilt);
  check(
    'created round-trips a second time (dump→parse stable)',
    reparsed.frontmatter.created === '2024-01-15',
    `got '${reparsed.frontmatter.created}'`,
  );
}

// ── quoted dates (somora's own writer) still work ─────────────────────
{
  const raw = ['---', "slug: y", "type: ort", "created: '2025-12-31'", "updated: '2025-12-31'", '---', '', '# Y', ''].join('\n');
  const page = parseWikiPage(raw);
  check('quoted created still a string', page.frontmatter.created === '2025-12-31', page.frontmatter.created);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
