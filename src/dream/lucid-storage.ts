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
    const path = join(LUCID_ROOT, e.name);
    try {
      const raw = await readFile(path, 'utf8');
      out.push(JSON.parse(raw) as LucidRun);
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

/** Mutate a finding's status by id. Persists the run. Returns the
 *  updated run (or null if id-not-found). */
export async function updateLucidFindingStatus(
  runId: string,
  findingId: number,
  status: LucidFindingStatus,
): Promise<{ run: LucidRun; finding: LucidFinding } | null> {
  const run = await readLucidRunById(runId);
  if (!run) return null;
  const idx = run.findings.findIndex((f) => f.id === findingId);
  if (idx < 0) return null;
  const finding = run.findings[idx]!;
  finding.status = status;
  if (status === 'applied' || status === 'dismissed') {
    finding.resolved_at = new Date().toISOString();
  }

  // If all findings are resolved, transition run → processed and move file.
  const allResolved =
    run.findings.length > 0 &&
    run.findings.every((f) => f.status === 'applied' || f.status === 'dismissed');
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
export async function dismissEntireLucidRun(runId: string): Promise<LucidRun | null> {
  const run = await readLucidRunById(runId);
  if (!run) return null;
  for (const f of run.findings) {
    if (f.status === 'pending') {
      f.status = 'dismissed';
      f.resolved_at = new Date().toISOString();
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
