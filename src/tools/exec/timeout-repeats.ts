// The same command timing out again in a session (docs/tools.md
// "When a command times out"). A test run that never exits costs its
// full timeout every time it is started; a builder that starts it again
// unchanged after each edit loses hours (one session: 12 × 10 min on the
// same hanging test file, with edits and other calls in between, so the
// engine's doom-loop check — identical rounds in a row — never saw it).
//
// Counted per session, per folder and per command text (whitespace
// collapsed). Unlike a failure counter an edit does not reset it: a
// command that still hangs after the edit tells the builder the edit
// did not touch the cause. From the second timeout the result carries a
// notice; nothing is refused.
//
// The count lives on disk, one file per agent: claude-cli and codex-cli
// call exec through the MCP tool host, a process of its own that may
// be a new one next turn (stateful tools keep their state on disk).

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60_000;

interface Entry {
  count: number;
  lastAt: number;
  totalMs: number;
}

function fileOf(agent: string): string {
  const home = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  return join(home, 'agents', agent, 'exec-timeouts.json');
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function keyOf(session: string | undefined, cwd: string | undefined, command: string): string {
  return JSON.stringify([session ?? '', cwd ?? '', normalize(command)]);
}

async function readEntries(file: string): Promise<Record<string, Entry>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

// One read-modify-write at a time per file in this process (parallel
// tool calls, two sessions of one agent). Across processes — the server
// and an MCP tool host — the last writer may win; a lost count only
// delays the notice by one timeout.
const chains = new Map<string, Promise<unknown>>();
function serial<T>(file: string, f: () => Promise<T>): Promise<T> {
  const run = (chains.get(file) ?? Promise.resolve()).then(f, f);
  chains.set(file, run.catch(() => undefined));
  return run;
}

/** Record one timeout; returns how often this command has timed out
 *  in this session and folder so far, this one included. Entries older
 *  than a day are dropped. A failing write still returns the count. */
export function recordExecTimeout(opts: {
  agent: string;
  session?: string;
  cwd?: string;
  command: string;
  ms: number;
  now?: number;
}): Promise<{ count: number; totalMs: number }> {
  return serial(fileOf(opts.agent), () => recordUnlocked(opts));
}

async function recordUnlocked(opts: {
  agent: string;
  session?: string;
  cwd?: string;
  command: string;
  ms: number;
  now?: number;
}): Promise<{ count: number; totalMs: number }> {
  const now = opts.now ?? Date.now();
  const file = fileOf(opts.agent);
  const entries = await readEntries(file);
  for (const [k, e] of Object.entries(entries)) if (!(now - e.lastAt <= DAY_MS)) delete entries[k];
  const key = keyOf(opts.session, opts.cwd, opts.command);
  const prev = entries[key];
  const next: Entry = { count: (prev?.count ?? 0) + 1, lastAt: now, totalMs: (prev?.totalMs ?? 0) + opts.ms };
  entries[key] = next;
  try {
    await mkdir(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(entries));
    await rename(tmp, file);
  } catch {
    /* the notice for this call stands; the next one counts from disk */
  }
  return { count: next.count, totalMs: next.totalMs };
}

/** The notice for the second and every later timeout of one command. */
export function repeatTimeoutNotice(count: number, totalMs: number): string {
  const minutes = Math.round(totalMs / 60_000);
  const spent = minutes >= 1 ? `${minutes} min` : `${Math.round(totalMs / 1000)}s`;
  return (
    `This exact command has now timed out ${count} times in this session (${spent} in all). ` +
    'Do not start it again unchanged — the last change did not reach what keeps it from finishing. ' +
    'Find the cause first: run a smaller part (one test, verbose, stop at the first failure), ' +
    'look for a process, server, thread or watcher that never exits, or give it a short timeout_ms while you investigate.'
  );
}

/** Commands of one session that timed out since `since` (the facts
 *  under a builder's report), newest first. */
export async function timeoutsSince(
  agent: string,
  session: string,
  since: number,
): Promise<Array<{ command: string; cwd: string; count: number; totalMs: number }>> {
  const entries = await readEntries(fileOf(agent));
  const out: Array<{ command: string; cwd: string; count: number; totalMs: number; lastAt: number }> = [];
  for (const [key, e] of Object.entries(entries)) {
    if (!(e.lastAt >= since)) continue;
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(parts) || parts[0] !== session) continue;
    out.push({ command: String(parts[2] ?? ''), cwd: String(parts[1] ?? ''), count: e.count, totalMs: e.totalMs, lastAt: e.lastAt });
  }
  return out.sort((a, b) => b.lastAt - a.lastAt).map(({ lastAt: _l, ...rest }) => rest);
}
