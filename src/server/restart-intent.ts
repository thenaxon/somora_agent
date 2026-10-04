// A restart an agent asked for, kept across the restart.
//
// An agent that restarts somora from inside its own turn (a deploy, a
// config change, `somora update`) used to kill that turn: the server
// died mid-tool-call, nothing recorded the outcome, and afterwards the
// person had to tell the agent to look again (report 2026-09-13, four
// cut turns in two days on one installation).
//
// Two layers:
//  1. Requested: `somora server restart` / `somora update` called from an
//     agent's shell — or POST /server/restart with agent + session — do
//     not restart at once. The request is written here, the restart
//     waits until that turn has ended, and after boot the session is
//     woken with what happened.
//  2. Detected: a turn cut by a restart it visibly caused itself (a raw
//     `systemctl restart somora` in its tool calls) is woken as well.
// A session is resumed at most twice in ten minutes — an agent that
// answers the wake by restarting again must not loop.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RestartIntent {
  agent: string;
  session: string;
  requestedAt: number;
  fromVersion: string;
  reason?: string;
}

const home = (): string => process.env.SOMORA_HOME ?? join(homedir(), '.somora');
export const intentPath = (): string => join(home(), 'restart-intent.json');
const historyPath = (): string => join(home(), 'restart-resume.json');

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function writeRestartIntent(intent: RestartIntent): void {
  writeJson(intentPath(), intent);
}

export function readRestartIntent(): RestartIntent | null {
  try {
    const j = JSON.parse(readFileSync(intentPath(), 'utf8')) as Partial<RestartIntent>;
    if (typeof j.agent !== 'string' || typeof j.session !== 'string' || typeof j.requestedAt !== 'number') return null;
    return { agent: j.agent, session: j.session, requestedAt: j.requestedAt, fromVersion: typeof j.fromVersion === 'string' ? j.fromVersion : '?', ...(typeof j.reason === 'string' ? { reason: j.reason } : {}) };
  } catch {
    return null;
  }
}

export function clearRestartIntent(): void {
  rmSync(intentPath(), { force: true });
}

/** A shell command that restarts this somora: its own CLI, or the
 *  service manager aimed at the somora unit. A heuristic — wrappers and
 *  scripts escape it, which is why the requested path exists. */
export function looksLikeSelfRestart(command: string): boolean {
  const c = command.toLowerCase();
  if (/\bsomora\s+(server\s+restart|update)\b/.test(c)) return true;
  if (/\bsystemctl\b[^|;&\n]*\b(restart|try-restart|reload-or-restart)\b[^|;&\n]*\bsomora/.test(c)) return true;
  if (/\blaunchctl\b[^|;&\n]*\b(kickstart|bootout|stop|unload)\b[^|;&\n]*somora/.test(c)) return true;
  if (/\bpm2\b[^|;&\n]*\b(restart|reload)\b[^|;&\n]*\bsomora/.test(c)) return true;
  return false;
}

/** Does any tool call of a turn restart somora? `rows` are the turn's
 *  stored events (exec `command`, tmux `keys`/`command`/`text`). */
export function turnRestartedServer(rows: ReadonlyArray<Record<string, unknown>>): boolean {
  for (const r of rows) {
    if (r.kind !== 'tool_call') continue;
    const input = r.input as Record<string, unknown> | undefined;
    if (!input) continue;
    for (const key of ['command', 'cmd', 'keys', 'text', 'script']) {
      const v = input[key];
      if (typeof v === 'string' && looksLikeSelfRestart(v)) return true;
      if (Array.isArray(v) && looksLikeSelfRestart(v.filter((x) => typeof x === 'string').join(' '))) return true;
    }
  }
  return false;
}

const RESUME_WINDOW_MS = 10 * 60 * 1000;
const RESUME_MAX = 2;

/** May this session be woken after a restart? Records the wake when it
 *  may. False once it was woken twice in ten minutes. */
export function allowResume(agent: string, session: string, now: number = Date.now()): boolean {
  let history: Record<string, number[]> = {};
  try {
    history = JSON.parse(readFileSync(historyPath(), 'utf8')) as Record<string, number[]>;
  } catch {
    /* first time */
  }
  const key = `${agent}/${session}`;
  const fresh: Record<string, number[]> = {};
  for (const [k, list] of Object.entries(history)) {
    const kept = (Array.isArray(list) ? list : []).filter((t) => typeof t === 'number' && now - t < RESUME_WINDOW_MS);
    if (kept.length) fresh[k] = kept;
  }
  const mine = fresh[key] ?? [];
  if (mine.length >= RESUME_MAX) {
    writeJson(historyPath(), fresh);
    return false;
  }
  fresh[key] = [...mine, now];
  writeJson(historyPath(), fresh);
  return true;
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** Wake text after a requested restart. */
export function requestedResumeText(intent: RestartIntent, nowVersion: string, now: number = Date.now()): string {
  const version = intent.fromVersion === nowVersion ? `somora ${nowVersion}` : `somora ${intent.fromVersion} → ${nowVersion}`;
  return (
    `[somora] The server restart you requested is done: ${version}, back after ${seconds(now - intent.requestedAt)}` +
    (intent.reason ? ` (${intent.reason})` : '') +
    '. Your turn before it ended normally. Check that what you restarted for is in place, then continue with what you were doing — do not restart again unless something is actually wrong.'
  );
}

/** Wake text for a turn that was cut by a restart it caused itself. */
export function detectedResumeText(nowVersion: string): string {
  return (
    `[somora] Your previous turn was cut off by a server restart that it started itself; the server is back (somora ${nowVersion}). ` +
    'The command that restarted it did run — do NOT run it again. The instruction above still stands: check the current state, then continue from there. ' +
    'Next time restart with `somora server restart` (or `somora update`) from your shell: it waits until your turn has ended and wakes you afterwards.'
  );
}
