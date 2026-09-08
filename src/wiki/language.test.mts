// wiki.language — the scaffolding follows the configured language.
//
// Run: npx tsx --test src/wiki/language.test.mts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allSectionHeadings, resolveWikiSchema, sectionList, wikiSchemaFor } from './language.ts';
import { KNOWN_WIKI_TYPES, wikiSectionTitles } from './templates.ts';
import { regenerateIndex } from './index-builder.ts';
import { appendLogEntries } from './log-builder.ts';
import { buildDeepSystemPrompt } from '../dream/deep-prompts.ts';
import { buildLucidSystemPrompt } from '../dream/lucid-prompt.ts';
import { applyPromote } from '../dream/deep-actions.ts';
import { WikiConfigSchema } from '../config/types.ts';
import { wikiCreate, wikiEdit } from '../tools/wiki/tools.ts';

const GERMAN = /Aktueller Stand|Eigenschaften|Zeitleiste|Notizen|personen|projekte|wissen|aktualisiert|Sonstiges|Letzte/;
const ENGLISH_HEADINGS = /Current state|Properties|Timeline|Notes/;

test('config: language defaults to de, accepts en, defaultSubdirs stays optional', () => {
  const none = WikiConfigSchema.parse(undefined);
  assert.equal(none.language, 'de');
  assert.equal(none.defaultSubdirs, undefined);
  const de = WikiConfigSchema.parse({ enabled: true });
  assert.equal(de.language, 'de');
  const en = WikiConfigSchema.parse({ enabled: true, language: 'en' });
  assert.equal(en.language, 'en');
  assert.throws(() => WikiConfigSchema.parse({ language: 'fr' }));
});

test('schema: two complete sets; resolve honours defaultSubdirs override', () => {
  const de = wikiSchemaFor('de');
  const en = wikiSchemaFor('en');
  assert.deepEqual(de.subdirs, ['personen', 'projekte', 'wissen']);
  assert.deepEqual(en.subdirs, ['people', 'projects', 'knowledge']);
  assert.equal(de.months.length, 12);
  assert.equal(en.months.length, 12);
  assert.equal(en.months[8], 'September');
  assert.equal(de.months[2], 'März');
  assert.doesNotMatch(JSON.stringify({ ...en, months: [] }), GERMAN);
  assert.equal(resolveWikiSchema({ language: undefined }).language, 'de');
  assert.equal(resolveWikiSchema({ language: 'en' }).text.indexMisc, 'Other');
  const custom = resolveWikiSchema({ language: 'en', defaultSubdirs: ['folks', 'work'] });
  assert.deepEqual(custom.subdirs, ['folks', 'work']);
  assert.equal(custom.sections.currentState, 'Current state');
  // empty override → language default
  assert.deepEqual(resolveWikiSchema({ language: 'de', defaultSubdirs: [] }).subdirs, ['personen', 'projekte', 'wissen']);
  // templates keep both languages' types and expose the titles per language
  assert.ok(KNOWN_WIKI_TYPES.includes('projekt') && KNOWN_WIKI_TYPES.includes('project'));
  assert.equal(wikiSectionTitles('en').timeline, 'Timeline');
  assert.equal(wikiSectionTitles().timeline, 'Zeitleiste');
  assert.match(allSectionHeadings(), /de: .*Aktueller Stand.*; en: .*Current state/);
});

