// Dream file storage. Layout under each agent's memory directory:
//
//   ~/.somora/agents/<agent>/memory/.dreams/
//     <id>.dream.running.md       ← extraction in flight
//     <id>.dream.paused.md        ← extraction interrupted, will resume
//     <id>.dream.failed.md        ← extraction errored unrecoverably
//     <id>.dream.md               ← extraction completed, findings pending review
//   ~/.somora/agents/<agent>/memory/.dreams/processed/
//     <id>.dream.md               ← all findings resolved; archived for audit
//
// Filename suffix = current status. Atomic-rename on transitions.
// Each file is self-contained: YAML frontmatter (DreamMeta) + Markdown body.
//
// Why dotfile dir: chokidar's watcher (memory/manager.ts) skips dot-prefixed
// components, so .dreams/ files don't end up in the memory recall index.

import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import matter from 'gray-matter';
import { logger } from '../server/logger.ts';
import type { DreamFile, DreamMeta, DreamStatus, Finding, FindingStatus } from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

const STATUS_SUFFIX: Record<DreamStatus, string> = {
  running: '.dream.running.md',
  paused: '.dream.paused.md',
  failed: '.dream.failed.md',
  completed: '.dream.md',
  processed: '.dream.md', // lives in processed/ subdir, suffix same
};

export function dreamsDir(agent: string): string {
  return join(SOMORA_HOME, 'agents', agent, 'memory', '.dreams');
}

export function processedDir(agent: string): string {
  return join(dreamsDir(agent), 'processed');
}

export function dreamFilePath(agent: string, id: string, status: DreamStatus): string {
  const suffix = STATUS_SUFFIX[status];
  return status === 'processed'
    ? join(processedDir(agent), `${id}${suffix}`)
    : join(dreamsDir(agent), `${id}${suffix}`);
}

export async function ensureDreamDirs(agent: string): Promise<void> {
  await mkdir(processedDir(agent), { recursive: true });
}

/**
 * Atomically write a DreamFile to its current-status path. Writes to
 * `<path>.tmp` then renames; ensures readers never see a half-written
 * file. Caller is responsible for the previous-status file's removal
 * (see transitionDreamStatus).
 */
export async function writeDreamFile(
  agent: string,
  file: DreamFile,
): Promise<{ path: string }> {
  await ensureDreamDirs(agent);
  const path = dreamFilePath(agent, file.meta.id, file.meta.status);
  const tmp = `${path}.tmp`;
  const yaml = matter.stringify(file.body, file.meta as unknown as Record<string, unknown>);
  await writeFile(tmp, yaml, 'utf8');
  await rename(tmp, path);
  return { path };
}

/**
 * Read a dream file by id, scanning both the active .dreams/ dir and
 * the processed/ subdir. Returns null if not found in any state.
 */
export async function readDreamById(agent: string, id: string): Promise<DreamFile | null> {
  // Try each possible status — most likely first for the typical UI flow
  // (completed when user reviews; running/paused/failed for diagnostics).
  for (const status of ['completed', 'running', 'paused', 'failed', 'processed'] as const) {
    const path = dreamFilePath(agent, id, status);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = matter(raw);
      const meta = parsed.data as unknown as DreamMeta;
      // Defensive: trust the file's own status field, not the suffix
      return { meta, body: parsed.content };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

/**
 * List dreams for an agent. By default returns active (non-processed)
 * dreams sorted oldest-first (so users naturally process them in order).
 */
export async function listDreams(
  agent: string,
  opts: { includeProcessed?: boolean } = {},
): Promise<DreamFile[]> {
  await ensureDreamDirs(agent);
  const out: DreamFile[] = [];

  const scan = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      const path = join(dir, name);
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = matter(raw);
        out.push({ meta: parsed.data as unknown as DreamMeta, body: parsed.content });
      } catch (err) {
        logger.warn({
          msg: 'dream.read_failed',
          agent,
          path,
          err: (err as Error).message,
        });
      }
    }
  };

  await scan(dreamsDir(agent));
  if (opts.includeProcessed) await scan(processedDir(agent));

  out.sort((a, b) => a.meta.created_at.localeCompare(b.meta.created_at));
  return out;
}

