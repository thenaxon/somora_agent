// Per-user TUI state persistence — last-used agent and (future) other
// UI prefs. Lives in `~/.somora/tui-state.json`. Best-effort: read and
// write failures degrade silently, the TUI just falls back to defaults.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const STATE_FILE = join(SOMORA_HOME, 'tui-state.json');
const HISTORY_FILE = join(SOMORA_HOME, 'tui-history.json');

/** Messages the input history keeps across runs (Up, Down, Ctrl+R). */
export const INPUT_HISTORY_MAX = 500;

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

/**
 * What you sent before, oldest first, from `~/.somora/tui-history.json`
 * (docs/display.md "Sending and keys"). Kept across runs since
 * 2026-11-22; before, Up and Down forgot everything on quit. The file is
 * readable by its owner only: it holds what was typed.
 */
export function readInputHistory(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(-INPUT_HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

export function writeInputHistory(history: string[]): void {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-INPUT_HISTORY_MAX)), { encoding: 'utf8', mode: 0o600 });
    chmodSync(HISTORY_FILE, 0o600);
  } catch {
    // best-effort, like the state file
  }
}
