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

import { access, appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
    // Per-call unique tmp suffix so concurrent writers don't race the
    // same `<path>.tmp` filename. process.pid alone isn't enough when
    // multiple async paths run in the same process; add a counter +
    // randomness as well.
    const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
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
  await ensureDir(agent);
  const baseId = `${timestampForFilename()}_${slug}`;
  // Collision retry: when two callers create sessions with the same
  // slug in the same second (parallel subagent spawns are the common
  // case), the base id collides. Append `-N` until we find a free
  // slot. Use the exclusive-create flag (wx) to atomically claim the
  // jsonl filename — racing creators will get EEXIST and retry.
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = attempt === 0 ? baseId : `${baseId}-${attempt}`;
    try {
      await writeFile(jsonlPath(agent, id), '', { flag: 'wx' });
      await sessionMetaStore.set(agent, id, {
        slug: attempt === 0 ? slug : `${slug}-${attempt}`,
        createdAt: new Date().toISOString(),
      });
      return id;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`createSession: could not find a free id starting from '${baseId}'`);
}

/**
 * Reset a session: archive its current jsonl + meta to a timestamped name,
 * and start the original session id fresh (empty jsonl, minimal meta).
 *
 * Use case: the magic `main` session can't be replaced — it always exists
 * for an agent. Over months of chatting, the JSONL grows past anything
 * useful and provider-side caches roll over expensively. /reset gives the
 * user a clean main while preserving the old content as a resume-able
 * archived session.
 *
 * Behavior:
 *   - If the source jsonl doesn't exist → nothing to do, returns null.
 *   - Archive name: `<UTC-timestamp>_<sourceId>-archive.jsonl|.meta.json`
 *   - The archived session can be resumed with `/session <archive-id>`
 *     just like any other session (its meta keeps the prior engine
 *     session-ids so claude/codex resume still works).
 *   - The freshly-empty original gets a meta with only `slug` (preserved
 *     from the source meta) so future turns start clean.
 */
export async function resetSession(
  agent: string,
  session: string,
): Promise<{ archivedId: string } | null> {
  await ensureDir(agent);
  const srcJsonl = jsonlPath(agent, session);
  if (!(await fileExists(srcJsonl))) return null;

  const ts = timestampForFilename();
  const archivedId = `${ts}_${sanitize(session, 'session')}-archive`;
  const dstJsonl = jsonlPath(agent, archivedId);
  const dstMeta = metaPath(agent, archivedId);

  await rename(srcJsonl, dstJsonl);
  const srcMetaPath = metaPath(agent, session);
  let preservedSlug: string | undefined;
  let archivedMeta: SessionMeta | null = null;
  if (await fileExists(srcMetaPath)) {
    try {
      const raw = await readFile(srcMetaPath, 'utf8');
      const parsed = JSON.parse(raw) as SessionMeta;
      preservedSlug = typeof parsed.slug === 'string' ? parsed.slug : undefined;
      archivedMeta = parsed;
    } catch {
      // best-effort; don't block reset on a malformed meta
    }
    await rename(srcMetaPath, dstMeta);
  }
  // Flag the new archive copy explicitly so the Sessions tool surfaces it
  // in the Archived tab without relying solely on the `-archive` id-suffix
  // detection. Legacy archives created before this commit are still picked
  // up via the suffix check in metaIsArchived().
  if (archivedMeta) {
    await sessionMetaStore.set(agent, archivedId, {
      ...archivedMeta,
      archived: true,
      archivedAt: new Date().toISOString(),
      archiveReason: archivedMeta.archiveReason ?? 'auto-archive on /reset',
    });
  }

  // Fresh meta for the resurrected session id. Slug preserved so
  // listSessions still surfaces it sensibly.
  const freshMeta: SessionMeta = {
    ...(preservedSlug ? { slug: preservedSlug } : {}),
    createdAt: new Date().toISOString(),
    resetFrom: archivedId,
  };
  await writeFile(metaPath(agent, session), JSON.stringify(freshMeta, null, 2), 'utf8');

  // Touch an empty jsonl so the source session id stays resolvable.
  // Without this, resolveSessionId() returns null for non-main ids
  // (their fileExists() check fails), and any subsequent /chat/send
  // 404s. `main` would still work via its magic path, but non-main
  // sessions are equally allowed to /reset per the TUI hint.
  await appendFile(jsonlPath(agent, session), '');

  return { archivedId };
}

