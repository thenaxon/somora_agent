// Window geometry — the one clamp rule for drag, corner-resize and
// viewport-resize (2026-08-31: windows vanished off-screen and under
// the taskbar when the browser moved to a smaller display).
//
// Run: npx tsx web/src/lib/window-geometry.test.mts

import assert from 'node:assert/strict';
import {
  ARRANGE_GAP,
  arrangeSlots,
  clampDragPosition,
  clampResizeSize,
  fitAllToDesktop,
  fitToDesktop,
  MIN_HEIGHT,
  MIN_WIDTH,
  TASKBAR_HEIGHT,
} from './window-geometry';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const BIG = { w: 2560, h: 1440 };
const SMALL = { w: 1440, h: 900 };
const DESK_SMALL = SMALL.h - TASKBAR_HEIGHT;

// ── drag (unchanged semantics) ─────────────────────────────────────
{
  const r = clampDragPosition(-50, -20, 600, BIG);
  check('drag: never left/above 0', r.x === 0 && r.y === 0);
  const right = clampDragPosition(3000, 100, 600, BIG);
  check('drag: may hang off the right edge but 100px stay visible', right.x === BIG.w - 100);
  const low = clampDragPosition(100, 2000, 600, BIG);
  check('drag: whole window stays above the taskbar', low.y === BIG.h - TASKBAR_HEIGHT - 600);
  const tall = clampDragPosition(100, 100, 5000, BIG);
  check('drag: window taller than desktop pins to y=0', tall.y === 0);
}

// ── corner resize (unchanged semantics) ────────────────────────────
{
  const r = clampResizeSize(100, 100, 5000, 5000, BIG);
  check('resize: corner never leaves the desktop', r.w === BIG.w - 100 && r.h === BIG.h - TASKBAR_HEIGHT - 100, JSON.stringify(r));
  const tiny = clampResizeSize(100, 100, 10, 10, BIG);
  check('resize: minimums hold', tiny.w === MIN_WIDTH && tiny.h === MIN_HEIGHT);
}

// ── viewport fit: THE report ───────────────────────────────────────
{
  // A chat window parked bottom-right on the big screen.
  const win = { id: 'chat', x: 1500, y: 700, w: 940, h: 640 };
  const small = fitToDesktop(win, SMALL);
  check('fit: whole window inside horizontally', small.x >= 0 && small.x + small.w <= SMALL.w, JSON.stringify(small));
  check('fit: whole window above the taskbar', small.y >= 0 && small.y + small.h <= DESK_SMALL, JSON.stringify(small));
  check('fit: size kept when it still fits', small.w === 940 && small.h === 640);
  check('fit: shifted, not resized', small.x === SMALL.w - 940 && small.y === DESK_SMALL - 640);
  check('fit: other fields survive', (small as { id: string }).id === 'chat');
}
{
  // A window bigger than the small desktop shrinks to fit.
  const win = { x: 200, y: 100, w: 1800, h: 1200 };
  const f = fitToDesktop(win, SMALL);
  check('fit: oversize shrinks to the desktop', f.w === SMALL.w && f.h === DESK_SMALL, JSON.stringify(f));
  check('fit: … and sits at the origin', f.x === 0 && f.y === 0);
}
{
  // Fits already → identical object (no state churn, no persist).
  const win = { x: 100, y: 100, w: 800, h: 500 };
  check('fit: untouched window is the same object', fitToDesktop(win, SMALL) === win);
  const arr = [win];
  check('fitAll: same array when nothing moves', fitAllToDesktop(arr, SMALL) === arr);
  const arr2 = [win, { x: 3000, y: 3000, w: 400, h: 300 }];
  const out = fitAllToDesktop(arr2, SMALL);
  check('fitAll: new array when one moves, untouched entries keep identity', out !== arr2 && out[0] === win && out[1]!.x === SMALL.w - 400);
}
{
  // Going back to the big screen: nothing jumps (idempotent, no growth).
  const win = { x: 500, y: 200, w: 940, h: 640 };
  const small = fitToDesktop(win, SMALL);
  const bigAgain = fitToDesktop(small, BIG);
  check('fit: back on the big screen nothing moves', bigAgain === small);
}
{
  // Absurdly small viewport: minimums win, still no negative coords.
  const f = fitToDesktop({ x: 900, y: 900, w: 900, h: 900 }, { w: 200, h: 150 });
  check('fit: tiny viewport → min size at origin', f.w === MIN_WIDTH && f.h === MIN_HEIGHT && f.x === 0 && f.y === 0, JSON.stringify(f));
}

