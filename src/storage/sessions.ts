// Filesystem session storage. Layout under SOMORA_HOME (default ~/.somora):
//
//   agents/<agent>/sessions/
//     main.jsonl                          ← magic, always conceptually present
//     main.meta.json
//     20260430-143022_projekt-x.jsonl     ← additional sessions
//     20260430-143022_projekt-x.meta.json
//
// JSONL = one NormalizedEvent per line (append-only, never rewritten).
// Meta JSON = free-form per-session metadata (engine session-id, slug,
// createdAt, future stats).
//
// Session resolution (DECISIONS #13):
//   ref === "main"           → "main"  (always returned, even if file missing)
//   ref matches exact-id     → that exact id (404 if file missing)
//   ref is a slug            → newest existing file with that slug (404 if none)

import { access, appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionMeta, SessionMetaStore } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';

const EXACT_ID_PATTERN = /^\d{8}-\d{6}_[A-Za-z0-9_-]+$/;
const VALID_SLUG = /^[A-Za-z0-9_-]+$/;

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

const VALID_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

function sanitize(name: string, kind: 'agent' | 'session'): string {
  if (!VALID_NAME.test(name)) {
    throw new Error(`invalid ${kind} name: ${JSON.stringify(name)}`);
  }
  return name;
}

function sessionDir(agent: string): string {
  return join(SOMORA_HOME, 'agents', sanitize(agent, 'agent'), 'sessions');
}

function jsonlPath(agent: string, session: string): string {
  return join(sessionDir(agent), `${sanitize(session, 'session')}.jsonl`);
}

function metaPath(agent: string, session: string): string {
  return join(sessionDir(agent), `${sanitize(session, 'session')}.meta.json`);
}

async function ensureDir(agent: string): Promise<void> {
  await mkdir(sessionDir(agent), { recursive: true });
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function getHistory(agent: string, session: string): Promise<NormalizedEvent[]> {
  let raw: string;
  try {
    raw = await readFile(jsonlPath(agent, session), 'utf8');
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const events: NormalizedEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as NormalizedEvent);
    } catch {
      // skip malformed lines — never block readback on a single bad row
    }
  }
  return events;
}

export async function appendEvent(agent: string, session: string, ev: NormalizedEvent): Promise<void> {
  await ensureDir(agent);
  await appendFile(jsonlPath(agent, session), `${JSON.stringify(ev)}\n`);
}

export const sessionMetaStore: SessionMetaStore = {
  async get(agent, session) {
    try {
      const raw = await readFile(metaPath(agent, session), 'utf8');
      return JSON.parse(raw) as SessionMeta;
    } catch (err) {
      if (isEnoent(err)) return {};
      throw err;
    }
  },
  async set(agent, session, meta) {
    await ensureDir(agent);
    const path = metaPath(agent, session);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  },
};

function timestampForFilename(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSessionId(agent: string, ref: string): Promise<string | null> {
  // Magic: main is always usable, even before its file exists
  if (ref === 'main') return 'main';

  // Exact id (YYYYMMDD-HHMMSS_<slug>): must point to an existing file
  if (EXACT_ID_PATTERN.test(ref)) {
    return (await fileExists(jsonlPath(agent, ref))) ? ref : null;
  }

  // Slug: find latest matching file
  if (!VALID_SLUG.test(ref)) return null;
  let entries: string[];
  try {
    entries = await readdir(sessionDir(agent));
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  const matches = entries
    .filter((f) => f.endsWith(`_${ref}.jsonl`) && EXACT_ID_PATTERN.test(f.replace(/\.jsonl$/, '')))
    .sort()
    .reverse();
  if (matches.length === 0) return null;
  return matches[0]!.replace(/\.jsonl$/, '');
}

export async function createSession(agent: string, slug: string): Promise<string> {
  if (!VALID_SLUG.test(slug)) {
    throw new Error(`invalid slug: ${JSON.stringify(slug)}; must match [A-Za-z0-9_-]+`);
  }
  if (slug === 'main') {
    throw new Error('cannot create session with reserved slug "main"');
  }
  const id = `${timestampForFilename()}_${slug}`;
  await ensureDir(agent);
  // Touch the JSONL so it shows up in listings even before any events land
  await appendFile(jsonlPath(agent, id), '');
  await sessionMetaStore.set(agent, id, {
    slug,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export interface SessionSummary {
  id: string;
  slug: string;
  isMain: boolean;
  createdAt: string | null;
  lastActivity: string | null;
  messageCount: number;
}

export async function listSessions(agent: string): Promise<SessionSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionDir(agent));
  } catch (err) {
    if (!isEnoent(err)) throw err;
    entries = [];
  }
  const ids = entries.filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));

  const summaries: SessionSummary[] = [];
  for (const id of ids) {
    const isMain = id === 'main';
    const slug = isMain ? 'main' : (id.match(/^\d{8}-\d{6}_(.+)$/)?.[1] ?? id);
    const meta = await sessionMetaStore.get(agent, id);
    const events = await getHistory(agent, id);
    const lastEv = events[events.length - 1];
    const messageCount = events.filter(
      (e) => e.kind === 'user_message' || e.kind === 'assistant_message',
    ).length;
    summaries.push({
      id,
      slug,
      isMain,
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
      lastActivity: lastEv ? new Date(lastEv.ts).toISOString() : null,
      messageCount,
    });
  }

  // Always surface main, even if its file doesn't exist yet
  if (!summaries.some((s) => s.isMain)) {
    summaries.push({
      id: 'main',
      slug: 'main',
      isMain: true,
      createdAt: null,
      lastActivity: null,
      messageCount: 0,
    });
  }

  // Sort: main first, then newest activity first
  summaries.sort((a, b) => {
    if (a.isMain && !b.isMain) return -1;
    if (b.isMain && !a.isMain) return 1;
    return (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '');
  });
  return summaries;
}