export interface SessionSummary {
  id: string;
  slug: string;
  isMain: boolean;
  createdAt: string | null;
  lastActivity: string | null;
  messageCount: number;
  /** True if `meta.archived === true` or the id ends in `-archive`. */
  isArchived: boolean;
  /** Bytes on disk for the jsonl file (0 if file is missing — e.g. magic main). */
  byteSize: number;
  /** Last engine that touched this session (claude-cli / codex-cli / openai-compatible). */
  engine?: string;
  /** REM read-through marker (ms since epoch) — null if never. */
  dreamCoverageTs: number | null;
  /** Number of events with ts > dreamCoverageTs (i.e. not yet REM'd). */
  dreamLagEvents: number;
  /** Optional human note from the archive call. */
  archiveReason?: string;
  /** ISO timestamp when archived (manual archive or /reset). */
  archivedAt?: string;
  /** Currently-pinned project slug, if any (Phase Projects v1). Reflects
   *  the CURRENT state of session.meta.projectSlug — over a session's
   *  lifetime this can change as /projekt switches happen. Clients that
   *  want full per-session project history derive it from JSONL
   *  `project_switched` events. */
  projectSlug?: string;
  /** ISO timestamp of the latest unread-candidate event (A2A in,
   *  sentinel in, assistant final reply). Null if none yet. Compared
   *  against `seenAt` to compute the unread-badge state. */
  unreadAt?: string | null;
  /** ISO timestamp of when the user last opened this session in any
   *  client. Updated by POST /sessions/:agent/:session/seen. */
  seenAt?: string | null;
}

/** Returns true if the session is considered archived for filtering purposes:
 *  either the meta has `archived: true` (explicit user action OR /reset
 *  writing it forward), or the id ends in `-archive` (legacy /reset output
 *  before the explicit flag — backward-compat detect). */
function metaIsArchived(id: string, meta: SessionMeta): boolean {
  return meta.archived === true || id.endsWith('-archive');
}

interface CachedStats {
  jsonlMtime: number;
  messageCount: number;
  byteSize: number;
  lastEventTs: number | null;
}

/** Cached projection of jsonl stats. Reads the cache from meta and trusts it
 *  if the recorded jsonlMtime matches the current file mtime; otherwise
 *  recomputes and writes back. Active-chat sessions invalidate naturally
 *  every turn (mtime bumps) — that's OK, list calls are rare relative to
 *  turns. */
async function readSessionStats(agent: string, id: string, meta: SessionMeta): Promise<CachedStats> {
  let jsonlMtime: number;
  let byteSize: number;
  try {
    const s = await stat(jsonlPath(agent, id));
    jsonlMtime = s.mtimeMs;
    byteSize = s.size;
  } catch (err) {
    if (isEnoent(err)) {
      // Magic main without a file yet — return zeros, no cache write.
      return { jsonlMtime: 0, messageCount: 0, byteSize: 0, lastEventTs: null };
    }
    throw err;
  }
  const cache = meta.cache as CachedStats | undefined;
  if (cache && typeof cache.jsonlMtime === 'number' && cache.jsonlMtime === jsonlMtime) {
    // Hit — trust the cache for messageCount + lastEventTs, but always
    // surface the live byteSize from stat (matches the cached value since
    // mtime is the same, but cheaper to trust stat).
    return {
      jsonlMtime,
      messageCount: cache.messageCount,
      byteSize,
      lastEventTs: cache.lastEventTs ?? null,
    };
  }
  // Miss — recompute by streaming the jsonl. getHistory parses every line;
  // for very large sessions this is the slow path. Acceptable on cache-miss
  // (which only happens after a real write).
  const events = await getHistory(agent, id);
  const lastEv = events[events.length - 1];
  const messageCount = events.filter(
    (e) => e.kind === 'user_message' || e.kind === 'assistant_message',
  ).length;
  const lastEventTs = lastEv ? (lastEv.ts as number) : null;
  const stats: CachedStats = { jsonlMtime, messageCount, byteSize, lastEventTs };
  // Write back the cache. Best-effort — if the meta write races a concurrent
  // turn writing other fields, the LAST writer wins. Cache is regenerable
  // so loss isn't a correctness issue.
  try {
    await sessionMetaStore.set(agent, id, { ...meta, cache: stats });
  } catch {
    /* best-effort cache write */
  }
  return stats;
}

