// Regression: composer Stop (Send-slot while streaming) must be
// clearly danger-styled — not a muted gray icon on dark chrome.
//
// Stop moved off the assistant bubble into `.chat-send.chat-send-stop`
// (s11). This replaces the older bubble-corner cascade check from s9.
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
// Bubble-corner Stop must stay gone (s11 placement).
check(
  'no bubble-stop-btn rule in desktop.css',
  !desktop.includes('bubble-stop-btn'),
);
check(
  'no bubble-stop-btn rule in globals.css',
  !globals.includes('bubble-stop-btn'),
);

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
