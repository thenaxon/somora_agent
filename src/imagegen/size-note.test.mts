import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SOMORA_HOME ??= `/tmp/somora-size-note-${process.pid}`;
const { sizeSubstitutionNote } = await import('./generate.ts');

test('result in the shape of reference 1: named as the cause, with the way out', () => {
  const n = sizeSubstitutionNote({ width: 2528, height: 1696 }, { width: 3200, height: 1344 }, { width: 3168, height: 1344 }, 2);
  assert.match(n, /shape of the first reference image \(3168x1344\)/);
  assert.match(n, /pass a first reference with that aspect ratio/);
});

test('references passed but another shape: points at the catalog note', () => {
  const n = sizeSubstitutionNote({ width: 2528, height: 1696 }, { width: 2048, height: 2048 }, { width: 3168, height: 1344 }, 1);
  assert.match(n, /edit models often take the shape of the first reference/);
  assert.match(n, /endpoint_note/);
});

test('no references: the generic cap-or-round note', () => {
  const n = sizeSubstitutionNote({ width: 1000, height: 1000 }, { width: 1024, height: 1024 }, null, 0);
  assert.match(n, /may cap dimensions or round/);
});
