// Tests for wikilink rewriting in the wiki reader (2026-07-22).
//
// Run: npx tsx web/src/lib/wikilinks.test.mts

import assert from 'node:assert/strict';

import { linkifyWikilinks } from './wikilinks';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const T: Record<string, string | null> = {
  'personen/rene': 'personen/rene',
  'projekte/somora': 'projekte/somora',
  'wissen/tls': 'wissen/tls',
  gibtsnicht: null,
};

{
  const out = linkifyWikilinks('Siehe [[personen/rene]].', T);
  check('einfacher Link', out === 'Siehe [personen/rene](wiki:personen%2Frene).', out);
}
{
  const out = linkifyWikilinks('Siehe [[personen/rene|Rene]].', T);
  check('Alias wird zum Label', out === 'Siehe [Rene](wiki:personen%2Frene).', out);
}
{
  const out = linkifyWikilinks('Siehe [[personen/rene#Wohnort]].', T);
  check('Anker wird ignoriert', out.includes('wiki:personen%2Frene'), out);
}
{
  const out = linkifyWikilinks('Siehe [[gibtsnicht]].', T);
  check('unbekanntes Ziel -> broken', out.includes('wiki-broken:gibtsnicht'), out);
  check('Label bleibt lesbar', out.startsWith('Siehe [gibtsnicht]('), out);
}
{
  const out = linkifyWikilinks('Ziel ohne Eintrag: [[voellig/neu]].', T);
  check(
    'nicht gelistetes Ziel -> broken statt undefined',
    out.includes('wiki-broken:voellig%2Fneu'),
    out,
  );
}

// ── Code darf nicht angefasst werden ──────────────────────────────────
{
  const md = 'Ein Link schreibt man `[[personen/rene]]` so.';
  check('Inline-Code unveraendert', linkifyWikilinks(md, T) === md, linkifyWikilinks(md, T));
}
{
  const md = '```\nSiehe [[personen/rene]]\n```';
  check('Fenced Block unveraendert', linkifyWikilinks(md, T) === md);
}
{
  const md = '~~~md\n[[projekte/somora]]\n~~~';
  check('Tilde-Fence unveraendert', linkifyWikilinks(md, T) === md);
}
{
  // Der reale Fall aus orte/blackcorner.md: Code-Beispiel UND echter
  // Link in derselben Zeile.
  const md = 'Alt war `[[personen/rene]]`, heute [[personen/rene|Rene]].';
  const out = linkifyWikilinks(md, T);
  check('Code geschuetzt, echter Link ersetzt', out.includes('`[[personen/rene]]`'), out);
  check('… und der echte Link wurde ersetzt', out.includes('[Rene](wiki:'), out);
}
{
  const md = 'text [[wissen/tls]] mehr\n\n```js\nconst x = "[[gibtsnicht]]";\n```\n\n[[projekte/somora]]';
  const out = linkifyWikilinks(md, T);
  check('Link vor dem Block ersetzt', out.includes('[wissen/tls](wiki:'), out);
  check('Link im Block unberuehrt', out.includes('"[[gibtsnicht]]"'), out);
  check('Link nach dem Block ersetzt', out.includes('[projekte/somora](wiki:'), out);
}

// ── Robustheit ────────────────────────────────────────────────────────
{
  // Deep kappt Beschreibungen mitten im Link. Der Rest der Datei darf
  // nicht mitgerissen werden.
  const md = '- [[wissen/tls]] — Beschreibung mit [[personen/abgeschn…\n- [[projekte/somora]] — zweite';
  const out = linkifyWikilinks(md, T);
  check('abgeschnittener Link frisst nichts', out.includes('[projekte/somora](wiki:'), out);
}
{
  const out = linkifyWikilinks('[[personen/rene|Rene [der Erste]]]', T);
  check('Klammern im Label entschaerft', !out.includes('[der Erste]'), out);
}
{
  const md = 'gar keine Links hier';
  check('Text ohne Links unveraendert', linkifyWikilinks(md, T) === md);
}
{
  check('leerer Text', linkifyWikilinks('', T) === '');
}
{
  const md = 'Mehrere [[personen/rene]] und [[wissen/tls]] in einer Zeile.';
  const out = linkifyWikilinks(md, T);
  check('mehrere Links pro Zeile', (out.match(/wiki:/g) ?? []).length === 2, out);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
