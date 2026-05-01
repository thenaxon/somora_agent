// Entry-point for the Ink-based somora CLI.
//   npm run dev:cli            — this file
//   npm run dev:cli:legacy     — old readline CLI (will be removed once
//                                Phase C ships)

import { render } from 'ink';
import { App } from './app.tsx';

const port = Number(process.env.SOMORA_PORT ?? 18737);
const host = process.env.SOMORA_HOST ?? '127.0.0.1';
const base = `http://${host}:${port}`;

// Clear + bottom-pin the dynamic frame before Ink renders.
//   \x1B[2J — erase entire visible screen
//   \x1B[3J — erase scrollback (xterm extension; modern terminals only)
//   \x1B[H  — move cursor to home (1,1)
// Scrollback erase is included so users can't be confused by stale lines
// they scroll up to.
//
// Then we pre-pad with newlines until the cursor sits BOTTOM_FRAME_HEIGHT
// rows above the terminal bottom. Ink anchors its dynamic frame at the
// current cursor position, so this puts the input near the bottom on
// startup. As Static items append later, the terminal scrolls them up to
// make room, and the dynamic frame stays at the bottom — same way Claude
// Code's TUI behaves.
//
// Only fires when stdout is a TTY (no point in piped CI runs).
if (process.stdout.isTTY) {
  process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
  const rows = process.stdout.rows ?? 24;
  // separator(1) + header(1) + input(1) + footer(1) + marginTop(1) = 5
  // a one-line cushion below keeps the cursor inside the terminal.
  const BOTTOM_FRAME_HEIGHT = 6;
  const padding = Math.max(0, rows - BOTTOM_FRAME_HEIGHT);
  if (padding > 0) process.stdout.write('\n'.repeat(padding));
}

render(<App base={base} initialAgent="hans" initialSession="main" />);
