// Where somora looks for Chromium or Chrome. Shared by the browser
// service and the setup assistant (src/cli/setup.ts "browser"), so the
// assistant checks the very program the agents will use.

import { existsSync } from 'node:fs';

export const EXECUTABLE_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/opt/homebrew/bin/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function detectExecutable(configured?: string): { path: string | null; tried: string[] } {
  const tried = configured ? [configured] : EXECUTABLE_CANDIDATES;
  for (const p of tried) if (existsSync(p)) return { path: p, tried };
  return { path: null, tried };
}
