// Render-Smoke fuer das Images-Fenster.
//
// Lauf: cd web && npx tsx src/components/images-render.test.mts
//
// Kein Browser hier — renderToString fuehrt keine Effects aus, es
// werden also weder Status noch Galerie geladen. Was das hier abdeckt:
// kaputte Imports, ungueltiges JSX, Hook-Reihenfolge, und die beiden
// Zustaende, die ohne Daten erreichbar sind (leer und "nicht
// konfiguriert"). Die Formatierer sind rein und werden direkt geprueft.
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  formatBytes,
  formatCost,
  formatWhen,
  ImagesWindow,
  specSummary,
} from './ImagesWindow';

let ok = 0;
let bad = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    ok++;
    console.log('  ok  ', name);
  } catch (e) {
    bad++;
    console.error('  FAIL', name, '->', (e as Error).message);
  }
};

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Formatierer ─────────────────────────────────────────────────────

t('formatBytes: Bytes', () => assert(formatBytes(512) === '512 B', formatBytes(512)));
t('formatBytes: Kilobytes', () => assert(formatBytes(2048) === '2 KB', formatBytes(2048)));
t('formatBytes: Megabytes', () =>
  assert(formatBytes(3.5 * 1024 * 1024) === '3.5 MB', formatBytes(3.5 * 1024 * 1024)));
t('formatBytes: Gigabytes', () =>
  assert(formatBytes(2 * 1024 ** 3) === '2.00 GB', formatBytes(2 * 1024 ** 3)));
t('formatBytes: Null', () => assert(formatBytes(0) === '0 B', formatBytes(0)));

// Ein Bild unter einem Cent darf nicht als "$0.00" erscheinen — das
// laese sich wie kostenlos.
t('formatCost: Sub-Cent wird nicht zu 0.00', () =>
  assert(formatCost(0.004) === '<$0.01', String(formatCost(0.004))));
t('formatCost: normaler Betrag', () =>
  assert(formatCost(0.08) === '$0.08', String(formatCost(0.08))));
t('formatCost: gerundet auf zwei Stellen', () =>
  assert(formatCost(0.1234) === '$0.12', String(formatCost(0.1234))));
t('formatCost: fehlender Betrag bleibt leer', () => assert(formatCost(undefined) === null, 'null'));

t('formatWhen: liefert Datum und Uhrzeit', () => {
  const out = formatWhen('2026-08-26T14:30:12.000Z');
  assert(out.length > 8 && out.includes(' '), out);
});

t('specSummary: Reihenfolge des Formulars', () =>
  assert(
    specSummary({ resolution: '2K', aspect_ratio: '16:9' }) === '16:9 · 2K',
    specSummary({ resolution: '2K', aspect_ratio: '16:9' }),
  ));
t('specSummary: leere Specs ergeben leeren String', () => assert(specSummary({}) === '', 'leer'));
t('specSummary: Zahlen werden uebersprungen', () =>
  assert(specSummary({ seed: 42, resolution: '1K' }) === '1K', specSummary({ seed: 42, resolution: '1K' })));
t('specSummary: unbekannte Felder tauchen nicht auf', () =>
  assert(specSummary({ irgendwas: 'x' }) === '', specSummary({ irgendwas: 'x' })));

// ── Rendering ───────────────────────────────────────────────────────

t('rendert ohne Daten', () => {
  const html = renderToString(React.createElement(ImagesWindow));
  assert(html.length > 0, 'leeres Markup');
});

t('zeigt das Formular', () => {
  const html = renderToString(React.createElement(ImagesWindow));
  assert(html.includes('Prompt'), 'Prompt-Feld fehlt');
  assert(html.includes('Generate'), 'Generate-Knopf fehlt');
});

t('zeigt alle Spec-Felder', () => {
  const html = renderToString(React.createElement(ImagesWindow));
  for (const label of ['Aspect ratio', 'Resolution', 'Quality', 'Format', 'Background']) {
    assert(html.includes(label), `${label} fehlt`);
  }
});

t('leere Galerie sagt das auch', () => {
  const html = renderToString(React.createElement(ImagesWindow));
  assert(html.includes('No images yet'), 'Leer-Hinweis fehlt');
});

t('Generate ist ohne Prompt deaktiviert', () => {
  const html = renderToString(React.createElement(ImagesWindow));
  assert(html.includes('disabled'), 'Knopf nicht deaktiviert');
});

// Ohne bekannte Fähigkeiten muessen die Spec-Felder Freitext sein.
// Ein leeres Dropdown wuerde "nichts erlaubt" bedeuten und ein
// voellig brauchbares Modell kaputt aussehen lassen.
t('ohne Katalog sind die Spec-Felder Freitext', () => {
  const html = renderToString(React.createElement(ImagesWindow));
  assert(html.includes('e.g. 16:9'), 'Freitext-Platzhalter fehlt');
});

t('nennt den Ablageort im Formular', () => {
  const html = renderToString(React.createElement(ImagesWindow));
  assert(html.includes('Every image is kept in'), 'Hinweis zum Ablageort fehlt');
});

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
if (bad > 0) process.exit(1);
