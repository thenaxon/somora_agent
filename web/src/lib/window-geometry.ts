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
