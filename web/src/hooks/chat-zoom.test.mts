// Tests fuer die Chat-Zoomstufen.
//
// Lauf: cd web && npx tsx src/hooks/chat-zoom.test.mts
//
// stepZoom ist pure — geprueft wird vor allem, dass die Enden hart
// stoppen (sonst zoomt man sich aus dem Fenster) und dass ein Wert aus
// einem aelteren Build, der nicht mehr in der Liste steht, nicht
// haengenbleibt.
import { DEFAULT_ZOOM, ZOOM_LEVELS, stepZoom, withSessionZoom, zoomFor } from './useChatZoom';

let ok = 0, bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};

const eq = (got: number, want: number, msg: string) => {
  if (got !== want) throw new Error(`${msg}: ${got} != ${want}`);
};

const MIN = ZOOM_LEVELS[0] as number;
const MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1] as number;

t('Standard ist 100%', () => {
  eq(DEFAULT_ZOOM, 1, 'default');
  if (!ZOOM_LEVELS.includes(1)) throw new Error('100% fehlt in den Stufen');
});

t('Stufen sind aufsteigend sortiert', () => {
  for (let i = 1; i < ZOOM_LEVELS.length; i++) {
    if ((ZOOM_LEVELS[i] as number) <= (ZOOM_LEVELS[i - 1] as number)) {
      throw new Error(`Stufe ${i} nicht groesser als die davor`);
    }
  }
});

t('hochzoomen geht eine Stufe weiter', () => {
  eq(stepZoom(1, 1), 1.1, 'von 100%');
  eq(stepZoom(1.1, 1), 1.25, 'von 110%');
});

t('runterzoomen geht eine Stufe zurueck', () => {
  eq(stepZoom(1, -1), 0.9, 'von 100%');
  eq(stepZoom(0.9, -1), MIN, 'von 90%');
});

t('am oberen Ende ist Schluss', () => {
  eq(stepZoom(MAX, 1), MAX, 'max');
});

t('am unteren Ende ist Schluss', () => {
  eq(stepZoom(MIN, -1), MIN, 'min');
});

t('hoch und wieder runter landet am Ausgangspunkt', () => {
  for (const level of ZOOM_LEVELS) {
    if (level === MAX) continue;
    eq(stepZoom(stepZoom(level, 1), -1), level, `hin und zurueck ab ${level}`);
  }
});

t('Wert zwischen zwei Stufen rastet auf die naechste ein', () => {
  // Etwa ein von Hand editierter localStorage-Wert.
  eq(stepZoom(1.12, 1), 1.25, 'krummer Wert hoch');
  eq(stepZoom(1.12, -1), 1, 'krummer Wert runter');
});

t('Wert weit ausserhalb bleibt im gueltigen Bereich', () => {
  const up = stepZoom(99, 1);
  const down = stepZoom(-99, -1);
  if (up > MAX || up < MIN) throw new Error(`ausserhalb: ${up}`);
  if (down > MAX || down < MIN) throw new Error(`ausserhalb: ${down}`);
});

t('jede Stufe ist von 100% aus erreichbar', () => {
  // Sonst gaebe es Stufen, die man per Knopf nie trifft.
  const seen = new Set<number>([1]);
  let z = 1;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) { z = stepZoom(z, 1); seen.add(z); }
  z = 1;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) { z = stepZoom(z, -1); seen.add(z); }
  for (const level of ZOOM_LEVELS) {
    if (!seen.has(level)) throw new Error(`Stufe ${level} nicht erreichbar`);
  }
});

t('Zoom gilt pro Session, nicht pro Agent', () => {
  let m = withSessionZoom({}, 'ada', 'main', 1.25);
  eq(zoomFor(m, 'ada', 'main'), 1.25, 'main');
  eq(zoomFor(m, 'ada', 'projekt'), 1, 'andere Session bleibt bei 100%');
  eq(zoomFor(m, 'bea', 'main'), 1, 'anderer Agent bleibt bei 100%');
  m = withSessionZoom(m, 'ada', 'projekt', 0.9);
  eq(zoomFor(m, 'ada', 'main'), 1.25, 'main unveraendert');
  eq(zoomFor(m, 'ada', 'projekt'), 0.9, 'projekt eigener Wert');
});

t('alter Agent-Wert ist Startwert, bis die Session einen eigenen hat', () => {
  const old = { ada: 1.5 };
  eq(zoomFor(old, 'ada', 'main'), 1.5, 'geerbt');
  const m = withSessionZoom(old, 'ada', 'main', 1.75);
  eq(zoomFor(m, 'ada', 'main'), 1.75, 'eigener Wert');
  eq(zoomFor(m, 'ada', 'projekt'), 1.5, 'andere Session erbt weiter');
  eq(m.ada as number, 1.5, 'Agent-Wert bleibt erhalten');
});

t('Zuruecksetzen auf 100% haelt auch gegen einen geerbten Agent-Wert', () => {
  const m = withSessionZoom({ ada: 1.5 }, 'ada', 'main', 1);
  eq(zoomFor(m, 'ada', 'main'), 1, 'reset');
  const plain = withSessionZoom({ 'ada/main': 1.25 }, 'ada', 'main', 1);
  if ('ada/main' in plain) throw new Error('100% ohne geerbten Wert wird als Fehlen gespeichert');
});

t('hoechstens 200 Session-Eintraege, die aeltesten fallen weg', () => {
  let m: Record<string, number> = { ada: 1.5 };
  for (let i = 0; i < 230; i++) m = withSessionZoom(m, 'ada', `s${i}`, 1.25);
  const keys = Object.keys(m).filter((k) => k.includes('/'));
  eq(keys.length, 200, 'Anzahl');
  if ('ada/s0' in m || !('ada/s229' in m)) throw new Error('falsche Eintraege entfernt');
  eq(m.ada as number, 1.5, 'Agent-Wert zaehlt nicht mit');
});

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad === 0 ? 0 : 1);
