// The settings window describes every setting it lets you change
// (settings/catalog): a test like OpenClaw's tier coverage. A missing
// entry is printed as a stub to fill in.
//
// Run: npm test src/config/settings/catalog.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingFields } from './fields.ts';
import { SETTINGS_CATALOG, SETTINGS_GROUPS } from './catalog/index.ts';
import { ConfigSchema } from '../types.ts';

const fields = settingFields();
const ready = SETTINGS_GROUPS.filter((g) => g.ready).flatMap((g) => g.sections);

test('every top-level section belongs to exactly one group', () => {
  const sections = Object.keys(ConfigSchema.shape);
  const grouped = SETTINGS_GROUPS.flatMap((g) => g.sections);
  assert.deepEqual(sections.filter((s) => !grouped.includes(s)), [], 'sections without a group');
  assert.deepEqual(grouped.filter((s, i) => grouped.indexOf(s) !== i), [], 'sections in two groups');
  assert.deepEqual(grouped.filter((s) => !sections.includes(s)), [], 'groups name sections that do not exist');
});

test('every setting of a ready group has its entry', () => {
  const missing = fields.filter((f) => ready.includes(f.section) && !SETTINGS_CATALOG[f.path]).map((f) => f.path);
  const stubs = missing.map((p) => `  '${p}': { label: '', help: '', level: 'advanced' },`).join('\n');
  assert.equal(missing.length, 0, `${missing.length} setting(s) without an entry:\n${stubs}`);
});

test('no entry for a setting that does not exist', () => {
  const paths = new Set(fields.map((f) => f.path));
  assert.deepEqual(Object.keys(SETTINGS_CATALOG).filter((p) => !paths.has(p)), []);
});

test('entries are plain: a name, one sentence, English, no agent or host names', () => {
  const bad: string[] = [];
  for (const [p, e] of Object.entries(SETTINGS_CATALOG)) {
    if (!e.label.trim() || !e.help.trim()) bad.push(`${p}: empty label or help`);
    if (e.label.length > 48) bad.push(`${p}: label over 48 characters`);
    if (e.help.length > 200) bad.push(`${p}: help over 200 characters — move the rest to more`);
    if (/[äöüß]/i.test(`${e.label} ${e.help} ${e.more ?? ''}`)) bad.push(`${p}: not English`);
    if (/\b192\.168\.\d+\.\d+\b(?!\/)|\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i.test(`${e.help} ${e.more ?? ''} ${e.placeholder ?? ''}`)) bad.push(`${p}: names a host`);
  }
  assert.deepEqual(bad, []);
});

test('a setting whose name says it is a secret is marked sensitive', () => {
  const secretish = fields.filter((f) => /(apikey|token|secret|password)$/i.test(f.path.split('.').pop()!) && SETTINGS_CATALOG[f.path]);
  assert.deepEqual(secretish.filter((f) => !SETTINGS_CATALOG[f.path]!.sensitive).map((f) => f.path), []);
});

test('every docs link points at a page and a heading that exist', () => {
  const docs = join(import.meta.dirname, '..', '..', '..', 'docs');
  const slug = (h: string) => h.toLowerCase().replace(/[`*]/g, '').replace(/[^a-z0-9 -]/g, '').trim().replace(/\s+/g, '-');
  const bad: string[] = [];
  for (const [p, e] of Object.entries(SETTINGS_CATALOG)) {
    if (!e.docs) continue;
    const [page, anchor] = e.docs.split('#');
    const file = join(docs, page!);
    if (!existsSync(file)) {
      bad.push(`${p}: ${page} missing`);
      continue;
    }
    if (anchor) {
      const heads = readFileSync(file, 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, '')));
      if (!heads.includes(anchor)) bad.push(`${p}: #${anchor} not in ${page}`);
    }
  }
  assert.deepEqual(bad, []);
});
