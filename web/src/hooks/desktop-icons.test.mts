// Tests fuer die Icon-Platzierung auf dem Desktop.
//
// Lauf: cd web && npx tsx src/hooks/desktop-icons.test.mts
//
// layoutIcons/placeIcon/gridSize sind absichtlich pure — die
// interessanten Faelle sind alle Konflikte (zwei Icons wollen dieselbe
// Zelle, gespeicherte Zelle liegt ausserhalb des geschrumpften Rasters,
// Icon ohne gespeicherte Position), und die will man ohne Browser
// pruefen koennen.
import { gridSize, layoutIcons, placeIcon, type IconPositions } from './useDesktopIcons';

let ok = 0, bad = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); ok++; console.log('  ok  ', name); }
  catch (e) { bad++; console.error('  FAIL', name, '->', (e as Error).message); }
};

/** Layout als kompakter String, z.B. "a@0,0 b@0,1". */
const fmt = (m: Map<string, { col: number; row: number }>) =>
  [...m.entries()].map(([id, c]) => `${id}@${c.col},${c.row}`).join(' ');

const eq = (got: string, want: string, msg: string) => {
  if (got !== want) throw new Error(`${msg}: "${got}" != "${want}"`);
};

// --- Standard-Layout ----------------------------------------------

t('ohne gespeicherte Position: linke Spalte von oben nach unten', () => {
  // Das ist bewusst identisch zum alten Dock — ein unberuehrter
  // Desktop sieht aus wie vorher.
  const got = layoutIcons({}, ['a', 'b', 'c'], 2, 2);
  eq(fmt(got), 'a@0,0 b@0,1 c@1,0', 'default');
});

t('gespeicherte Position schlaegt die Standard-Reihenfolge', () => {
  const stored: IconPositions = { c: { col: 0, row: 0 } };
  const got = layoutIcons(stored, ['a', 'b', 'c'], 2, 2);
  eq(fmt(got), 'c@0,0 a@0,1 b@1,0', 'gespeichert');
});

t('Icon darf ganz rechts liegen', () => {
  const stored: IconPositions = { a: { col: 9, row: 3 } };
  const got = layoutIcons(stored, ['a'], 10, 4);
  eq(fmt(got), 'a@9,3', 'rechts');
});

t('Agents und Apps sind frei mischbar', () => {
  const stored: IconPositions = {
    'app:tools': { col: 0, row: 0 },
    'agent:nova': { col: 0, row: 1 },
  };
  const got = layoutIcons(stored, ['agent:nova', 'app:tools'], 2, 2);
  eq(fmt(got), 'app:tools@0,0 agent:nova@0,1', 'gemischt');
});

// --- Resize: der Kern der Sache -----------------------------------

t('Fenster kleiner: Icon rutscht ins Sichtbare statt zu verschwinden', () => {
  const stored: IconPositions = { a: { col: 8, row: 0 } };
  const got = layoutIcons(stored, ['a'], 2, 2);
  eq(fmt(got), 'a@1,0', 'geklemmt');
});

t('Fenster wieder groesser: Icon kehrt an seinen Originalplatz zurueck', () => {
  // Der eigentliche Trick — gespeichert wird die Wunschposition, das
  // Klemmen passiert nur beim Zeichnen. Ein kurzzeitig schmales
  // Fenster darf ein Layout nicht dauerhaft zerstoeren.
  const stored: IconPositions = { a: { col: 8, row: 0 } };
  eq(fmt(layoutIcons(stored, ['a'], 2, 2)), 'a@1,0', 'klein');
  eq(fmt(layoutIcons(stored, ['a'], 10, 4)), 'a@8,0', 'wieder gross');
});

t('kein Icon geht beim Schrumpfen verloren', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const stored: IconPositions = {
    a: { col: 9, row: 3 }, b: { col: 8, row: 3 }, c: { col: 7, row: 2 },
  };
  for (const [w, h] of [[1280, 800], [800, 600], [420, 400], [200, 200], [0, 0]]) {
    const { cols, rows } = gridSize(w!, h!, ids.length);
    const got = layoutIcons(stored, ids, cols, rows);
    if (got.size !== ids.length) throw new Error(`${w}x${h}: nur ${got.size}/${ids.length} platziert`);
    const cells = new Set([...got.values()].map((c) => `${c.col}:${c.row}`));
    if (cells.size !== ids.length) throw new Error(`${w}x${h}: Zellen doppelt belegt`);
    for (const c of got.values()) {
      if (c.col < 0 || c.col >= cols || c.row < 0 || c.row >= rows) {
        throw new Error(`${w}x${h}: Zelle ${c.col},${c.row} ausserhalb ${cols}x${rows}`);
      }
    }
  }
});

