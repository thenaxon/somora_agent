// Entry-point for the Ink-based somora CLI.
//   npm run dev:cli            — this file
//   npm run dev:cli:legacy     — old readline CLI (will be removed once
//                                Phase C ships)

import { render } from 'ink';
import { parseArgs } from 'node:util';
import { releaseHerdr } from './herdr.ts';
import { Api } from './api.ts';
import { App } from './app.tsx';
import { readTuiState } from './state.ts';
import { resolveServerBase } from '../server-base.ts';

// `--agent` and `--session` open that conversation; herdr passes them
// back to reopen the pane (src/cli/tui/herdr.ts, docs/display.md
// "Inside herdr"). A wrong flag gets a usage line, not a stack trace.
const TUI_USAGE = 'Usage: somora tui [--agent <name>] [--session <name>]';
let values: { agent?: string; session?: string };
try {
  ({ values } = parseArgs({ options: { agent: { type: 'string' }, session: { type: 'string' } } }));
} catch (err) {
  process.stderr.write(`somora tui: ${(err as Error).message}\n${TUI_USAGE}\n`);
  process.exit(2);
}

// Where the server listens (config.yaml TLS, env overrides).
const base = await resolveServerBase();

// TUI display defaults — fetched from the server (single config reader).
// If the server is unreachable at boot (e.g. user runs dev:cli before
// dev:server), fall back to safe defaults — the user can flip toggles
// at runtime via /show and /verbose.
let initialShowMemory = true;
let initialShowTools = true;
let initialVerboseTools = false;
let initialVerboseMemory = false;
let initialVerboseSystem = false;
let initialVerboseThinking = false;
try {
  const tuiConfig = await new Api(base).fetchTuiConfig();
  initialShowMemory = tuiConfig.show.memory;
  initialShowTools = tuiConfig.show.tools;
  initialVerboseTools = tuiConfig.verbose.tools;
  initialVerboseMemory = tuiConfig.verbose.memory;
  initialVerboseSystem = tuiConfig.verbose.system;
  // Older servers don't know the key yet — default off.
  initialVerboseThinking = tuiConfig.verbose.thinking === true;
} catch {
  // server not up yet — defaults stand
}

// Pick the agent the TUI starts on. Priority:
//   1. last-used agent from ~/.somora/tui-state.json (if it still exists)
//   2. alphabetically-first agent from /agents
//   3. literal placeholder ('default') — TUI shows a "no agents found" state
const persisted = readTuiState();
let initialAgent = values.agent ?? persisted.lastAgent ?? '';
try {
  const agents = await new Api(base).fetchAgents();
  const names = agents.map((a) => a.name);
  if (!values.agent && initialAgent && !names.includes(initialAgent)) initialAgent = '';
  if (!initialAgent) {
    const sorted = [...names].sort();
    initialAgent = sorted[0] ?? 'default';
  }
} catch {
  // server not up — use whatever was persisted, else placeholder
  if (!initialAgent) initialAgent = 'default';
}

// Clear the screen before Ink renders.
//   \x1B[2J — erase entire visible screen
//   \x1B[3J — erase scrollback (xterm extension; modern terminals only)
//   \x1B[H  — move cursor to home (1,1)
// Scrollback erase is included so users can't be confused by stale lines
// they scroll up to. No padding is needed any more: the frame is exactly
// as tall as the terminal (layout.ts), so the bottom panel starts on the
// last rows.
//
// Only fires when stdout is a TTY (no point in piped CI runs).
if (process.stdout.isTTY) {
  process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
}

// exitOnCtrlC: false lets us implement a soft-cancel pattern: first Ctrl+C
// clears the current input or closes the autocomplete popup; only when
// there's nothing to clear does it exit.
const app = render(
  <App
    base={base}
    initialAgent={initialAgent}
    initialSession={values.session ?? 'main'}
    initialShowMemory={initialShowMemory}
    initialShowTools={initialShowTools}
    initialVerboseTools={initialVerboseTools}
    initialVerboseMemory={initialVerboseMemory}
    initialVerboseSystem={initialVerboseSystem}
    initialVerboseThinking={initialVerboseThinking}
  />,
  {
    exitOnCtrlC: false,
    // The frame is the whole screen; redraw only the rows that changed
    // instead of all of them on every keystroke.
    incrementalRendering: true,
  },
);
try {
  await app.waitUntilExit();
} finally {
  await releaseHerdr();
}
