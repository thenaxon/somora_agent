// Lucid run persistence. One JSON file per run under
// `~/.somora/wiki-lucid/<run-id>.json`. Processed runs (all findings
// resolved) move to `~/.somora/wiki-lucid/processed/`.
//
// File format mirrors LucidRun in lucid-types.ts. Read/write through
// these helpers — keeps schema validation in one place.

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { logger } from '../server/logger.ts';
import type {
  LucidFinding,
  LucidFindingStatus,
  LucidRun,
  LucidRunStatus,
} from './lucid-types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const LUCID_ROOT = join(SOMORA_HOME, 'wiki-lucid');
const LUCID_PROCESSED = join(LUCID_ROOT, 'processed');

async function ensureDirs(): Promise<void> {
  await mkdir(LUCID_ROOT, { recursive: true });
  await mkdir(LUCID_PROCESSED, { recursive: true });
}

function runFilePath(id: string, processed = false): string {
  return join(processed ? LUCID_PROCESSED : LUCID_ROOT, `${id}.json`);
}

export async function writeLucidRun(run: LucidRun): Promise<void> {
  await ensureDirs();
  const text = JSON.stringify(run, null, 2);
  await writeFile(runFilePath(run.id), text, 'utf8');
}

export async function readLucidRunById(id: string): Promise<LucidRun | null> {
  await ensureDirs();
  for (const processed of [false, true]) {
    const path = runFilePath(id, processed);
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as LucidRun;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      logger.warn({ msg: 'lucid.run_read_failed', id, processed, err: (err as Error).message });
    }
  }
  return null;
}

/** List active runs (not processed). Newest first by id (id is
 *  timestamp-prefixed so id-sort = chronological). */
