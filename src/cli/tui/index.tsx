// Entry-point for the Ink-based somora CLI.
//   npm run dev:cli            — this file
//   npm run dev:cli:legacy     — old readline CLI (will be removed once
//                                Phase C ships)

import { render } from 'ink';
import { App } from './app.tsx';

const port = Number(process.env.SOMORA_PORT ?? 18737);
const host = process.env.SOMORA_HOST ?? '127.0.0.1';
const base = `http://${host}:${port}`;

// Clear the visible terminal frame before Ink renders so the TUI starts on
// a clean slate instead of underneath npm output and shell history.
//   \x1B[2J — erase entire visible screen
//   \x1B[3J — erase scrollback (xterm extension; modern terminals only)
//   \x1B[H  — move cursor to home (1,1)
// Scrollback erase is included so users can't be confused by stale lines
// they scroll up to. Only fires when stdout is a TTY (no point in piped
// CI runs).
if (process.stdout.isTTY) {
  process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
}

render(<App base={base} initialAgent="hans" initialSession="main" />);