/**
 * Transition a dream's status. Writes the file at the new path and
 * removes the old. If the old file is missing (already moved or
 * crash-recovered), proceed silently — idempotent.
 *
 * On status='processed' the file moves into the processed/ subdir.
 */
export async function transitionDreamStatus(
  agent: string,
  file: DreamFile,
  newStatus: DreamStatus,
  patches?: Partial<DreamMeta>,
): Promise<{ path: string }> {
  const oldPath = dreamFilePath(agent, file.meta.id, file.meta.status);
  const updated: DreamFile = {
    meta: {
      ...file.meta,
      ...patches,
      status: newStatus,
    },
    body: file.body,
  };
  const result = await writeDreamFile(agent, updated);
  if (oldPath !== result.path) {
    try {
      await unlink(oldPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({
          msg: 'dream.unlink_old_failed',
          agent,
          oldPath,
          err: (err as Error).message,
        });
      }
    }
  }
  return result;
}

/**
 * Update a single finding's status (applied / dismissed). Re-checks
 * whether all findings are now resolved; if so, transitions the dream
 * to 'processed' (moves to processed/ dir).
 */
export async function updateFindingStatus(
  agent: string,
  dreamId: string,
  findingId: number,
  newStatus: FindingStatus,
): Promise<{ dream: DreamFile; allResolved: boolean }> {
  const file = await readDreamById(agent, dreamId);
  if (!file) throw new Error(`dream '${dreamId}' not found`);
  const finding = file.meta.findings.find((f) => f.id === findingId);
  if (!finding) throw new Error(`finding ${findingId} not in dream '${dreamId}'`);
  if (finding.status !== 'pending') {
    throw new Error(`finding ${findingId} is already ${finding.status}, can't transition again`);
  }
  finding.status = newStatus;
  finding.resolved_at = new Date().toISOString();

  const allResolved = file.meta.findings.every((f) => f.status !== 'pending');
  if (allResolved && file.meta.status === 'completed') {
    const result = await transitionDreamStatus(agent, file, 'processed', {
      processed_at: new Date().toISOString(),
    });
    return { dream: { ...file, meta: { ...file.meta, status: 'processed' } }, allResolved: true };
  }
  await writeDreamFile(agent, file);
  return { dream: file, allResolved: false };
}

/**
 * Bulk-dismiss every still-pending finding in a dream (the "throw the
 * whole dream out" path). Transitions the dream to processed.
 */
export async function dismissEntireDream(
  agent: string,
  dreamId: string,
): Promise<{ dream: DreamFile; dismissedCount: number }> {
  const file = await readDreamById(agent, dreamId);
  if (!file) throw new Error(`dream '${dreamId}' not found`);
  const now = new Date().toISOString();
  let dismissedCount = 0;
  for (const f of file.meta.findings) {
    if (f.status === 'pending') {
      f.status = 'dismissed';
      f.resolved_at = now;
      dismissedCount++;
    }
  }
  const result = await transitionDreamStatus(agent, file, 'processed', {
    processed_at: now,
  });
  return {
    dream: { ...file, meta: { ...file.meta, status: 'processed' } },
    dismissedCount,
  };
}

/**
 * One-shot housekeeping: any `completed`-status dreams whose findings
 * array is empty get moved to processed/. They have nothing for the user
 * to review or dismiss — without this, they would sit in the active
 * .dreams/ dir forever. Run at server start, idempotent.
 */
export async function archiveEmptyCompletedDreams(agents: string[]): Promise<number> {
  let moved = 0;
  for (const agent of agents) {
    const dir = dreamsDir(agent);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of entries) {
      // We only auto-archive completed dreams (.dream.md, no other suffix
      // marker). running/paused/failed/processed dreams must stay where
      // they are.
      if (!name.endsWith('.dream.md')) continue;
      const path = join(dir, name);
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = matter(raw);
        const meta = parsed.data as unknown as DreamMeta;
        if (meta.status !== 'completed') continue;
        if (Array.isArray(meta.findings) && meta.findings.length > 0) continue;
        // Empty completed → process.
        await transitionDreamStatus(
          agent,
          { meta, body: parsed.content },
          'processed',
          { processed_at: new Date().toISOString() },
        );
        moved++;
      } catch (err) {
        logger.warn({
          msg: 'dream.empty_archive_failed',
          agent,
          path,
          err: (err as Error).message,
        });
      }
    }
  }
  if (moved > 0) {
    logger.info({ msg: 'dream.empty_archived', count: moved, agents });
  }
  return moved;
}

