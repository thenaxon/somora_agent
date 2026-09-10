// Icons that sit inside a line of text must not fall out of it.
//
// Run: cd web && node --import tsx --test src/components/inline-icon.test.mts
//
// Tailwind preflight blockifies every svg, so `<Icon /> label` puts the
// icon on a line of its own and any `vertical-align` next to it is
// ignored — vertical-align does nothing to a block box. Measured on the
// live desktop 2026-09-10: the sparkles icon in the abilities window sat
// 14px above the word "skills", and the MCP heading did the same. The
// fix is the `.icon-inline` class in desktop.css; these two checks keep
// it in place.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ToolsWindow } from './ToolsWindow';

let ok = 0;
let bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};
function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

t('the class exists in the stylesheet', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'styles', 'desktop.css'), 'utf8');
  assert(css.includes('.icon-inline'), '.icon-inline rule missing');
  assert(/\.icon-inline\s*\{[^}]*display:\s*inline-block/.test(css), '.icon-inline is not inline-block');
});

t('no component nudges an icon with verticalAlign any more', () => {
  const dir = import.meta.dirname;
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const line of src.split('\n')) {
      // A size prop on the same line means it is an icon, not the text
      // caret in MessageItem (a span, where verticalAlign works).
      if (/verticalAlign/.test(line) && /size=\{/.test(line)) offenders.push(`${f}: ${line.trim().slice(0, 70)}`);
    }
  }
  assert(offenders.length === 0, `use className="icon-inline" instead:\n    ${offenders.join('\n    ')}`);
});

t('the abilities window renders its heading icon inline', () => {
  const html = renderToString(React.createElement(ToolsWindow));
  const at = html.indexOf('MCP servers');
  assert(at > 0, 'MCP heading missing');
  assert(html.slice(Math.max(0, at - 900), at).includes('icon-inline'), 'MCP heading icon is not inline');
});

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
