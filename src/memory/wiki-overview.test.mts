// Tests for the wiki-overview shortener (2026-07-22).
//
// Run: npx tsx src/memory/wiki-overview.test.mts
//
// Context: the previous shortener ran a global /\[\[[^\]]+\]\]/g over
// every line, so wikilinks inside description prose counted as pages.
// Its last-resort stage kept the first N of those tokens and dropped all
// section headers. On the reference wiki (258 pages, 25 sections) that
// produced 30 tokens covering 22 distinct pages from 7 sections — the
// three largest sections (Wissen 75, Projekte 60, Infrastruktur 26) were
// invisible, because sections are emitted alphabetically and the budget
// ran out at "B". The agent could not tell they existed.
//
// The properties asserted here are the ones that failure violated:
// every stage covers the whole wiki, and no page is counted twice.

import assert from 'node:assert/strict';

import { renderWikiOverview } from './manager.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

/** Dream-B index shape: `## Section` + `- [[pfad/seite]] — description`.
 *  Descriptions embed further wikilinks — that is what broke the old
 *  shortener, so every generated description carries one. */
function buildIndex(sections: Array<[string, number]>): string {
  const out = ['# somora-Wiki Index', '', 'Letztes Update: 2026-07-22 13:14 UTC von Dream-B', ''];
  for (const [title, count] of sections) {
    out.push(`## ${title}`);
    for (let i = 0; i < count; i++) {
      const slug = `${title.toLowerCase()}/seite-${i}`;
      out.push(`- [[${slug}]] — Beschreibung mit Querverweis auf [[personen/rene-siegl|Renes]] Umfeld und noch etwas Fülltext dahinter.`);
    }
    out.push('');
  }
  return out.join('\n');
}

const OPTS = { maxChars: 4000, topNSlugs: 30 };

// ---------------------------------------------------------------- stage 1
{
  const raw = '# Wiki\n\n## Personen\n- [[personen/a]] — kurz\n';
  const out = renderWikiOverview(raw, OPTS);
  check('stage 1: small index returned verbatim', out === raw.trimEnd(), JSON.stringify(out));
}

// ---------------------------------------------------------------- stage 2
{
  const raw = buildIndex([
    ['Personen', 6],
    ['Projekte', 6],
  ]);
  const out = renderWikiOverview(raw, OPTS);
  check('stage 2: shortened at all', out.length < raw.length);
  check('stage 2: within budget', out.length <= OPTS.maxChars, `${out.length}`);
  check('stage 2: keeps section headers', out.includes('## Personen') && out.includes('## Projekte'));
  check('stage 2: keeps descriptions', out.includes('—'));
  check(
    'stage 2: every page present',
    Array.from({ length: 6 }, (_, i) => `[[personen/seite-${i}]]`).every((l) => out.includes(l)),
  );
  // The description link must not appear as if it were a listed page.
  const bullets = out.split('\n').filter((l) => l.startsWith('- '));
  check('stage 2: one bullet per page', bullets.length === 12, `${bullets.length}`);
}

// ---------------------------------------------------------------- stage 3
{
  const raw = buildIndex([
    ['Personen', 20],
    ['Projekte', 25],
    ['Wissen', 30],
  ]);
  const out = renderWikiOverview(raw, OPTS);
  check('stage 3: within budget', out.length <= OPTS.maxChars, `${out.length}`);
  check('stage 3: descriptions dropped', !out.includes('Fülltext'));
  check(
    'stage 3: all three sections survive',
    out.includes('## Personen') && out.includes('## Projekte') && out.includes('## Wissen'),
  );
  check(
    'stage 3: last page of the last section present',
    out.includes('[[wissen/seite-29]]'),
    'alphabetically-late sections must not be truncated away',
  );
  const links = out.match(/\[\[[^\]]+\]\]/g) ?? [];
  check('stage 3: no duplicate links', links.length === new Set(links).size, `${links.length}`);
  check('stage 3: prose links excluded', !out.includes('rene-siegl'));
}

// ---------------------------------------------------------------- stage 4
{
  const sections: Array<[string, number]> = [
    ['Agenten', 11],
    ['Infrastruktur', 26],
    ['Personen', 18],
    ['Projekte', 60],
    ['Wissen', 75],
  ];
  const raw = buildIndex(sections);
  const out = renderWikiOverview(raw, OPTS);
  check('stage 4: within budget', out.length <= OPTS.maxChars, `${out.length}`);
  check('stage 4: reports total page count', out.includes('(190 pages)'), out.split('\n')[0]);
  for (const [title, count] of sections) {
    check(`stage 4: ${title} listed with count`, out.includes(`- ${title} (${count})`));
  }
  check('stage 4: no page-level links left', !out.includes('[['));
}

// stage 4 with more sections than topNSlugs — largest must win, and the
// remainder must be acknowledged rather than silently dropped.
{
  const sections: Array<[string, number]> = [
    ['Riesig', 400],
    ['Gross', 200],
  ];
  for (let i = 0; i < 10; i++) sections.push([`Klein${i}`, 1]);
  const raw = buildIndex(sections);
  const out = renderWikiOverview(raw, { maxChars: 4000, topNSlugs: 3 });
  check('stage 4 cap: largest sections kept', out.includes('- Riesig (400)') && out.includes('- Gross (200)'));
  check('stage 4 cap: dropped sections acknowledged', out.includes('9 smaller sections'), out);
  check('stage 4 cap: total still counts everything', out.includes('(610 pages)'), out.split('\n')[0]);
}

// ------------------------------------------------------- monotone ladder
{
  const raw = buildIndex([
    ['Personen', 30],
    ['Projekte', 40],
    ['Wissen', 50],
  ]);
  let previous = Number.POSITIVE_INFINITY;
  let monotone = true;
  for (const maxChars of [40_000, 12_000, 4000, 1000]) {
    const out = renderWikiOverview(raw, { maxChars, topNSlugs: 30 });
    if (out.length > maxChars) {
      check(`ladder: budget ${maxChars} respected`, false, `${out.length}`);
      monotone = false;
      break;
    }
    if (out.length > previous) monotone = false;
    previous = out.length;
  }
  check('ladder: shrinking budget never grows the block', monotone);
}

// -------------------------------------------------------------- fallback
{
  // Not a Dream-B index — no `## section` + `- [[link]]` structure at all.
  const raw = `# Freitext\n\n${'Ein Absatz ohne jede Struktur. '.repeat(300)}`;
  const out = renderWikiOverview(raw, OPTS);
  check('fallback: within budget', out.length <= OPTS.maxChars + 2, `${out.length}`);
  check('fallback: keeps the head of the file', out.startsWith('# Freitext'));
  check('fallback: marks the truncation', out.endsWith('…'));
}

// A section header with no entries under it must not produce an empty
// heading in the output (Dream-B emits those while a topic is pending).
{
  const raw = `# Index\n\n## Leer\n\n## Personen\n${Array.from(
    { length: 40 },
    (_, i) => `- [[personen/seite-${i}]] — ${'Text '.repeat(30)}`,
  ).join('\n')}\n`;
  const out = renderWikiOverview(raw, OPTS);
  check('empty section omitted', !out.includes('## Leer'), out.slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
