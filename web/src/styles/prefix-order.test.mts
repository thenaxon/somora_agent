// A vendor-prefixed declaration must come BEFORE its standard twin.
//
// Vite 8 minifies CSS with Lightning CSS, which treats `-webkit-x` and
// `x` as one property and keeps only the last of the two: with the
// prefixed line last, Chrome and Firefox lost `backdrop-filter` and every
// window turned see-through (2026-10-08). Prefixed first, standard last
// is the usual order and survives the minifier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const roots = [new URL('.', import.meta.url).pathname, new URL('../../../web-mobile/src', import.meta.url).pathname];

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : [],
  );
}

test('no -webkit-/-moz- declaration follows its standard property in the same rule', () => {
  const bad: string[] = [];
  for (const file of roots.flatMap(cssFiles)) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
      const props = block[1]!.split(';').map((d) => d.split(':')[0]!.trim()).filter(Boolean);
      props.forEach((p, i) => {
        const m = /^-(?:webkit|moz)-(.+)$/.exec(p);
        if (m && props.slice(0, i).includes(m[1]!)) bad.push(`${file.split('/src/')[1]}: ${p} after ${m[1]}`);
      });
    }
  }
  assert.deepEqual(bad, []);
});