/** Count events with ts > coverage. coverage=null means REM has never run,
 *  so all events are lag. */
function dreamLag(events: NormalizedEvent[], coverage: number | null): number {
  if (coverage === null || coverage === 0) return events.length;
  return events.filter((e) => (e.ts as number) > coverage).length;
}

export interface ListSessionsOptions {
  /** Include archived sessions in the result. Defaults to false — archived
   *  sessions should only surface in the dedicated Sessions tool, not in
   *  slash-command pickers or default chat-window UI. */
  includeArchived?: boolean;
}

export async function listSessions(
  agent: string,
  options: ListSessionsOptions = {},
): Promise<SessionSummary[]> {
  const includeArchived = options.includeArchived ?? false;
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
    const isArchived = metaIsArchived(id, meta);
    if (isArchived && !includeArchived) continue;
    const stats = await readSessionStats(agent, id, meta);
    // Dream-lag needs the event list — only fetch it for cache-miss or for
    // the live sessions where the coverage might lag the latest event. We
    // already paid for getHistory in the cache-miss branch above; for hits
    // we re-fetch only when there's a chance of lag (coverage < lastEventTs).
    const coverage = typeof meta.dreamReadThroughTs === 'number' ? meta.dreamReadThroughTs : null;
    let lag = 0;
    if (stats.lastEventTs !== null) {
      if (coverage === null) {
        lag = stats.messageCount; // approximate: never-dreamed → all events lag
      } else if (coverage < stats.lastEventTs) {
        // Refetch events for an exact count — list-call performance is OK
        // because this only fires for sessions with actual dream-lag.
        const events = await getHistory(agent, id);
        lag = dreamLag(events, coverage);
      }
    }
    summaries.push({
      id,
      slug,
      isMain,
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : null,
      lastActivity: stats.lastEventTs !== null ? new Date(stats.lastEventTs).toISOString() : null,
      messageCount: stats.messageCount,
      isArchived,
      byteSize: stats.byteSize,
      engine: typeof meta.engine === 'string' ? meta.engine : undefined,
      dreamCoverageTs: coverage,
      dreamLagEvents: lag,
      archiveReason: typeof meta.archiveReason === 'string' ? meta.archiveReason : undefined,
      archivedAt: typeof meta.archivedAt === 'string' ? meta.archivedAt : undefined,
      projectSlug: typeof meta.projectSlug === 'string' ? meta.projectSlug : undefined,
      unreadAt: typeof meta.unreadAt === 'string' ? meta.unreadAt : null,
      seenAt: typeof meta.seenAt === 'string' ? meta.seenAt : null,
    });
  }

  // Always surface main, even if its file doesn't exist yet (and it's
  // never archived).
  if (!summaries.some((s) => s.isMain)) {
    summaries.push({
      id: 'main',
      slug: 'main',
      isMain: true,
      createdAt: null,
      lastActivity: null,
      messageCount: 0,
      isArchived: false,
      byteSize: 0,
      dreamCoverageTs: null,
      dreamLagEvents: 0,
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

/** Mark a session archived via its meta. No file movement — the jsonl stays
 *  where it is, the meta gains `archived: true` + timestamp + optional reason.
 *  The `main` session is special: archiving main creates a `<ts>_main-archive`
 *  copy via resetSession instead (because main must always remain usable). */
export async function archiveSession(
  agent: string,
  session: string,
  reason?: string,
): Promise<void> {
  if (session === 'main') {
    throw new Error(
      "cannot archive the magic 'main' session directly — use /reset to spawn an archived copy",
    );
  }
  const meta = await sessionMetaStore.get(agent, session);
  await sessionMetaStore.set(agent, session, {
    ...meta,
    archived: true,
    archivedAt: new Date().toISOString(),
    ...(reason ? { archiveReason: reason } : {}),
  });
}

/** Clear the archived flag. The id-suffix detection (`-archive`) still
 *  fires for legacy reset-archives, so unarchiving one of those is a no-op
 *  for visibility purposes — the suffix check overrides the meta flag.
 *  We still clear the meta flag for consistency. */
export async function unarchiveSession(agent: string, session: string): Promise<void> {
  const meta = await sessionMetaStore.get(agent, session);
  const next = { ...meta };
  delete next.archived;
  delete next.archivedAt;
  delete next.archiveReason;
  await sessionMetaStore.set(agent, session, next);
}
