// Regression: composer Stop (next to Send while streaming) must be
// clearly danger-styled — not a muted gray icon on dark chrome.
//
// PR #1 originally moved Stop off the bubble into the composer;
// somora keeps BOTH affordances — the always-visible bubble Stop
// (`.bubble-stop`, s9 cascade) AND the additive composer Stop
// (`.chat-send.chat-send-stop`). This guards both.
//
// Run: npx tsx web/src/styles/stop-btn-cascade.test.mts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = readFileSync(join(here, 'desktop.css'), 'utf8');
const globals = readFileSync(join(here, 'globals.css'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const stopIdx = desktop.indexOf('.chat-send.chat-send-stop');
const stopColorIdx = desktop.indexOf('var(--danger', stopIdx);
const sendIdx = desktop.indexOf('.chat-send {');

check('composer stop selector exists', stopIdx >= 0);
check(
  'composer stop follows base .chat-send rule',
  stopIdx > sendIdx,
  `send=${sendIdx} stop=${stopIdx}`,
);
check(
  'composer stop sets danger color/background',
  stopColorIdx > stopIdx && stopColorIdx < stopIdx + 200,
  `stopColor=${stopColorIdx}`,
);
// Bubble-corner Stop stays (both affordances live side by side).
// The `.bubble-stop` override must force the action row visible —
// the base `.bubble-actions` rule is hover-gated (opacity 0).
const bubbleStopIdx = desktop.indexOf('.bubble-actions.bubble-stop');
check('bubble-stop override exists in desktop.css', bubbleStopIdx >= 0);
check(
  'bubble-stop forces visibility (opacity: 1)',
  bubbleStopIdx >= 0 &&
    desktop.slice(bubbleStopIdx, bubbleStopIdx + 120).includes('opacity: 1'),
);
check('bubble-stop-btn danger color exists', desktop.includes('.bubble-stop-btn'));
check(
  'globals.css does not duplicate bubble-stop rules',
  !globals.includes('bubble-stop-btn'),
);

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
