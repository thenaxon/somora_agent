// Filesystem session storage. Layout under SOMORA_HOME (default ~/.somora):
//
//   agents/<agent>/sessions/
//     main.jsonl                          ← always exists once written to
//     main.meta.json
//     20260430-143022_projekt-x.jsonl     ← additional sessions (1d+)
//     20260430-143022_projekt-x.meta.json
//
// JSONL = one NormalizedEvent per line (append-only, never rewritten).
// Meta JSON = free-form per-session metadata (engine session-id, future stats).
//
// Session names are taken as-is — sanitization to prevent path traversal is
// done by sanitizeSessionName(). The slug+timestamp filename scheme from
// DECISIONS #13 is still pending: for now `session = "main"` → main.jsonl,
// other names → <name>.jsonl. Slug-with-history-resolution comes in step 1d.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionMeta, SessionMetaStore } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';

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
