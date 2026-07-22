// Render-Smoke fuer die Wiki-Komponenten.
//
// Lauf: cd web && npx tsx src/components/wiki-render.test.mts
//
// Kein Browser hier — aber renderToString faengt kaputte Imports,
// ungueltiges JSX und Hook-Reihenfolge-Fehler ab. Genau die Klasse
// Fehler, die sonst erst beim Oeffnen des Fensters auffaellt.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { WikiGraph } from './WikiGraph';
import { WikiWindow } from './WikiWindow';

let ok = 0, bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};

t('WikiWindow ohne Seite', () => {
  const html = renderToString(React.createElement(WikiWindow, { onSlugChange: () => {} }));
  if (!html.includes('wiki-root')) throw new Error('kein wiki-root im Markup');
  if (!html.includes('Wähle links eine Seite')) throw new Error('Leerzustand fehlt');
});

t('WikiWindow mit Slug', () => {
  renderToString(React.createElement(WikiWindow, { slug: 'projekte/somora', onSlugChange: () => {} }));
});

t('WikiGraph leer', () => {
  const html = renderToString(React.createElement(WikiGraph, {
    graph: { scope: 'local', nodes: [], edges: [], truncated: false },
    activeSlug: null, onOpen: () => {},
  }));
  if (!html.includes('Keine Verbindungen')) throw new Error('Leerzustand fehlt');
});

t('WikiGraph mit Knoten', () => {
  const html = renderToString(React.createElement(WikiGraph, {
    graph: {
      scope: 'local',
      nodes: [
        { id: 'a/x', label: 'X', folder: 'a', degree: 3 },
        { id: 'b/y', label: 'Y', folder: 'b', degree: 1 },
      ],
      edges: [{ from: 'a/x', to: 'b/y', type: 'wikilink' as const }],
      truncated: false,
    },
    activeSlug: 'a/x', onOpen: () => {},
  }));
  if (!html.includes('<svg')) throw new Error('kein svg');
});

t('WikiGraph gekuerzt zeigt Hinweis', () => {
  const html = renderToString(React.createElement(WikiGraph, {
    graph: { scope: 'global', nodes: [{ id: 'a', label: 'A', folder: '', degree: 0 }], edges: [], truncated: true },
    activeSlug: null, onOpen: () => {},
  }));
  if (!html.includes('Gekürzt')) throw new Error('Kuerzungs-Hinweis fehlt');
});

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad === 0 ? 0 : 1);
