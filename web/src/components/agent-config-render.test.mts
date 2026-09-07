// Render smoke for the Agent window (persona files + prompt budget).
//
// Run: cd web && npx tsx src/components/agent-config-render.test.mts
import React from 'react';
import { renderToString } from 'react-dom/server';
import { AgentConfigWindow, Meter, estTokens, fmt } from './AgentConfigWindow';

let ok = 0;
let bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};
function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

t('estTokens is chars/4 rounded', () => assert(estTokens(10) === 3 && estTokens(4000) === 1000, String(estTokens(10))));
t('fmt groups thousands', () => assert(fmt(12345) === '12,345', fmt(12345)));
t('Meter under cap renders value / cap', () => {
  const html = renderToString(React.createElement(Meter, { title: 'x', value: 1200, cap: 3000 }));
  assert(html.includes('1,200') && html.includes('3,000') && html.includes('var(--text-0)'), html.slice(0, 300));
});
t('Meter over cap uses the warn colour', () => {
  const html = renderToString(React.createElement(Meter, { title: 'x', value: 3200, cap: 3000 }));
  assert(html.includes('var(--warn)'), html.slice(0, 300));
});
t('AgentConfigWindow renders its loading state', () => {
  const html = renderToString(React.createElement(AgentConfigWindow, { agentName: 'x' }));
  assert(html.includes('Loading'), html.slice(0, 200));
});

console.log(`\n${ok} ok, ${bad} failed`);
if (bad > 0) process.exit(1);
