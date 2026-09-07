// Render smoke for the Team window + its pure chart helpers.
//
// Run: cd web && npx tsx src/components/team-render.test.mts
//
// No browser: renderToString runs no effects, so the window shows its
// loading state — that still catches broken imports, invalid JSX and
// hook order. The helpers (chart order, cycle guard, reparent, remove)
// are pure and tested directly.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { chartOrder, isSelfOrDescendant, removeFromChart, reparent, TeamWindow } from './TeamWindow';
import type { TeamFileDto } from '../lib/api';

let ok = 0;
let bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};
function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

const file: TeamFileDto = {
  version: 1,
  principal: { name: 'Ada' },
  agents: {
    atlas: { reports_to: 'principal' },
    hans: { reports_to: 'atlas' },
    lisa: { reports_to: 'atlas' },
    hans2: { reports_to: 'hans' },
  },
};

t('chartOrder walks parent before children', () =>
  assert(chartOrder(file.agents).map((o) => `${o.name}:${o.depth}`).join(',') === 'atlas:0,hans:1,hans2:2,lisa:1', JSON.stringify(chartOrder(file.agents))));
t('isSelfOrDescendant: self', () => assert(isSelfOrDescendant(file.agents, 'hans', 'hans'), 'self'));
t('isSelfOrDescendant: grandchild', () => assert(isSelfOrDescendant(file.agents, 'atlas', 'hans2'), 'hans2 under atlas'));
t('isSelfOrDescendant: sibling is not', () => assert(!isSelfOrDescendant(file.agents, 'hans', 'lisa'), 'lisa not under hans'));
t('reparent refuses a cycle', () => assert(reparent(file, 'atlas', 'hans2') === null, 'atlas under its own grandchild'));
t('reparent to a sibling works', () => {
  const r = reparent(file, 'lisa', 'hans');
  assert(r !== null && r.agents.lisa!.reports_to === 'hans', 'lisa under hans');
});
t('reparent to principal works', () => {
  const r = reparent(file, 'hans2', 'principal');
  assert(r !== null && r.agents.hans2!.reports_to === 'principal', 'hans2 at top');
});
t('removeFromChart lifts reports to the parent', () => {
  const r = removeFromChart(file, 'hans');
  assert(!r.agents.hans && r.agents.hans2!.reports_to === 'atlas', JSON.stringify(r.agents));
});
t('orphan still listed by chartOrder', () => {
  const o = chartOrder({ a: { reports_to: 'ghost' } });
  assert(o.length === 1 && o[0]!.name === 'a', JSON.stringify(o));
});
t('TeamWindow renders its loading state', () => {
  const html = renderToString(React.createElement(TeamWindow));
  assert(html.includes('Loading'), html.slice(0, 200));
});

console.log(`\n${ok} ok, ${bad} failed`);
if (bad > 0) process.exit(1);
