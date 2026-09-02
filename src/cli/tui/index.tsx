// Entry-point for the Ink-based somora CLI.
//   npm run dev:cli            — this file
//   npm run dev:cli:legacy     — old readline CLI (will be removed once
//                                Phase C ships)

import { render } from 'ink';
import { Api } from './api.ts';
import { App } from './app.tsx';
import { readTuiState } from './state.ts';
import { loadConfig } from '../../config/loader.ts';

// Resolve scheme + host + port. When `server.tls` is configured in
// config.yaml, the somora server serves HTTPS-only on its publicHost
// (matches the TLS cert SAN/CN); plain HTTP isn't accepted anymore,
// so the TUI HAS to follow. Env-var overrides still win for power
// users (SOMORA_BASE forces a specific URL, SOMORA_TLS=1/0 toggles
// the scheme, SOMORA_HOST/SOMORA_PORT override the components).
const port = Number(process.env.SOMORA_PORT ?? 18737);
let cfg: Awaited<ReturnType<typeof loadConfig>> | null = null;
try {
  cfg = await loadConfig();
} catch {
  /* missing config = first-run, fall through to plain-HTTP defaults */
}
const tlsConfigured = !!cfg?.server.tls;
const tlsEnv = process.env.SOMORA_TLS;
const useTls = tlsEnv === '0' ? false : tlsEnv === '1' ? true : tlsConfigured;
const scheme = useTls ? 'https' : 'http';
const defaultHost = useTls
  ? cfg?.server.tls?.publicHost ?? '127.0.0.1'
  : '127.0.0.1';
const host = process.env.SOMORA_HOST ?? defaultHost;
const base = process.env.SOMORA_BASE ?? `${scheme}://${host}:${port}`;

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
let initialAgent = persisted.lastAgent ?? '';
try {
  const agents = await new Api(base).fetchAgents();
  const names = agents.map((a) => a.name);
  if (initialAgent && !names.includes(initialAgent)) initialAgent = '';
  if (!initialAgent) {
    const sorted = [...names].sort();
    initialAgent = sorted[0] ?? 'default';
  }
} catch {
  // server not up — use whatever was persisted, else placeholder
  if (!initialAgent) initialAgent = 'default';
}

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

// exitOnCtrlC: false lets us implement a soft-cancel pattern: first Ctrl+C
// clears the current input or closes the autocomplete popup; only when
// there's nothing to clear does it exit.
render(
  <App
    base={base}
    initialAgent={initialAgent}
    initialSession="main"
    initialShowMemory={initialShowMemory}
    initialShowTools={initialShowTools}
    initialVerboseTools={initialVerboseTools}
    initialVerboseMemory={initialVerboseMemory}
    initialVerboseSystem={initialVerboseSystem}
    initialVerboseThinking={initialVerboseThinking}
  />,
  {
    exitOnCtrlC: false,
  },
);