export async function listLucidRuns(): Promise<LucidRun[]> {
  await ensureDirs();
  let entries;
  try {
    entries = await readdir(LUCID_ROOT, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: LucidRun[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    // loop-state.json is the review-loop CONTROL file, not a run. It
    // shares this directory but has no `findings[]`, so reading it as a
    // LucidRun made `dream_list` crash on `r.findings.length` for EVERY
    // agent whenever any review loop was open (2026-07-23, Gustav report).
    if (e.name === 'loop-state.json') continue;
    const path = join(LUCID_ROOT, e.name);
    try {
      const raw = await readFile(path, 'utf8');
      const run = JSON.parse(raw) as LucidRun;
      // Shape-guard: only real runs (with a findings array) belong in the
      // result — defends against any future foreign JSON dropped here.
      if (!run || !Array.isArray(run.findings)) {
        logger.warn({ msg: 'lucid.run_skipped_no_findings', file: e.name });
        continue;
      }
      out.push(run);
    } catch (err) {
      logger.warn({
        msg: 'lucid.run_load_failed',
        file: e.name,
        err: (err as Error).message,
      });
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

export interface PendingLucidSummary {
  /** Completed (approval-pending) runs still living outside processed/. */
  pendingRuns: number;
  /** Sum of findings with status 'pending' across those runs. */
  pendingFindings: number;
  /** created_at (ISO) of the OLDEST pending run — lucid runs are
   *  weekly, so an old timestamp here means reviews are piling up. */
  oldestPendingAt?: string;
}

/**
 * Review-backlog summary for the UI. Counts what REM's pendingCount
 * counts for dreams, but lucid-side: runs that finished their LLM
 * pass (status 'completed') and now wait for a human/agent review via
 * dream_review. Runs that are 'running'/'failed' don't count — they
 * are not actionable approvals. Computed fresh from disk on every
 * call; /dream-states polls this every 30s which is fine for a dir
 * of single-digit JSON files (2026-07-29 feedback: pending lucid runs
 * were invisible in every client).
 */
export async function pendingLucidSummary(): Promise<PendingLucidSummary> {
  const runs = await listLucidRuns();
  const pending = runs.filter((r) => r.status === 'completed');
  const pendingFindings = pending.reduce(
    (sum, r) => sum + r.findings.filter((f) => f.status === 'pending').length,
    0,
  );
  const oldest = pending.reduce<string | undefined>(
    (min, r) => (min === undefined || r.created_at < min ? r.created_at : min),
    undefined,
  );
  return {
    pendingRuns: pending.length,
    pendingFindings,
    ...(oldest !== undefined ? { oldestPendingAt: oldest } : {}),
  };
}

/** Active AND processed runs, newest first. */
export async function listAllLucidRuns(): Promise<LucidRun[]> {
  const active = await listLucidRuns();
  const out = [...active];
  let entries: string[] = [];
  try {
    entries = await readdir(LUCID_PROCESSED);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(join(LUCID_PROCESSED, name), 'utf8')) as LucidRun);
    } catch {
      /* unreadable archive */
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** The newest run that still has findings waiting for a person, or null. */
export async function pendingLucidRun(): Promise<LucidRun | null> {
  const runs = await listLucidRuns();
  return runs.find((r) => r.status === 'completed' && r.findings.some((f) => f.status === 'pending')) ?? null;
}

/** Notes the software writes when it closes a finding on its own. */
const AUTO_NOTES = ['dismissed with the rest at review end', 'auto links off', 'no phrase/target given', 'auto-link budget', 'target page ', 'page ', 'phrase "', 'linked "'];

/** The key under which a finding is remembered: kind + the pages it names. */
export const findingKey = (f: Pick<LucidFinding, 'kind' | 'affected_pages'>): string => `${f.kind}|${[...new Set(f.affected_pages.map((p) => p.toLowerCase()))].sort().join(',')}`;

/**
 * Findings a person dismissed within `days` — filed again they would be
 * the same question twice (the operator, 2026-09-29: "es wurden oft doppelte
 * Dinge gefunden"). Resolved findings are not remembered: the pages
 * changed, a new finding on them is a new question.
 */
export async function recentlyDismissedKeys(days: number, now = Date.now()): Promise<Set<string>> {
  const keys = new Set<string>();
  if (days <= 0) return keys;
  const since = now - days * 86_400_000;
  for (const run of await listAllLucidRuns()) {
    for (const f of run.findings) {
      if (f.status !== 'dismissed' || !f.resolved_at) continue;
      // Only a person's verdict counts: dream_dismiss records a reason.
      // Findings closed by the loop end (with or without the old
      // auto-dismiss) or by the auto-link step carry no such reason —
      // 2026-09-29: 68 real findings were hidden for 90 days that way.
      if (!f.resolution_note || AUTO_NOTES.some((n) => f.resolution_note!.startsWith(n))) continue;
      if (new Date(f.resolved_at).getTime() < since) continue;
      if (f.affected_pages.length === 0) continue;
      keys.add(findingKey(f));
    }
  }
  return keys;
}

/** Mutate a finding's status by id. Persists the run. Returns the
 *  updated run (or null if id-not-found). */
export async function updateLucidFindingStatus(
  runId: string,
  findingId: number,
  status: LucidFindingStatus,
  note?: string,
): Promise<{ run: LucidRun; finding: LucidFinding } | null> {
  const run = await readLucidRunById(runId);
  if (!run) return null;
  const idx = run.findings.findIndex((f) => f.id === findingId);
  if (idx < 0) return null;
  const finding = run.findings[idx]!;
  finding.status = status;
  if (status !== 'pending') {
    finding.resolved_at = new Date().toISOString();
  }
  if (note && note.trim().length > 0) {
    finding.resolution_note = note.trim();
  }

  // If all findings are resolved, transition run → processed and move file.
  // Any non-pending status is terminal (applied / dismissed /
  // resolved_manually) — enumerating them here is a zombie-run trap:
  // a status missing from the list keeps the run out of processed/
  // forever and dream_list resurfaces it on every call.
  const allResolved =
    run.findings.length > 0 && run.findings.every((f) => f.status !== 'pending');
  if (allResolved) {
    run.status = 'processed';
    run.processed_at = new Date().toISOString();
    await writeFile(runFilePath(run.id), JSON.stringify(run, null, 2), 'utf8');
    try {
      await rename(runFilePath(run.id, false), runFilePath(run.id, true));
    } catch (err) {
      logger.warn({
        msg: 'lucid.run_move_to_processed_failed',
        runId,
        err: (err as Error).message,
      });
    }
  } else {
    await writeLucidRun(run);
  }
  return { run, finding };
}

/** Mark all pending findings of a run as dismissed (bulk).
 *
 *  Always archives the run to processed/ when called — even when there
 *  are zero pending findings (e.g. a failed run with `findings: []` or
 *  one whose findings were all already resolved). Without this, failed
 *  runs become zombies that `dream_list` keeps surfacing forever
 *  (verified bug 2026-05-09: id 20260509-072036_manual_lucid). */
export async function dismissEntireLucidRun(
  runId: string,
  note?: string,
  finalStatus: LucidFindingStatus = 'dismissed',
): Promise<LucidRun | null> {
  const run = await readLucidRunById(runId);
  if (!run) return null;
  const trimmedNote = note?.trim();
  for (const f of run.findings) {
    if (f.status === 'pending') {
      f.status = finalStatus;
      f.resolved_at = new Date().toISOString();
      if (trimmedNote) f.resolution_note = trimmedNote;
    }
  }
  run.status = 'processed';
  run.processed_at = new Date().toISOString();
  await writeFile(runFilePath(run.id), JSON.stringify(run, null, 2), 'utf8');
  try {
    await rename(runFilePath(run.id, false), runFilePath(run.id, true));
  } catch (err) {
    logger.warn({ msg: 'lucid.run_move_to_processed_failed', runId, err: (err as Error).message });
  }
  return run;
}

export function setRunStatus(run: LucidRun, status: LucidRunStatus, error?: string): void {
  run.status = status;
  if (status === 'completed') run.completed_at = new Date().toISOString();
  if (status === 'processed') run.processed_at = new Date().toISOString();
  if (error) run.error = error;
}
