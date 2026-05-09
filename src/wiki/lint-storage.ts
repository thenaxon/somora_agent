// Lint-Run persistence (Phase 4 / Stufe 5).
//
// Lint runs are server-global (about the wiki, not any one agent).
// They live at `~/.somora/wiki-lint/<id>.lint.<status>.md` — same
// pattern as Dream-A's per-agent .dreams/ but in a shared dir.
//
// Statuses: running, completed, failed, processed (analog to Dream-A).
// File rename moves the run between statuses; atomic on the same
// filesystem. completed-with-zero-findings auto-archives directly to
// processed/ (mirrors Dream-A's behavior).

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';

import { logger } from '../server/logger.ts';
import type {
  LintFinding,
  LintFindingStatus,
  LintRun,
  LintRunStatus,
} from './lint-types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
const LINT_DIR = join(SOMORA_HOME, 'wiki-lint');
const PROCESSED_DIR = join(LINT_DIR, 'processed');

export function lintRunPath(id: string, status: LintRunStatus): string {
  if (status === 'processed') return join(PROCESSED_DIR, `${id}.lint.md`);
  if (status === 'completed') return join(LINT_DIR, `${id}.lint.md`);
  return join(LINT_DIR, `${id}.lint.${status}.md`);
}

export function lintRunIdFor(trigger: 'auto' | 'manual'): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${stamp}_${trigger}_lint`;
}

export async function ensureLintDirs(): Promise<void> {
  await mkdir(LINT_DIR, { recursive: true });
  await mkdir(PROCESSED_DIR, { recursive: true });
}

// ─── Read / Write ────────────────────────────────────────────────────

export async function writeLintRun(run: LintRun): Promise<void> {
  await ensureLintDirs();
  const path = lintRunPath(run.id, run.status);
  const body = renderBody(run);
  const stringified = matter.stringify(body, run as unknown as Record<string, unknown>);
  // Atomic rewrite: write to .tmp then rename
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, stringified, 'utf8');
  await rename(tmp, path);
}

export async function readLintRunById(id: string): Promise<LintRun | null> {
  for (const status of ['running', 'completed', 'failed', 'processed'] as LintRunStatus[]) {
    const path = lintRunPath(id, status);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = matter(raw);
      return parsed.data as unknown as LintRun;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

export async function listLintRuns(opts?: {
  includeProcessed?: boolean;
}): Promise<LintRun[]> {
  await ensureLintDirs();
  const out: LintRun[] = [];
  // Active dirs: LINT_DIR for running/completed/failed, PROCESSED_DIR
  // when includeProcessed.
  const dirs: string[] = [LINT_DIR];
  if (opts?.includeProcessed) dirs.push(PROCESSED_DIR);
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.md')) continue;
      const path = join(dir, e.name);
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = matter(raw);
        out.push(parsed.data as unknown as LintRun);
      } catch (err) {
        logger.warn({ msg: 'dream.lucid.run_read_failed', path, err: (err as Error).message });
      }
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ─── Status transitions ──────────────────────────────────────────────

export async function transitionLintRunStatus(
  id: string,
  fromStatus: LintRunStatus,
  toStatus: LintRunStatus,
  patch: Partial<LintRun>,
): Promise<LintRun | null> {
  const fromPath = lintRunPath(id, fromStatus);
  let raw: string;
  try {
    raw = await readFile(fromPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = matter(raw);
  const current = parsed.data as unknown as LintRun;
  const next: LintRun = { ...current, ...patch, status: toStatus };
  const body = renderBody(next);
  const newStringified = matter.stringify(body, next as unknown as Record<string, unknown>);
  const toPath = lintRunPath(id, toStatus);
  if (toPath !== fromPath) {
    await mkdir(join(toPath, '..'), { recursive: true });
  }
  // Write to a tmp at the destination dir, then atomically rename to
  // the final path; finally remove the source if it's a different path.
  const tmp = `${toPath}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, newStringified, 'utf8');
  await rename(tmp, toPath);
  if (toPath !== fromPath) {
    try {
      await unlink(fromPath);
    } catch {
      // best-effort
    }
  }
  return next;
}

export async function updateLintFindingStatus(
  id: string,
  fromStatus: LintRunStatus,
  findingId: number,
  newFindingStatus: LintFindingStatus,
): Promise<LintRun | null> {
  const path = lintRunPath(id, fromStatus);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = matter(raw);
  const current = parsed.data as unknown as LintRun;
  const idx = current.findings.findIndex((f: LintFinding) => f.id === findingId);
  if (idx === -1) return current;
  const updated: LintFinding = {
    ...current.findings[idx]!,
    status: newFindingStatus,
    resolved_at: new Date().toISOString(),
  } as LintFinding;
  const newFindings = [...current.findings];
  newFindings[idx] = updated;
  const next: LintRun = { ...current, findings: newFindings };
  // If all findings are now resolved (applied/dismissed), transition
  // the run to 'processed'.
  const allResolved = next.findings.every(
    (f) => f.status === 'applied' || f.status === 'dismissed',
  );
  if (allResolved && next.status === 'completed') {
    next.status = 'processed';
    next.processed_at = new Date().toISOString();
    const body = renderBody(next);
    const newStringified = matter.stringify(body, next as unknown as Record<string, unknown>);
    const toPath = lintRunPath(id, 'processed');
    await mkdir(PROCESSED_DIR, { recursive: true });
    const tmp = `${toPath}.tmp.${process.pid}.${Date.now().toString(36)}`;
    await writeFile(tmp, newStringified, 'utf8');
    await rename(tmp, toPath);
    try {
      await unlink(path);
    } catch {
      // best-effort
    }
  } else {
    const body = renderBody(next);
    const newStringified = matter.stringify(body, next as unknown as Record<string, unknown>);
    const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
    await writeFile(tmp, newStringified, 'utf8');
    await rename(tmp, path);
  }
  return next;
}

export async function dismissEntireLintRun(id: string): Promise<LintRun | null> {
  const run = await readLintRunById(id);
  if (!run) return null;
  if (run.status !== 'completed') return run;
  const next: LintRun = {
    ...run,
    findings: run.findings.map((f) => ({
      ...f,
      status: f.status === 'pending' ? 'dismissed' : f.status,
      resolved_at: f.resolved_at ?? new Date().toISOString(),
    })),
    status: 'processed',
    processed_at: new Date().toISOString(),
  };
  const body = renderBody(next);
  const stringified = matter.stringify(body, next as unknown as Record<string, unknown>);
  const toPath = lintRunPath(id, 'processed');
  await mkdir(PROCESSED_DIR, { recursive: true });
  const tmp = `${toPath}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, stringified, 'utf8');
  await rename(tmp, toPath);
  try {
    await unlink(lintRunPath(id, 'completed'));
  } catch {
    // best-effort
  }
  return next;
}

// ─── Body rendering ──────────────────────────────────────────────────

function renderBody(run: LintRun): string {
  const lines: string[] = [
    `# Wiki-Lint — ${run.id}`,
    '',
    `Status: **${run.status}**  `,
    `Trigger: \`${run.trigger}\`  `,
    `Created: \`${run.created_at}\`  `,
    `Pages scanned: ${run.pages_scanned}  `,
    '',
  ];
  if (run.findings.length === 0) {
    lines.push('No lint findings.');
  } else {
    lines.push(`## Findings (${run.findings.length})`, '');
    for (const f of run.findings) {
      const badge = f.status === 'pending' ? '' : ` (${f.status})`;
      lines.push(`### #${f.id} \`${f.kind}\`${badge}`);
      lines.push('');
      lines.push(`> ${f.reason}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
