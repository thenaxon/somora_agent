// Tmux session listing for the web tmux-app. Joins live `tmux ls`
// output (the source of truth — sessions tmux knows about) with the
// origin store (somora's record of who created what). Anything in
// tmux but not in our origins is rendered "orphan" in the UI.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { listTmuxOrigins, type TmuxOrigin } from './origin-store.ts';
import { logger } from '../server/logger.ts';

const execP = promisify(exec);

export interface TmuxSessionInfo {
  /** Tmux session name. */
  name: string;
  /** Number of windows in the session (`#{session_windows}`). */
  windows: number;
  /** Active-window's command — best-guess "what's running". */
  activeCommand: string | null;
  /** Active-window's title (often = command, sometimes user-set). */
  activeTitle: string | null;
  /** Unix epoch seconds of session creation per tmux. */
  createdEpoch: number | null;
  /** Unix epoch seconds of last user activity per tmux
   *  (`#{session_last_attached}` returns 0 if never attached). */
  lastActivityEpoch: number | null;
  /** Origin metadata when somora's `tmux create` produced this
   *  session. Absent → user/host-shell-created → "orphan" in UI. */
  origin?: TmuxOrigin;
}

/**
 * List local tmux sessions, joined with origin metadata.
 *
 * Returns [] when no tmux server is running (tmux ls exits non-zero
 * with "no server running" — not an error condition for us).
 */
export async function listTmuxSessions(): Promise<TmuxSessionInfo[]> {
  // Format string fields are tab-separated to survive session names
  // with spaces in them. Order: name, windows, activeCmd, activeTitle,
  // created (epoch), lastAttached (epoch).
  const fmt = '#{session_name}\t#{session_windows}\t#{pane_current_command}\t#{window_name}\t#{session_created}\t#{session_last_attached}';
  let raw: string;
  try {
    // Do NOT pipe stderr to /dev/null — we want to read it in the
    // catch branch below to distinguish "no tmux server running" (the
    // overwhelmingly common case, ~2300x/day on machines without an
    // active tmux) from real failures (tmux missing, perms, …). Pre-fix
    // we redirected stderr and then tried to pattern-match against an
    // err.message that no longer contained the discriminating text →
    // every poll spammed a warn-level log.
    const { stdout } = await execP(`tmux list-sessions -F '${fmt}'`, {
      timeout: 5_000,
    });
    raw = stdout;
  } catch (err) {
    const stderr = (err as Error & { stderr?: string }).stderr ?? '';
    const message = (err as Error).message ?? '';
    // Either source is fine; tmux prints to stderr but child_process
    // sometimes folds it into err.message ("Command failed: … no server
    // running").
    if (/no server running/i.test(stderr) || /no server running/i.test(message)) return [];
    logger.warn({ msg: 'tmux.list_failed', err: message, stderr: stderr.slice(0, 200) });
    return [];
  }

  const origins = new Map(listTmuxOrigins().map((o) => [o.name, o]));
  const out: TmuxSessionInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const name = parts[0] ?? '';
    if (!name) continue;
    const windows = Number(parts[1] ?? '0') || 0;
    const cmd = parts[2] ?? '';
    const title = parts[3] ?? '';
    const created = Number(parts[4] ?? '0') || 0;
    const lastAttached = Number(parts[5] ?? '0') || 0;
    const origin = origins.get(name);
    out.push({
      name,
      windows,
      activeCommand: cmd || null,
      activeTitle: title || null,
      createdEpoch: created || null,
      lastActivityEpoch: lastAttached || null,
      ...(origin ? { origin } : {}),
    });
  }
  return out;
}
