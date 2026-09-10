// Reading somora's own log, for the log window in /web.
//
// Until now the only way to see what the server was doing was to ssh in
// and tail a file. When something looks odd — a turn that ended
// strangely, a tool that took too long — that is exactly the moment a
// user has no way to look (Rene 2026-09-10).
//
// Two rules shape this file. Never read a whole log: the directory here
// holds half a gigabyte and one day's file is several megabytes, so
// only the tail is ever touched. And never hand out arbitrary files:
// the caller picks a DAY, not a path.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const LOG_DIR = join(SOMORA_HOME, 'logs');

/** `server.<YYYY-MM-DD>.<n>.log`, which is what pino-roll writes. */
const LOG_FILE = /^server\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/;

/** How much of the tail to parse for one snapshot request. */
const TAIL_BYTES = 512 * 1024;

export interface LogLine {
  ts: number;
  /** pino numeric level: 10 trace … 60 fatal. */
  level: number;
  /** The `msg` field, which is somora's event name. */
  msg: string;
  agent?: string;
  session?: string;
  /** Everything else on the line, for the detail view. */
  fields: Record<string, unknown>;
}

export interface LogQuery {
  /** Day to read, `YYYY-MM-DD`. Defaults to the newest file. */
  day?: string;
  /** Minimum pino level (30 = info, 40 = warn, 50 = error). */
  minLevel?: number;
  /** Case-insensitive substring over the whole raw line. */
  q?: string;
  agent?: string;
  limit?: number;
}

export interface LogSnapshot {
  day: string;
  /** Days that have a log file, newest first. */
  days: string[];
  lines: LogLine[];
  /** Byte offset the reader stopped at — pass it back to follow. */
  offset: number;
  /** True when older lines were cut off by the tail window. */
  truncated: boolean;
}

/** Every day that has a log file, newest first. */
export async function listLogDays(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(LOG_DIR);
  } catch {
    return [];
  }
  const days = new Set<string>();
  for (const e of entries) {
    const m = LOG_FILE.exec(e);
    if (m) days.add(m[1]!);
  }
  return [...days].sort().reverse();
}

/** All files for a day, in write order (pino-roll counts up). */
async function filesForDay(day: string): Promise<string[]> {
  const entries = await readdir(LOG_DIR).catch(() => [] as string[]);
  return entries
    .filter((e) => LOG_FILE.exec(e)?.[1] === day)
    .sort((a, b) => Number(LOG_FILE.exec(a)![2]) - Number(LOG_FILE.exec(b)![2]))
    .map((e) => join(LOG_DIR, e));
}

function parseLine(raw: string): LogLine | null {
  if (!raw.trim()) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { time, level, msg, agent, session, ...fields } = parsed;
  return {
    ts: typeof time === 'number' ? time : Date.now(),
    level: typeof level === 'number' ? level : 30,
    msg: typeof msg === 'string' ? msg : '',
    ...(typeof agent === 'string' ? { agent } : {}),
    ...(typeof session === 'string' ? { session } : {}),
    fields,
  };
}

function matches(line: LogLine, raw: string, query: LogQuery): boolean {
  if (query.minLevel !== undefined && line.level < query.minLevel) return false;
  if (query.agent && line.agent !== query.agent) return false;
  if (query.q && !raw.toLowerCase().includes(query.q.toLowerCase())) return false;
  return true;
}

/** Read a byte range of a file as text, tolerating a missing file. */
async function readRange(path: string, from: number, to: number): Promise<string> {
  if (to <= from) return '';
  return await new Promise<string>((resolve, reject) => {
    let out = '';
    createReadStream(path, { start: from, end: to - 1, encoding: 'utf8' })
      .on('data', (c) => {
        out += c;
      })
      .on('end', () => resolve(out))
      .on('error', (err) => reject(err));
  });
}

/**
 * The end of a day's log, filtered. Reads at most `TAIL_BYTES` from the
 * newest file of that day, so the cost does not grow with the log.
 */
export async function readLogTail(query: LogQuery = {}): Promise<LogSnapshot> {
  const days = await listLogDays();
  const day = query.day ?? days[0];
  if (!day || !days.includes(day)) {
    return { day: day ?? '', days, lines: [], offset: 0, truncated: false };
  }
  const files = await filesForDay(day);
  const path = files.at(-1)!;
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  const from = Math.max(0, size - TAIL_BYTES);
  const text = await readRange(path, from, size);
  // A partial first line is a byte-window artefact, not a log entry.
  const rawLines = text.split('\n');
  if (from > 0) rawLines.shift();
  const limit = Math.min(Math.max(query.limit ?? 300, 1), 2_000);
  const lines: LogLine[] = [];
  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line && matches(line, raw, query)) lines.push(line);
  }
  return {
    day,
    days,
    lines: lines.slice(-limit),
    offset: size,
    truncated: from > 0,
  };
}

/**
 * Lines appended since `offset`. The follow path: cheap, bounded, and
 * it survives the file being rotated or truncated underneath it (a
 * smaller file than the offset means a new one started).
 */
export async function readLogSince(
  offset: number,
  query: LogQuery = {},
): Promise<{ lines: LogLine[]; offset: number; day: string }> {
  const days = await listLogDays();
  const day = query.day ?? days[0];
  if (!day) return { lines: [], offset, day: '' };
  const files = await filesForDay(day);
  const path = files.at(-1);
  if (!path) return { lines: [], offset, day };
  const size = (await stat(path).catch(() => null))?.size ?? 0;
  if (size <= offset) return { lines: [], offset: Math.min(offset, size), day };
  // Bound a burst: a busy second must not deliver a megabyte.
  const from = Math.max(offset, size - TAIL_BYTES);
  const text = await readRange(path, from, size);
  const rawLines = text.split('\n');
  if (from > offset) rawLines.shift();
  const lines: LogLine[] = [];
  for (const raw of rawLines) {
    const line = parseLine(raw);
    if (line && matches(line, raw, query)) lines.push(line);
  }
  return { lines, offset: size, day };
}
