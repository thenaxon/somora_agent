// Render-Smoke fuer das Media-Fenster (Bilder + Video).
//
// Lauf: cd web && npx tsx src/components/media-render.test.mts
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
  MediaWindow,
  specSummary,
} from './MediaWindow';

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
  const html = renderToString(React.createElement(MediaWindow));
  assert(html.length > 0, 'leeres Markup');
});

t('zeigt das Formular', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(html.includes('Prompt'), 'Prompt-Feld fehlt');
  assert(html.includes('Generate'), 'Generate-Knopf fehlt');
});

// Die Feldliste ist die Vereinigungsmenge ueber alle Anbieter; welche
// davon sichtbar sind, entscheidet spaeter die Capability-Abfrage. Ohne
// geladene Capabilities muessen also ALLE erscheinen — fehlt eines hier,
// ist es bei keinem Modell erreichbar, egal was dessen Katalog sagt.
// 'Size (pixels)' hat genau so gefehlt: Modelle, die in Pixeln statt in
// Stufen denken, waren im Formular nicht bedienbar (2026-08-27).
t('zeigt alle Spec-Felder', () => {
  const html = renderToString(React.createElement(MediaWindow));
  for (const label of [
    'Aspect ratio', 'Size (pixels)', 'Resolution', 'Quality', 'Format', 'Background',
  ]) {
    assert(html.includes(label), `${label} fehlt`);
  }
});

// Ohne geladenen Video-Status darf das Fenster nicht so tun, als
// gaebe es Video: der Umschalter erscheint erst, wenn der Server
// welches meldet. Ein Formular fuer etwas Unkonfiguriertes ist genau
// die Falle, die wir bei den Bild-Tools schon zugemacht haben.
t('ohne Video-Konfiguration kein Video-Umschalter', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(!html.includes('media-mode-switch'), 'Modus-Umschalter faelschlich sichtbar');
});

// Der Medien-Filter haengt an derselben Bedingung: mit nur Bildern im
// System waeren zwei der drei Knoepfe tot.
t('ohne Video-Konfiguration auch kein Medien-Filter', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(!html.includes('>Images<'), 'Filter faelschlich sichtbar');
});

t('Reload-Knopf ist immer da', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(html.includes('Reload the gallery'), 'Reload fehlt');
});

t('leere Galerie sagt das auch', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(html.includes('No images yet'), 'Leer-Hinweis fehlt');
});

t('Generate ist ohne Prompt deaktiviert', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(html.includes('disabled'), 'Knopf nicht deaktiviert');
});

// Ohne bekannte Fähigkeiten muessen die Spec-Felder Freitext sein.
// Ein leeres Dropdown wuerde "nichts erlaubt" bedeuten und ein
// voellig brauchbares Modell kaputt aussehen lassen.
t('ohne Katalog sind die Spec-Felder Freitext', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(html.includes('e.g. 16:9'), 'Freitext-Platzhalter fehlt');
});

t('nennt den Ablageort im Formular', () => {
  const html = renderToString(React.createElement(MediaWindow));
  assert(html.includes('Every image is kept in'), 'Hinweis zum Ablageort fehlt');
});

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
if (bad > 0) process.exit(1);
