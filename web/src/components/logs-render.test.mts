// Render smoke + pure helpers for the server-log window.
//
// Run: cd web && npx tsx src/components/logs-render.test.mts
//
// renderToString runs no effects, so nothing is fetched here. What this
// covers: broken imports, invalid JSX, hook order, the empty state, and
// the three pure formatters the rows are built from.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { formatLogTime, levelColor, levelName, LogsWindow, summarizeFields } from './LogsWindow';

let ok = 0;
let bad = 0;
const t = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { ok++; console.log('  ok  ', name); }
  else { bad++; console.error('  FAIL', name, detail); }
};

function check(name: string, fn: () => boolean): void {
  let result = false;
  try { result = fn(); } catch (err) { console.error('  FAIL', name, (err as Error).message); bad++; return; }
  t(name, result);
}

check('renders the toolbar and the empty state', () => {
  const html = renderToString(React.createElement(LogsWindow));
  return html.includes('filter text') && html.includes('following');
});

check('level names follow pino numbers', () =>
  levelName(50) === 'error' && levelName(40) === 'warn' && levelName(30) === 'info' && levelName(20) === 'debug' && levelName(60) === 'fatal');

check('errors and warnings are coloured apart from the rest', () =>
  levelColor(50) !== levelColor(30) && levelColor(40) !== levelColor(30));

check('the time column is a clock, not a date', () => /^\d{2}:\d{2}:\d{2}$/.test(formatLogTime(Date.now())));

check('field summary drops what already has a column and caps long values', () => {
  const line = summarizeFields({ agent: 'lisa', msg: 'x', err: 'boom', url: 'y'.repeat(400) });
  return line.includes('err=boom') && !line.includes('agent=') && line.length < 400;
});

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
if (bad > 0) process.exit(1);
