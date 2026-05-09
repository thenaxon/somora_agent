// Single-run orchestrator for Dream-C / Lint (Phase 4 / Stufe 5).
//
// One invocation: load wiki snapshot, run all detectors, persist the
// LintRun. No LLM in MVP — only deterministic checks. Semantic checks
// (contradictions, stale claims) deferred.

import { join } from 'node:path';

import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { runAllDetectors, readWikiSnapshot } from './lint-detector.ts';
import {
  lintRunIdFor,
  transitionLintRunStatus,
  writeLintRun,
} from './lint-storage.ts';
import type { LintRun } from './lint-types.ts';
import { resolveObsidianSource } from '../memory/registry.ts';

export interface RunLintArgs {
  config: Config;
  trigger: 'auto' | 'manual';
}

export interface RunLintResult {
  runId: string;
  findingsCount: number;
  pagesScanned: number;
  durationMs: number;
  status: 'completed' | 'processed' | 'failed';
}

export async function runLint(args: RunLintArgs): Promise<RunLintResult> {
  const start = Date.now();
  const id = lintRunIdFor(args.trigger);

  // Resolve wiki location from server config.
  const obs = resolveObsidianSource(args.config.obsidian);
  if (!obs?.vaultPath) {
    return failRun(id, args.trigger, 'no obsidian vault configured', start);
  }
  const wikiAbs = join(obs.vaultPath, args.config.wiki.vaultSubfolder);

  const initial: LintRun = {
    id,
    status: 'running',
    trigger: args.trigger,
    created_at: new Date().toISOString(),
    pages_scanned: 0,
    findings: [],
  };
  await writeLintRun(initial);
  logger.info({ msg: 'dream.lucid.start', id, trigger: args.trigger, wikiAbs });

  let snapshot;
  try {
    snapshot = await readWikiSnapshot(wikiAbs);
  } catch (err) {
    return failRun(id, args.trigger, `snapshot read failed: ${(err as Error).message}`, start);
  }

  const result = runAllDetectors(snapshot);
  const completedAt = new Date().toISOString();

  // Zero-findings → directly to processed/. Mirrors Dream-A behavior.
  const isEmpty = result.findings.length === 0;
  const next: LintRun = {
    ...initial,
    status: isEmpty ? 'processed' : 'completed',
    completed_at: completedAt,
    ...(isEmpty ? { processed_at: completedAt } : {}),
    pages_scanned: result.pagesScanned,
    findings: result.findings,
  };
  await transitionLintRunStatus(id, 'running', next.status, next);

  logger.info({
    msg: 'dream.lucid.done',
    id,
    findings: result.findings.length,
    pages_scanned: result.pagesScanned,
    by_kind: countByKind(result.findings),
    durationMs: Date.now() - start,
  });

  return {
    runId: id,
    findingsCount: result.findings.length,
    pagesScanned: result.pagesScanned,
    durationMs: Date.now() - start,
    status: next.status as 'completed' | 'processed' | 'failed',
  };
}

async function failRun(
  id: string,
  trigger: 'auto' | 'manual',
  error: string,
  start: number,
): Promise<RunLintResult> {
  logger.error({ msg: 'dream.lucid.failed', id, error });
  const failed: LintRun = {
    id,
    status: 'failed',
    trigger,
    created_at: new Date().toISOString(),
    error,
    pages_scanned: 0,
    findings: [],
  };
  try {
    await writeLintRun(failed);
  } catch (err) {
    logger.warn({ msg: 'dream.lucid.failure_write_fail', err: (err as Error).message });
  }
  return {
    runId: id,
    findingsCount: 0,
    pagesScanned: 0,
    durationMs: Date.now() - start,
    status: 'failed',
  };
}

function countByKind(findings: import('./lint-types.ts').LintFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    out[f.kind] = (out[f.kind] ?? 0) + 1;
  }
  return out;
}