test('deep prompt: headings, subfolders, types, prose language and examples follow the schema', () => {
  const de = buildDeepSystemPrompt(wikiSchemaFor('de'));
  const en = buildDeepSystemPrompt(wikiSchemaFor('en'));
  assert.match(de, /"## Aktueller Stand" \/ "## Eigenschaften" \/ "## Zeitleiste" \/ "## Notizen"/);
  assert.match(de, /personen \/ projekte \/ wissen \/ orte \/ infrastruktur/);
  assert.match(de, /person \/ projekt \/ konzept \/ ort \/ werkzeug/);
  assert.match(de, /prose in German/);
  assert.match(de, /logSummary in German: "X aktualisiert: <was>"/);
  assert.match(de, /"slug": "personen\/luca"/);
  assert.match(en, /"## Current state" \/ "## Properties" \/ "## Timeline" \/ "## Notes"/);
  assert.match(en, /people \/ projects \/ knowledge \/ places \/ infrastructure/);
  assert.match(en, /person \/ project \/ concept \/ place \/ tool/);
  assert.match(en, /prose in English/);
  assert.match(en, /logSummary in English: "X updated: <what>"/);
  assert.match(en, /"slug": "people\/luca"/);
  assert.match(en, /"related": \["people\/rene", "projects\/family-luca-podcast"\]/);
  assert.doesNotMatch(en, GERMAN);
  assert.doesNotMatch(de, ENGLISH_HEADINGS);
  // an explicit subdir override reaches the prompt
  const custom = buildDeepSystemPrompt(resolveWikiSchema({ language: 'en', defaultSubdirs: ['folks', 'work'] }));
  assert.match(custom, /pick subfolder \(folks \/ work \/ places \/ infrastructure/);
  assert.match(custom, /"slug": "folks\/luca"/);
  // merge keeps whatever a page already has
  assert.match(en, /keep the page's language and section headings as they are/);
  assert.match(en, /"## Timeline" on new pages/);
  // section list helper
  assert.equal(sectionList(wikiSchemaFor('en')), '"## Current state" / "## Properties" / "## Timeline" / "## Notes"');
});

test('lucid prompt: example paths follow the schema', () => {
  const de = buildLucidSystemPrompt(wikiSchemaFor('de'));
  const en = buildLucidSystemPrompt(wikiSchemaFor('en'));
  assert.match(de, /"personen\/anna", "personen\/familie-klein"|"personen\/anna", "personen\/family-klein"/);
  assert.match(en, /"people\/anna", "people\/family-klein"/);
  assert.match(en, /"infrastructure\/build-server"/);
  assert.doesNotMatch(en, /personen|projekte|infrastruktur/);
});

test('index.md and monthly log are written in the wiki language', async () => {
  for (const lang of ['de', 'en'] as const) {
    const schema = wikiSchemaFor(lang);
    const wikiAbs = await mkdtemp(join(tmpdir(), `wiki-lang-${lang}-`));
    const sub = schema.subdirs[0]!;
    await mkdir(join(wikiAbs, sub), { recursive: true });
    await writeFile(join(wikiAbs, sub, 'anna.md'), `---\nslug: ${sub}/anna\ntype: ${schema.types[0]}\ncreated: 2026-09-08\nupdated: 2026-09-08\n---\n\n# Anna\n\n## ${schema.sections.currentState}\n\nAnna is eight.\n`, 'utf8');
    await writeFile(join(wikiAbs, 'loose.md'), `---\nslug: loose\ntype: note\ncreated: 2026-09-08\nupdated: 2026-09-08\n---\n\n# Loose\n\nRoot page.\n`, 'utf8');
    const ts = Date.UTC(2026, 8, 8, 12, 0, 0); // 2026-09-08
    await appendLogEntries({
      wikiAbs,
      entries: [{ wikiPath: `${sub}/anna`, kind: 'promoted', summary: schema.text.promoted(`${sub}/anna`, 'lisa/anna'), ts }],
      schema,
    });
    await regenerateIndex({ wikiAbs, recentUpdates: [{ wikiPath: `${sub}/anna`, summary: 'x', date: '2026-09-08' }], schema });
    const index = await readFile(join(wikiAbs, 'index.md'), 'utf8');
    const log = await readFile(join(wikiAbs, 'logs', '2026-09.md'), 'utf8');
    if (lang === 'en') {
      assert.match(index, /^# somora wiki index\n\nLast update: .* by Deep\n/);
      assert.match(index, /## People\n- \[\[people\/anna\]\]/);
      assert.match(index, /## Other\n- \[\[loose\]\]/);
      assert.match(index, /## Recent updates\n- 2026-09-08: \[\[people\/anna\]\] — x/);
      assert.doesNotMatch(index, GERMAN);
      assert.match(log, /^# Wiki log September 2026\n/);
      assert.match(log, /### Promoted\n- \[\[people\/anna\]\] — people\/anna promoted from lisa\/anna/);
    } else {
      assert.match(index, /^# somora-Wiki Index\n\nLetztes Update: .* von Deep\n/);
      assert.match(index, /## Personen\n- \[\[personen\/anna\]\]/);
      assert.match(index, /## Sonstiges\n- \[\[loose\]\]/);
      assert.match(index, /## Letzte Updates\n/);
      assert.match(log, /^# Wiki-Log September 2026\n/);
      assert.match(log, /personen\/anna übernommen aus lisa\/anna/);
    }
  }
});

test('applyPromote: the log line for a promotion uses the schema wording', async () => {
  const wikiAbs = await mkdtemp(join(tmpdir(), 'wiki-promote-'));
  const memDir = await mkdtemp(join(tmpdir(), 'wiki-mem-'));
  const memFile = join(memDir, 'anna.md');
  await writeFile(memFile, '---\ncreated: 2026-09-08\n---\nAnna is eight.\n', 'utf8');
  const candidate = { agent: 'lisa', slug: 'anna', filePath: memFile, frontmatter: {}, body: 'Anna is eight.', mtimeMs: Date.now() } as unknown as Parameters<typeof applyPromote>[0]['candidate'];
  const decision = { kind: 'promote', subfolder: 'people', slug: 'people/anna', type: 'person', title: 'Anna', body: '## Current state\n\nAnna is eight.\n', related: [] } as unknown as Parameters<typeof applyPromote>[0]['decision'];
  const out = await applyPromote({ candidate, decision, ctx: { wikiAbs, schema: wikiSchemaFor('en') } });
  assert.equal(out.kind, 'promoted');
  assert.equal((out as { logSummary: string }).logSummary, 'people/anna promoted from lisa/anna');
  const page = await readFile(join(wikiAbs, 'people', 'anna.md'), 'utf8');
  assert.match(page, /# Anna\n\n## Current state/);
  const outDe = await applyPromote({
    candidate: { ...candidate, filePath: (await (async () => { const f = join(memDir, 'anna2.md'); await writeFile(f, 'x', 'utf8'); return f; })()) } as typeof candidate,
    decision: { ...decision, slug: 'personen/anna' } as typeof decision,
    ctx: { wikiAbs },
  });
  assert.equal((outDe as { logSummary: string }).logSummary, 'personen/anna übernommen aus lisa/anna');
});

test('wiki tool descriptions name both languages, no hard-coded German scaffolding', () => {
  const texts = [wikiCreate.description, wikiEdit.description, JSON.stringify(wikiCreate.jsonSchema), JSON.stringify(wikiEdit.jsonSchema)].join('\n');
  assert.match(texts, /de: \\?"## Aktueller Stand/);
  assert.match(texts, /en: \\?"## Current state/);
  assert.match(texts, /concept\\?", \\?"place\\?", \\?"tool/); // en types next to the de ones
  assert.match(texts, /personen\/jane-doe/); // as the de example
  assert.match(texts, /projects\/orbit/); // as the en example
  assert.doesNotMatch(texts, /Start with "## Aktueller Stand"/);
});
