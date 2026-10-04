import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BANNER_COMPACT, BANNER_TAGLINE, BANNER_WIDE, bannerShape, isUtf8Locale, renderBanner } from './banner.ts';

const sh = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'install.sh'), 'utf8');

test('the lettering is rectangular and fits its width class', () => {
  assert.ok(BANNER_WIDE.every((l) => [...l].length <= 54));
  assert.ok(BANNER_COMPACT.every((l) => [...l].length === 18));
});

test('shape: no terminal or no UTF-8 → none; narrow → compact; else wide', () => {
  assert.equal(bannerShape({ isTTY: false, columns: 120, utf8: true }), 'none');
  assert.equal(bannerShape({ isTTY: true, columns: 120, utf8: false }), 'none');
  assert.equal(bannerShape({ isTTY: true, columns: 120, utf8: true }), 'wide');
  assert.equal(bannerShape({ isTTY: true, columns: 60, utf8: true }), 'wide');
  assert.equal(bannerShape({ isTTY: true, columns: 59, utf8: true }), 'compact');
  assert.equal(bannerShape({ isTTY: true, columns: 18, utf8: true }), 'none');
  assert.equal(bannerShape({ isTTY: true, columns: undefined, utf8: true }), 'wide');
});

test('rendered text: lettering, tagline, motto with the subtitle; empty when it does not fit', () => {
  const out = renderBanner('setup 2026.1004.1', { isTTY: true, columns: 100, utf8: true });
  for (const l of BANNER_WIDE) assert.ok(out.includes(l));
  assert.ok(out.includes(BANNER_TAGLINE));
  assert.match(out, /Run\. Rest\. Dream\.  ·  setup 2026\.1004\.1/);
  assert.equal(renderBanner('x', { isTTY: false, columns: 100, utf8: true }), '');
  assert.ok(renderBanner('x', { isTTY: true, columns: 40, utf8: true }).includes(BANNER_COMPACT[0]!));
});

test('UTF-8 detection', () => {
  assert.equal(isUtf8Locale({ LANG: 'de_AT.UTF-8' }), true);
  assert.equal(isUtf8Locale({ LANG: 'C' }), false);
  assert.equal(isUtf8Locale({ LC_ALL: 'en_US.utf8', LANG: 'C' }), true);
});

test('install.sh carries the same lettering and tagline', () => {
  for (const l of [...BANNER_WIDE, ...BANNER_COMPACT]) assert.ok(sh.includes(l), `install.sh misses: ${l}`);
  assert.ok(sh.includes(BANNER_TAGLINE));
});
