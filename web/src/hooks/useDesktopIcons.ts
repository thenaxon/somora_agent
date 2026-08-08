// Desktop icon placement — grid coordinates for agent + app tiles.
//
// The desktop is a grid of cells spanning the whole area above the
// taskbar, and every icon owns one cell. Icons snap to cells, so the
// surface stays tidy, but any cell is fair game: left column, middle,
// far right.
//
// The resize problem and how it is solved
// ---------------------------------------
// A naive "store x/y pixels" implementation loses icons the moment the
// window shrinks — the icon at x=1600 is simply gone at 1200px wide.
// So two positions are kept apart:
//
//   stored   the cell the user PUT the icon in. Source of truth,
//            never rewritten by a resize.
//   laid out the cell the icon is DRAWN in right now, derived from
//            stored + the current grid size.
//
// Shrinking relocates an icon to the nearest free cell that still fits;
// growing restores it, because `stored` was never touched. An icon can
// therefore never end up off-screen, and a transient resize never
// permanently scrambles a layout the user arranged.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Cell footprint in px. Wider/taller than the 88-px tile so icons get
 *  breathing room; the tile is centred in its cell. Mirrored by
 *  `.desktop-icon` in desktop.css. */
export const CELL_W = 100;
export const CELL_H = 112;
/** Inset from the desktop edges, matching the old dock's top-left
 *  origin so the default layout is pixel-identical to before. */
export const GRID_PAD = 24;

const STORAGE_KEY = 'somora-desktop-icons';

export interface Cell {
  col: number;
  row: number;
}

export type IconPositions = Record<string, Cell>;

const cellKey = (c: Cell) => `${c.col}:${c.row}`;

/** How many whole cells fit, and how many rows the icons actually need.
 *  Rows can exceed what fits: with more icons than cells the grid grows
 *  downwards rather than dropping anyone (the layer scrolls). */
export function gridSize(width: number, height: number, iconCount: number) {
  const cols = Math.max(1, Math.floor((width - GRID_PAD * 2) / CELL_W));
  const fitRows = Math.max(1, Math.floor((height - GRID_PAD * 2) / CELL_H));
  const neededRows = Math.ceil(iconCount / cols);
  return { cols, rows: Math.max(fitRows, neededRows) };
}

function clamp(c: Cell, cols: number, rows: number): Cell {
  return {
    col: Math.min(Math.max(c.col, 0), cols - 1),
    row: Math.min(Math.max(c.row, 0), rows - 1),
  };
}

/** Free cell closest to `target`, or the first free cell in column-major
 *  order when there is no target. Column-major is what makes the
 *  default layout reproduce the original vertical dock: fill the left
 *  column top-to-bottom, then start the next one. */
function nearestFree(
  target: Cell | null,
  cols: number,
  rows: number,
  taken: ReadonlySet<string>,
): Cell | null {
  let best: Cell | null = null;
  let bestDist = Infinity;
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      const cell = { col, row };
      if (taken.has(cellKey(cell))) continue;
      if (!target) return cell;
      const dx = col - target.col;
      const dy = row - target.row;
      const dist = dx * dx + dy * dy;
      // Strict `<` keeps the column-major scan order as the tie-break,
      // so equidistant cells resolve deterministically.
      if (dist < bestDist) {
        bestDist = dist;
        best = cell;
      }
    }
  }
  return best;
}

/** Resolve stored wishes into the cells actually drawn this frame.
 *
 *  Pure, because every interesting case is a conflict — two icons
 *  wanting one cell, a stored cell outside a shrunken grid, an icon
 *  with no stored cell at all — and those are worth testing without a
 *  browser. See desktop-icons.test.mts. */
export function layoutIcons(
  stored: IconPositions,
  ids: readonly string[],
  cols: number,
  rows: number,
): Map<string, Cell> {
  const out = new Map<string, Cell>();
  if (cols < 1 || rows < 1) return out;

  const taken = new Set<string>();
  const assign = (id: string, target: Cell | null) => {
    const wanted = target ? clamp(target, cols, rows) : null;
    const free = wanted && !taken.has(cellKey(wanted)) ? wanted : nearestFree(wanted, cols, rows, taken);
    if (!free) return; // Grid full — cannot happen, gridSize() grows rows.
    taken.add(cellKey(free));
    out.set(id, free);
  };

  // Explicitly placed icons claim their cells first, in reading order,
  // so a conflict resolves the same way every render.
  const placed = ids
    .filter((id) => stored[id])
    .sort((a, b) => {
      const A = stored[a] as Cell;
      const B = stored[b] as Cell;
      return A.col - B.col || A.row - B.row;
    });
  for (const id of placed) assign(id, stored[id] as Cell);
  // Never-moved icons flow into whatever is left, in their default
  // order — which reproduces the original dock when nothing was moved.
  for (const id of ids) if (!stored[id]) assign(id, null);

  return out;
}

/** Move `id` onto `target`. If another icon is drawn there the two
 *  trade places, which is what dropping onto an occupied slot should
 *  do — no icon is ever displaced into limbo. */
export function placeIcon(
  stored: IconPositions,
  layout: ReadonlyMap<string, Cell>,
  id: string,
  target: Cell,
): IconPositions {
  const next: IconPositions = { ...stored, [id]: target };
  const from = layout.get(id);
  for (const [other, cell] of layout) {
    if (other !== id && cell.col === target.col && cell.row === target.row) {
      // Swap partner inherits the dragged icon's old cell. Uses the
      // DRAWN cell, not the stored one, so the swap matches what the
      // user saw on screen.
      if (from) next[other] = from;
      break;
    }
  }
  return next;
}

function readStored(): IconPositions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: IconPositions = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const { col, row } = value as { col?: unknown; row?: unknown };
      if (typeof col !== 'number' || typeof row !== 'number') continue;
      if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || row < 0) continue;
      out[id] = { col: Math.floor(col), row: Math.floor(row) };
    }
    return out;
  } catch {
    // Missing, blocked (Safari private mode) or corrupt — default layout.
    return {};
  }
}

/** Live grid dimensions for an element, tracked across resizes. */
export function useGridSize(ref: React.RefObject<HTMLElement | null>, iconCount: number) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return useMemo(() => gridSize(box.width, box.height, iconCount), [box.width, box.height, iconCount]);
}

export function useDesktopIcons(ids: readonly string[], cols: number, rows: number) {
  const [stored, setStored] = useState<IconPositions>(readStored);
  // Callers rebuild `ids` every render — depend on contents, not identity.
  const idsKey = ids.join(' ');

  const layout = useMemo(
    () => layoutIcons(stored, ids, cols, rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey stands in for ids
    [stored, idsKey, cols, rows],
  );

  // Only explicit placements are persisted. Derived positions stay out
  // of storage on purpose: writing back a clamped position would burn a
  // temporary small-window layout in permanently.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Quota or blocked storage — layout holds for this session only.
    }
  }, [stored]);

  const place = useCallback(
    (id: string, target: Cell) => setStored((prev) => placeIcon(prev, layoutIcons(prev, ids, cols, rows), id, target)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey stands in for ids
    [idsKey, cols, rows],
  );

  const reset = useCallback(() => setStored({}), []);

  return { layout, place, reset };
}
