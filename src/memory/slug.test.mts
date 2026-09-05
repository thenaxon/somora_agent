// Run: npx tsx src/memory/slug.test.mts
import assert from 'node:assert/strict';
import { isValidSlug, normalizeSlug } from './slug.ts';

assert.equal(normalizeSlug('iobroker-ablösung-2026-09-01'), 'iobroker-abloesung-2026-09-01');
assert.equal(normalizeSlug('spiderman-liteLLM-multi-deployment-idee'), 'spiderman-litellm-multi-deployment-idee');
assert.equal(normalizeSlug('Straße/Café  Nr. 3'), 'strasse-cafe-nr-3');
assert.equal(normalizeSlug('  --already-fine_slug--  '), 'already-fine_slug');
assert.equal(normalizeSlug('ÄÖÜ'), 'aeoeue');
assert.equal(normalizeSlug('!!!'), '');
for (const s of ['iobroker-abloesung-2026-09-01', 'a', '9x_y-z']) assert.ok(isValidSlug(s), s);
for (const s of ['Über', 'a b', '-lead', '']) assert.ok(!isValidSlug(s), s);
console.log('slug: all tests passed');
