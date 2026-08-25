// Render-Smoke fuer den Desktop-Icon-Layer.
//
// Lauf: cd web && npx tsx src/components/desktop-icons-render.test.mts
//
// Kein Browser hier, also wird die Drag-Geste selbst NICHT geprueft —
// die Platzierungs-Logik dahinter deckt hooks/desktop-icons.test.mts
// ab. Was hier abgesichert wird: dass der Layer ueberhaupt rendert,
// dass jedes Icon eine Zelle bekommt, und dass ein fehlender oder
// kaputter localStorage ihn nicht umbringt (Safari im Private Mode
// wirft beim Zugriff).
//
// Ohne Layout-Engine misst der ResizeObserver nichts, das Raster ist
// also 1 Spalte breit — Positionen werden deshalb hier nur grob
// geprueft, nicht im Detail.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { DesktopIcons } from './DesktopIcons';
import { AgentTile } from './AgentTile';

let ok = 0, bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};

/** Minimaler localStorage-Ersatz. `null` = gar kein Storage vorhanden. */
function setStorage(value: string | null | 'throw') {
  if (value === null) {
    delete (globalThis as Record<string, unknown>).localStorage;
    return;
  }
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: () => {
      if (value === 'throw') throw new Error('storage disabled');
      return value;
    },
    setItem: () => {},
  };
}

const icons = [
  { id: 'agent:nova', node: React.createElement('div', null, 'NOVA') },
  { id: 'app:tools', node: React.createElement('div', null, 'TOOLS') },
  { id: 'agent:atlas', node: React.createElement('div', null, 'ATLAS') },
];

const idsIn = (html: string) =>
  [...html.matchAll(/data-icon-id="([^"]+)"/g)].map((m) => m[1]);

t('alle Icons bekommen eine Zelle', () => {
  setStorage(null);
  const html = renderToString(React.createElement(DesktopIcons, { icons }));
  const got = idsIn(html);
  if (got.length !== 3) throw new Error(`nur ${got.length} Icons`);
});

t('Icons werden absolut positioniert', () => {
  setStorage(null);
  const html = renderToString(React.createElement(DesktopIcons, { icons }));
  // GRID_PAD = 24 -> das erste Icon sitzt oben links.
  if (!html.includes('left:24px')) throw new Error('keine left-Position im Markup');
  if (!html.includes('top:24px')) throw new Error('keine top-Position im Markup');
});

t('gespeicherte Positionen brechen nichts', () => {
  setStorage(JSON.stringify({ 'agent:atlas': { col: 4, row: 2 } }));
  const html = renderToString(React.createElement(DesktopIcons, { icons }));
  if (idsIn(html).length !== 3) throw new Error('Icons fehlen');
});

t('unbekannte IDs im Storage brechen nichts', () => {
  setStorage(JSON.stringify({ 'gibts:nicht': { col: 1, row: 1 } }));
  const html = renderToString(React.createElement(DesktopIcons, { icons }));
  if (idsIn(html).length !== 3) throw new Error('Icons fehlen');
});

t('Muell im Storage faellt auf Standard-Layout zurueck', () => {
  for (const junk of ['{nicht mal json', '[]', '{"a":42}', '{"a":{"col":"x","row":1}}', 'null']) {
    setStorage(junk);
    const html = renderToString(React.createElement(DesktopIcons, { icons }));
    if (idsIn(html).length !== 3) throw new Error(`Icons fehlen bei ${junk}`);
  }
});

t('negative Koordinaten werden verworfen', () => {
  setStorage(JSON.stringify({ 'agent:nova': { col: -5, row: -5 } }));
  const html = renderToString(React.createElement(DesktopIcons, { icons }));
  if (idsIn(html).length !== 3) throw new Error('Icons fehlen');
  if (html.includes('left:-')) throw new Error('negative Position gerendert');
});

t('werfender localStorage bricht den Desktop nicht', () => {
  setStorage('throw');
  const html = renderToString(React.createElement(DesktopIcons, { icons }));
  if (idsIn(html).length !== 3) throw new Error('Icons fehlen');
});

t('loading- und error-Zustand bleiben erhalten', () => {
  setStorage(null);
  const loading = renderToString(React.createElement(DesktopIcons, { icons: [], loading: true }));
  if (!loading.includes('loading')) throw new Error('loading-Hinweis fehlt');
  const err = renderToString(React.createElement(DesktopIcons, { icons: [], error: 'boom' }));
  if (!err.includes('server unreachable')) throw new Error('Fehler-Hinweis fehlt');
});

t('kein Drop-Ziel und kein in-hand-Zustand ohne Drag', () => {
  setStorage(null);
  const html = renderToString(React.createElement(DesktopIcons, { icons }));
  if (html.includes('desktop-drop-target')) throw new Error('Drop-Ziel ohne Drag sichtbar');
  if (html.includes('in-hand')) throw new Error('in-hand ohne Drag gesetzt');
});

t('echte AgentTile rendert im Icon-Layer', () => {
  setStorage(null);
  const html = renderToString(
    React.createElement(DesktopIcons, {
      icons: [
        {
          id: 'agent:nova',
          node: React.createElement(AgentTile, {
            agent: { name: 'nova', description: 'test', icon: '⭐', role: 'Assistant' },
            onClick: () => {},
          }),
        },
      ],
    }),
  );
  if (!html.includes('nova')) throw new Error('Agent-Name fehlt');
  if (!html.includes('agent-icon-glyph')) throw new Error('Glyph fehlt');
});

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad === 0 ? 0 : 1);
