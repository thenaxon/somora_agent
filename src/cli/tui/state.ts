// Per-user TUI state persistence — last-used agent and (future) other
// UI prefs. Lives in `~/.somora/tui-state.json`. Best-effort: read and
// write failures degrade silently, the TUI just falls back to defaults.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const STATE_FILE = join(SOMORA_HOME, 'tui-state.json');

export interface TuiState {
  /** Last agent the TUI was active on. Restored on next startup if the
   *  agent still exists. */
  lastAgent?: string;
}

export function readTuiState(): TuiState {
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as TuiState;
  } catch {
    return {};
  }
}

export function writeTuiState(state: TuiState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // best-effort — silently drop write failures (file system full,
    // permissions, etc.). Persistence is a nice-to-have, not load-bearing.
  }
}

export function rememberAgent(agent: string): void {
  const cur = readTuiState();
  if (cur.lastAgent === agent) return;
  writeTuiState({ ...cur, lastAgent: agent });
}
