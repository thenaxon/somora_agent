// One rule for where a window may be: dragging, resizing by the corner
// handle, and a browser-viewport resize all clamp through here.
//
// Before 2026-08-31 the drag and corner-resize handlers each carried
// their own clamp and nothing reacted to the viewport changing — move
// the browser from a 27" to the MacBook screen and every window kept
// its old coordinates, off-screen and under the taskbar, where the
// Arrange button that would fix it was covered (Rene's report). The
// rule users can rely on now: a window never leaves the desktop — its
// title bar and resize corner are always reachable, and the taskbar
// always stays on top.

export const TASKBAR_HEIGHT = 56;
export const MIN_WIDTH = 320;
export const MIN_HEIGHT = 200;
/** How much of a window may hang off the right edge while DRAGGING —
 *  grabbing a window and parking it half off-screen is a deliberate
 *  gesture, so the drag clamp keeps this much visible instead of
 *  forcing the whole window inside. */
const DRAG_MIN_VISIBLE_X = 100;

export interface Viewport {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function currentViewport(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** Height of the area windows may occupy — everything above the taskbar. */
export function desktopHeight(vp: Viewport): number {
  return Math.max(0, vp.h - TASKBAR_HEIGHT);
}

/** Drag: the whole window stays above the taskbar (title bar AND body),
 *  never above y=0, never left of x=0, and at least DRAG_MIN_VISIBLE_X
 *  px stay on screen to the right. Same numbers the drag handler used
 *  before the refactor. */
export function clampDragPosition(x: number, y: number, winH: number, vp: Viewport): { x: number; y: number } {
  const cx = Math.max(0, Math.min(vp.w - DRAG_MIN_VISIBLE_X, x));
  const maxY = Math.max(0, desktopHeight(vp) - winH);
  const cy = Math.max(0, Math.min(maxY, y));
  return { x: cx, y: cy };
}

/** Corner resize: the bottom-right corner never leaves the desktop, so
 *  the handle can always be grabbed again; never below the minimums. */
export function clampResizeSize(winX: number, winY: number, w: number, h: number, vp: Viewport): { w: number; h: number } {
  const maxW = Math.max(MIN_WIDTH, vp.w - winX);
  const maxH = Math.max(MIN_HEIGHT, desktopHeight(vp) - winY);
  return {
    w: Math.min(maxW, Math.max(MIN_WIDTH, w)),
    h: Math.min(maxH, Math.max(MIN_HEIGHT, h)),
  };
}

/** Viewport change: bring a window back inside the desktop. Shrink
 *  first (a window taller than the desktop can never be fully visible
 *  otherwise), then shift left/up until it fits. Returns the SAME
 *  object when nothing changes, so callers can skip a state write.
 *
 *  Deliberately not the drag rule: after a resize the user did not
 *  choose to park anything half off-screen, so the whole window comes
 *  back — title bar, body and corner. */
export function fitToDesktop<T extends Rect>(win: T, vp: Viewport): T {
  const areaW = Math.max(MIN_WIDTH, vp.w);
  const areaH = Math.max(MIN_HEIGHT, desktopHeight(vp));
  const w = Math.min(win.w, areaW);
  const h = Math.min(win.h, areaH);
  const x = Math.max(0, Math.min(win.x, areaW - w));
  const y = Math.max(0, Math.min(win.y, areaH - h));
  if (x === win.x && y === win.y && w === win.w && h === win.h) return win;
  return { ...win, x, y, w, h };
}

/** Gap between arranged windows, and the inset from the desktop edges. */
export const ARRANGE_GAP = 16;
export const ARRANGE_PAD = 24;

/** Columns the plain grid uses for n windows — the rule Arrange has had
 *  since it existed, kept so 1, 2, 4, 6 … windows land exactly where
 *  users are used to. */
function gridColumns(n: number): number {
  return n <= 1 ? 1 : n <= 4 ? 2 : 3;
}

/** Slots for n windows inside `area`, in the order they should be filled.
 *
 *  A plain grid leaves a hole whenever n does not fill it — three windows
 *  used to quarter the screen and leave the fourth quarter empty, which
 *  is what prompted this (Luca's report). So when the grid would not come
 *  out even, the first slot becomes a MASTER spanning the full height on
 *  the left and the remaining windows tile to its right:
 *
 *      3 windows            5 windows
 *      ┌────┬────┐          ┌───┬───┬───┐
 *      │    │ B  │          │   │ B │ C │
 *      │ A  ├────┤          │ A ├───┼───┤
 *      │    │ C  │          │   │ D │ E │
 *      └────┴────┘          └───┴───┴───┘
 *
 *  The master keeps one grid column's width, so the outer proportions
 *  stay those of the plain grid. The fallback matters as much as the
 *  rule: master-stack is only used when the rest divides evenly into the
 *  remaining columns (3, 5, 7 …). For 8 windows it would just move the
 *  hole from the grid into the stack, so the plain grid stays. */
export function arrangeSlots(n: number, area: Rect, gap: number = ARRANGE_GAP): Rect[] {
  if (n <= 0) return [];
  const cols = gridColumns(n);
  const rows = Math.ceil(n / cols);
  const cellW = Math.floor((area.w - gap * (cols - 1)) / cols);

  const stackCols = cols - 1;
  const rest = n - 1;
  const stackRows = stackCols > 0 ? Math.ceil(rest / stackCols) : 0;
  const useMaster = cols * rows !== n && stackCols > 0 && stackCols * stackRows === rest;

  if (!useMaster) {
    const cellH = Math.floor((area.h - gap * (rows - 1)) / rows);
    return Array.from({ length: n }, (_, i) => ({
      x: area.x + (i % cols) * (cellW + gap),
      y: area.y + Math.floor(i / cols) * (cellH + gap),
      w: cellW,
      h: cellH,
    }));
  }

  const stackX = area.x + cellW + gap;
  const stackW = area.w - cellW - gap;
  const sw = Math.floor((stackW - gap * (stackCols - 1)) / stackCols);
  const sh = Math.floor((area.h - gap * (stackRows - 1)) / stackRows);
  return [
    { x: area.x, y: area.y, w: cellW, h: area.h },
    ...Array.from({ length: rest }, (_, i) => ({
      x: stackX + (i % stackCols) * (sw + gap),
      y: area.y + Math.floor(i / stackCols) * (sh + gap),
      w: sw,
      h: sh,
    })),
  ];
}

/** Fit every window; returns the same array when none moved. */
export function fitAllToDesktop<T extends Rect>(wins: T[], vp: Viewport): T[] {
  let changed = false;
  const next = wins.map((w) => {
    const f = fitToDesktop(w, vp);
    if (f !== w) changed = true;
    return f;
  });
  return changed ? next : wins;
}