/**
 * Server-start housekeeping: when multiple paused dreams exist for the
 * SAME source-session (a sign that resume cycles failed to clean up
 * after themselves — see hans bug 2026-05-05), keep only the newest
 * paused per source-session and unlink the rest. The newest captures
 * the most recent state; older ones are stale by-products of the bug
 * that's fixed in resumeDream().
 *
 * Single-paused-per-source-session is the steady state going forward:
 * resumeDream() now unlinks the old paused before kicking off the new
 * run, so accumulation can't recur.
 *
 * Idempotent. No-op when each source-session has at most one paused.
 * Runs alongside archiveEmptyCompletedDreams + recoverOrphanRunningDreams
 * at server boot in src/server/index.ts.
 */
export async function consolidateStalePausedDreams(agents: string[]): Promise<number> {
  let removed = 0;
  for (const agent of agents) {
    const all = await listDreams(agent);
    const pausedBySession = new Map<string, DreamFile[]>();
    for (const d of all) {
      if (d.meta.status !== 'paused') continue;
      const list = pausedBySession.get(d.meta.source_session) ?? [];
      list.push(d);
      pausedBySession.set(d.meta.source_session, list);
    }
    for (const [source, group] of pausedBySession) {
      if (group.length <= 1) continue;
      // Sort newest-first by id (ids are timestamp-prefixed → lexicographic
      // = chronological). Keep [0], unlink the rest.
      group.sort((a, b) => b.meta.id.localeCompare(a.meta.id));
      const keep = group[0]!;
      const drop = group.slice(1);
      for (const d of drop) {
        const path = dreamFilePath(agent, d.meta.id, 'paused');
        try {
          await unlink(path);
          removed++;
          logger.info({
            msg: 'dream.consolidate_stale_paused',
            agent,
            id: d.meta.id,
            source_session: source,
            kept: keep.meta.id,
            findings_in_dropped: d.meta.findings.length,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn({
              msg: 'dream.consolidate_unlink_failed',
              agent,
              path,
              err: (err as Error).message,
            });
          }
        }
      }
    }
  }
  if (removed > 0) {
    logger.info({ msg: 'dream.consolidate_done', removed_count: removed, agents });
  }
  return removed;
}

/**
 * Crash-recovery: scan all agents on server start, rename any
 * `*.dream.running.md` to `.paused.md`. Findings already extracted are
 * preserved; the next idle-trigger continues from chunks_done + 1.
 */
export async function recoverOrphanRunningDreams(agents: string[]): Promise<number> {
  let recovered = 0;
  for (const agent of agents) {
    const dir = dreamsDir(agent);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const name of entries) {
      if (!name.endsWith('.dream.running.md')) continue;
      const path = join(dir, name);
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = matter(raw);
        const meta = parsed.data as unknown as DreamMeta;
        if (meta.trigger === 'manual') {
          // Manual dreams don't pause — but if the server crashed, mark
          // as failed so the user can decide whether to retry. Don't try
          // to auto-resume manual dreams (they had a specific scope tied
          // to a /reset action; hidden auto-resume would be confusing).
          await transitionDreamStatus(
            agent,
            { meta, body: parsed.content },
            'failed',
            { error: 'server crashed during manual extraction; partial findings preserved' },
          );
        } else {
          await transitionDreamStatus(agent, { meta, body: parsed.content }, 'paused');
        }
        recovered++;
      } catch (err) {
        logger.warn({
          msg: 'dream.orphan_recovery_failed',
          agent,
          path,
          err: (err as Error).message,
        });
      }
    }
  }
  if (recovered > 0) {
    logger.info({ msg: 'dream.orphans_recovered', count: recovered, agents });
  }
  return recovered;
}

export function dreamIdFor(agent: string, sourceSession: string, trigger: 'auto' | 'manual', date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${ts}_${trigger}_${sourceSession}`;
}