// ── arrange slots ──────────────────────────────────────────────────
// The desktop area Arrange fills; numbers chosen so the divisions come
// out even and a wrong slot is obvious in the assertion.
const AREA = { x: 100, y: 24, w: 1200 + ARRANGE_GAP, h: 800 };
/** Every slot inside the area, none overlapping — the two properties
 *  that must hold whatever the count. */
function sane(slots: { x: number; y: number; w: number; h: number }[]): boolean {
  for (const s of slots) {
    if (s.x < AREA.x || s.y < AREA.y) return false;
    if (s.x + s.w > AREA.x + AREA.w + 1 || s.y + s.h > AREA.y + AREA.h + 1) return false;
    if (s.w <= 0 || s.h <= 0) return false;
  }
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!;
      const b = slots[j]!;
      const overlap =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlap) return false;
    }
  }
  return true;
}
{
  check('arrange: nothing to place', arrangeSlots(0, AREA).length === 0);
}
{
  const [only] = arrangeSlots(1, AREA);
  check('arrange: one window fills the area', only!.x === AREA.x && only!.y === AREA.y && only!.w === AREA.w && only!.h === AREA.h, JSON.stringify(only));
}
{
  const s = arrangeSlots(2, AREA);
  check('arrange: two windows are full-height halves', s[0]!.h === AREA.h && s[1]!.h === AREA.h && s[1]!.x > s[0]!.x, JSON.stringify(s));
  check('arrange: two windows do not overlap', sane(s));
}
{
  // The report this was built for: three windows used to quarter the
  // desktop and leave one quarter empty.
  const s = arrangeSlots(3, AREA);
  check('arrange: 3 → master spans the full height on the left', s[0]!.h === AREA.h && s[0]!.x === AREA.x, JSON.stringify(s[0]));
  check('arrange: 3 → the other two stack to the right of it', s[1]!.x === s[2]!.x && s[1]!.x > s[0]!.x && s[2]!.y > s[1]!.y, JSON.stringify(s));
  check('arrange: 3 → the stack is half as tall as the master', Math.abs(s[1]!.h * 2 + ARRANGE_GAP - AREA.h) <= 1, JSON.stringify(s[1]));
  check('arrange: 3 → no gaps, no overlaps', sane(s));
}
{
  // Even grid — the layout users already know must not change.
  const s = arrangeSlots(4, AREA);
  const rows = new Set(s.map((r) => r.y));
  const cols = new Set(s.map((r) => r.x));
  check('arrange: 4 → plain 2×2 grid, no master', rows.size === 2 && cols.size === 2 && s[0]!.h < AREA.h, JSON.stringify(s));
  check('arrange: 4 → no overlaps', sane(s));
}
{
  const s = arrangeSlots(5, AREA);
  check('arrange: 5 → master left, 2×2 right', s[0]!.h === AREA.h && new Set(s.slice(1).map((r) => r.x)).size === 2 && new Set(s.slice(1).map((r) => r.y)).size === 2, JSON.stringify(s));
  check('arrange: 5 → no overlaps', sane(s));
}
{
  const s = arrangeSlots(6, AREA);
  check('arrange: 6 → plain 3×2 grid', s.every((r) => r.h < AREA.h) && new Set(s.map((r) => r.x)).size === 3, JSON.stringify(s));
  check('arrange: 6 → no overlaps', sane(s));
}
{
  const s = arrangeSlots(7, AREA);
  check('arrange: 7 → master left, 2×3 right', s[0]!.h === AREA.h && new Set(s.slice(1).map((r) => r.y)).size === 3, JSON.stringify(s));
  check('arrange: 7 → no overlaps', sane(s));
}
{
  // 8 does not divide into a master + even stack, so the plain grid
  // stays rather than trading the grid's hole for one in the stack.
  const s = arrangeSlots(8, AREA);
  check('arrange: 8 → falls back to the plain grid', s.every((r) => r.h < AREA.h), JSON.stringify(s));
  check('arrange: 8 → no overlaps', sane(s));
}
{
  // Whatever the count, slots stay inside the area and apart.
  let bad: number[] = [];
  for (let n = 1; n <= 12; n++) if (!sane(arrangeSlots(n, AREA))) bad.push(n);
  check('arrange: 1..12 all stay inside the desktop without overlapping', bad.length === 0, `bad: ${bad.join(', ')}`);
}

console.log(`window-geometry: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
