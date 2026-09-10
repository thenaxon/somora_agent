// Render smoke for the Abilities window + its collapsible group header.
//
// Run: cd web && npx tsx src/components/tools-render.test.mts
//
// No browser: renderToString runs no effects, so the window itself shows
// its loading state — that still catches broken imports, invalid JSX and
// hook order. The group header is worth rendering properly, because what
// it shows IS the feature: counts while collapsed, and an eye whose
// three states (all visible / some hidden / all hidden) have to be told
// apart at a glance.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { Group, ToolsWindow } from './ToolsWindow';

let ok = 0;
let bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};
function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

type GroupProps = React.ComponentProps<typeof Group>;

const render = (el: React.ReactElement) => renderToString(el);
const group = (props: Partial<Omit<GroupProps, 'children'>>) => {
  const full: GroupProps = {
    groupKey: 'exec',
    label: 'exec',
    total: 12,
    hidden: 0,
    expanded: false,
    onToggleExpanded: () => {},
    onToggleAll: () => {},
    ...props,
    children: React.createElement('div', null, 'exec_bash'),
  };
  return render(React.createElement(Group, full));
};

t('the window renders (loading state, no effects)', () => {
  const html = render(React.createElement(ToolsWindow));
  assert(html.includes('Loading'), 'no loading state');
  assert(html.includes('MCP servers'), 'MCP panel missing');
});

t('a collapsed group hides its rows but keeps the count', () => {
  const html = group({ expanded: false });
  assert(!html.includes('exec_bash'), 'rows rendered while collapsed');
  assert(html.includes('12'), 'count missing');
});

t('an expanded group renders its rows', () => {
  const html = group({ expanded: true });
  assert(html.includes('exec_bash'), 'rows missing while expanded');
});

t('hidden abilities are counted in the header', () => {
  const html = group({ hidden: 3 });
  assert(html.includes('3 hidden'), 'hidden count missing');
  assert(!group({ hidden: 0 }).includes('hidden'), 'says hidden with nothing hidden');
});

t('a fully hidden group shows the closed eye', () => {
  const closed = group({ total: 12, hidden: 12 });
  const open = group({ total: 12, hidden: 0 });
  assert(closed.includes('eye-off'), 'no closed eye when everything is hidden');
  assert(!open.includes('eye-off'), 'closed eye on a fully visible group');
});

t('a half-hidden group is dimmed, not closed', () => {
  const html = group({ total: 12, hidden: 5 });
  assert(!html.includes('eye-off'), 'mixed group shows the closed eye');
  assert(html.includes('opacity:0.55') || html.includes('opacity: 0.55'), 'mixed group is not dimmed');
});

t('a read-only group offers no group toggle', () => {
  const html = group({ onToggleAll: undefined });
  assert(html.includes('not-allowed'), 'read-only group still looks clickable');
});

console.log(`\n${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