t('gleiches Raster, gleiches Ergebnis (kein Flackern zwischen Renders)', () => {
  const stored: IconPositions = { b: { col: 1, row: 1 } };
  const ids = ['a', 'b', 'c', 'd'];
  const once = fmt(layoutIcons(stored, ids, 3, 3));
  const twice = fmt(layoutIcons(stored, ids, 3, 3));
  eq(once, twice, 'stabil');
});

t('zwei Icons auf derselben gespeicherten Zelle kollidieren nicht', () => {
  const stored: IconPositions = { a: { col: 0, row: 0 }, b: { col: 0, row: 0 } };
  const got = layoutIcons(stored, ['a', 'b'], 2, 2);
  if (got.size !== 2) throw new Error('nicht beide platziert');
  const cells = new Set([...got.values()].map((c) => `${c.col}:${c.row}`));
  if (cells.size !== 2) throw new Error('beide auf derselben Zelle');
});

t('entartetes Raster liefert leeres Layout statt zu werfen', () => {
  if (layoutIcons({}, ['a'], 0, 0).size !== 0) throw new Error('sollte leer sein');
});

// --- Tauschen -----------------------------------------------------

t('Drop auf belegte Zelle tauscht die beiden Icons', () => {
  const stored: IconPositions = { a: { col: 0, row: 0 }, b: { col: 1, row: 1 } };
  const layout = layoutIcons(stored, ['a', 'b'], 3, 3);
  const next = placeIcon(stored, layout, 'a', { col: 1, row: 1 });
  eq(`${next.a!.col},${next.a!.row}`, '1,1', 'a nach b');
  eq(`${next.b!.col},${next.b!.row}`, '0,0', 'b nach a');
});

t('Drop auf freie Zelle laesst die anderen in Ruhe', () => {
  const stored: IconPositions = { a: { col: 0, row: 0 }, b: { col: 1, row: 1 } };
  const layout = layoutIcons(stored, ['a', 'b'], 4, 4);
  const next = placeIcon(stored, layout, 'a', { col: 3, row: 2 });
  eq(`${next.a!.col},${next.a!.row}`, '3,2', 'a verschoben');
  eq(`${next.b!.col},${next.b!.row}`, '1,1', 'b unveraendert');
});

t('Tausch mit einem nie bewegten Icon funktioniert auch', () => {
  // b hat keine gespeicherte Position, liegt aber sichtbar auf 0,1 —
  // getauscht wird gegen die GEZEICHNETE Zelle, nicht die gespeicherte.
  const stored: IconPositions = {};
  const layout = layoutIcons(stored, ['a', 'b'], 2, 2);
  const next = placeIcon(stored, layout, 'a', { col: 0, row: 1 });
  eq(`${next.a!.col},${next.a!.row}`, '0,1', 'a nach unten');
  eq(`${next.b!.col},${next.b!.row}`, '0,0', 'b nach oben');
});

t('placeIcon veraendert das Original nicht', () => {
  const stored: IconPositions = { a: { col: 0, row: 0 } };
  const layout = layoutIcons(stored, ['a'], 2, 2);
  placeIcon(stored, layout, 'a', { col: 1, row: 1 });
  eq(`${stored.a!.col},${stored.a!.row}`, '0,0', 'unveraendert');
});

// --- Rastergroesse ------------------------------------------------

t('normales Fenster: viel Platz', () => {
  const { cols, rows } = gridSize(1280, 800, 10);
  if (cols < 10 || rows < 5) throw new Error(`zu klein: ${cols}x${rows}`);
});

t('winziges Fenster: Raster waechst nach unten statt Icons zu verlieren', () => {
  const { cols, rows } = gridSize(300, 300, 12);
  if (cols * rows < 12) throw new Error(`Kapazitaet ${cols * rows} < 12`);
});

t('Nullgroesse (erster Render vor dem Messen) bleibt benutzbar', () => {
  const { cols, rows } = gridSize(0, 0, 5);
  if (cols < 1 || rows < 5) throw new Error(`${cols}x${rows}`);
});

console.log(`\n${ok} ok, ${bad} fehlgeschlagen`);
process.exit(bad === 0 ? 0 : 1);
