// Window geometry — the one clamp rule for drag, corner-resize and
// viewport-resize (2026-08-31: windows vanished off-screen and under
// the taskbar when the browser moved to a smaller display).
//
// Run: npx tsx web/src/lib/window-geometry.test.mts

import assert from 'node:assert/strict';
import {
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

console.log(`window-geometry: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
