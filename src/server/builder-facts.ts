// The facts under a builder's report (docs/builder.md "What somora adds
// to the report"). A report is the builder's account; these lines come
// from somora's own look at the folder and its records, so the orderer
// sees what the builder's prose may leave out:
//
//   - changes not committed, and files git does not track, in the
//     working copy and in every worktree of the repository;
//   - commits on a worktree's branch that the main checkout does not
//     have (tested in a worktree is not integrated);
//   - commands that timed out in this turn;
//   - background jobs this session started in this turn that still run.
//
// Reports from orderers (2026-10-28/29) showed each of these: UI files
// tested in a worktree but never committed, a promised ledger left
// untracked in a worktree, a backend fix merged while the old process
// kept running. Other harnesses build such a block from their own
// records rather than from the model's text (Codewhale's receipts,
// Hermes' footer for failed writes). Nothing here commits, cleans or
// stops anything; it only reports.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { listJobsForAgent, probeLocalJob } from '../tools/exec/job-store.ts';
import { buildSpawnEnv } from '../tools/exec/local.ts';
import { timeoutsSince } from '../tools/exec/timeout-repeats.ts';

const pexec = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
/** All git calls of one report together; worktrees run in parallel. */
const GIT_BUDGET_MS = 8_000;
const MAX_WORKTREES = 6;
const MAX_PATHS = 8;

export const FACTS_HEADING = '## State of the working copy (from somora, not from the builder)';

// The repository is the builder's: nothing in its config may make the
// server run a command. git status runs core.fsmonitor and the clean
// filter of every filter.<name> that .gitattributes selects; both are
// switched off for these calls (a filter as `cat`, i.e. the file as it
// is). The calls get the environment exec gives the builder, without
// somora's own variables, and do not take index.lock from a git job
// still running.
const SAFE_GIT = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks'];
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...buildSpawnEnv(undefined, { stripSomoraInternal: true }),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
});

async function run(cwd: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await pexec('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: gitEnv(),
      ...(signal ? { signal } : {}),
    });
    return r.stdout;
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[], signal?: AbortSignal, extra: string[] = []): Promise<string | null> {
  return run(cwd, [...SAFE_GIT, ...extra, ...args], signal);
}

/** -c overrides that make every configured filter a no-op. Reading the
 *  config runs nothing. */
async function filterOverrides(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(cwd, ['config', '--name-only', '--get-regexp', '^filter\\.'], signal);
  const names = new Set<string>();
  for (const line of (out ?? '').split('\n')) {
    const m = /^filter\.(.+)\.[^.]+$/.exec(line.trim());
    if (m) names.add(m[1]!);
  }
  return [...names].flatMap((n) => ['-c', `filter.${n}.clean=cat`, '-c', `filter.${n}.smudge=cat`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

interface Worktree {
  path: string;
  branch?: string;
  head?: string;
}

function parseWorktrees(out: string): Worktree[] {
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9) };
      list.push(cur);
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    }
  }
  return list;
}

export interface WorktreeFacts {
  path: string;
  branch?: string;
  main: boolean;
  /** git status gave no answer (timeout, too much output, an error):
   *  nothing is known about this worktree, it is not clean. */
  unknown?: boolean;
  changed: string[];
  untracked: string[];
  /** Commits on this branch the main checkout's HEAD does not have. */
  notInMain?: number;
}

export interface GitFacts {
  worktrees: WorktreeFacts[];
  /** Worktrees beyond the limit that were not looked at. */
  notChecked: number;
}

/** What git says about the folder's repository; null outside a repository.
 *  The folder's own checkout and the main checkout are always looked at,
 *  then other worktrees up to the limit. */
export async function gitFacts(workdir: string, signal?: AbortSignal): Promise<GitFacts | null> {
  const top = (await git(workdir, ['rev-parse', '--show-toplevel'], signal))?.trim();
  if (!top) return null;
  const listed = await git(top, ['worktree', 'list', '--porcelain'], signal);
  const all = listed ? parseWorktrees(listed) : [{ path: top }];
  const mainPath = all[0]?.path ?? top;
  const first = all.filter((w) => w.path === mainPath || w.path === top);
  const rest = all.filter((w) => w.path !== mainPath && w.path !== top);
  const chosen = [...first, ...rest.slice(0, Math.max(0, MAX_WORKTREES - first.length))];
  const nested = all.filter((w) => w.path !== mainPath && w.path.startsWith(`${mainPath}/`)).map((w) => `${w.path.slice(mainPath.length + 1)}/`);
  const one = async (wt: Worktree): Promise<WorktreeFacts | null> => {
    if (!existsSync(wt.path)) return null;
    const main = wt.path === mainPath;
    const base = { path: wt.path, ...(wt.branch ? { branch: wt.branch } : {}), main };
    const filters = await filterOverrides(wt.path, signal);
    // A detached worktree has no branch: its commit counts the same way.
    const tip = wt.branch ?? wt.head;
    const [status, ahead] = await Promise.all([
      // Submodules are not entered: their own config (filters) would run
      // there. A changed submodule commit still shows in the parent.
      git(wt.path, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=dirty'], signal, filters),
      !main && tip ? git(mainPath, ['rev-list', '--count', `HEAD..${tip}`], signal) : Promise.resolve(null),
    ]);
    if (status === null) return { ...base, unknown: true, changed: [], untracked: [] };
    const changed: string[] = [];
    const untracked: string[] = [];
    for (const line of status.split('\n')) {
      if (!line.trim()) continue;
      const file = line.slice(3);
      if (line.startsWith('??')) untracked.push(file);
      else changed.push(file);
    }
    // A worktree inside the main checkout shows there as one untracked
    // folder; it is reported on its own line instead.
    const shown = main ? untracked.filter((u) => !nested.some((n) => u === n || u.startsWith(n))) : untracked;
    const n = Number(ahead?.trim());
    return { ...base, changed, untracked: shown, ...(ahead !== null && Number.isFinite(n) ? { notInMain: n } : {}) };
  };
  const results = await Promise.all(chosen.map(one));
  return { worktrees: results.filter((r): r is WorktreeFacts => r !== null), notChecked: all.length - chosen.length };
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_PATHS).map((p) => `\`${p}\``).join(', ');
  return paths.length > MAX_PATHS ? `${shown}, … (${paths.length} in all)` : shown;
}

/** The block's lines for git; empty when everything looked at is committed. */
export function renderGitFacts(facts: WorktreeFacts[]): string[] {
  const lines: string[] = [];
  for (const f of facts) {
    const where = f.main ? `Working copy \`${f.path}\`` : `Worktree \`${f.path}\``;
    const branch = f.branch ? ` (branch \`${f.branch}\`)` : '';
    const parts: string[] = [];
    if (f.unknown) parts.push('git status did not answer — state unknown');
    if (f.changed.length > 0) parts.push(`${f.changed.length} changed, not committed: ${listPaths(f.changed)}`);
    if (f.untracked.length > 0) parts.push(`${f.untracked.length} not tracked by git: ${listPaths(f.untracked)}`);
    if (f.notInMain && f.notInMain > 0) parts.push(`${f.notInMain} commit(s) not in the main checkout`);
    if (parts.length > 0) lines.push(`- ${where}${branch}: ${parts.join('; ')}.`);
  }
  return lines;
}

/** The whole block, or null when the folder is not a repository and
 *  nothing timed out or still runs. */
export async function collectBuilderFacts(a: {
  agent: string;
  session: string;
  workdir: string;
  /** When the order's turn started. */
  since: number;
  /** Leave out "everything is committed" (a turn that only answered a
   *  question): the block then appears only when something is open. */
  quietWhenClean?: boolean;
  /** The order's stop signal: Stop ends the git calls too. */
  signal?: AbortSignal;
}): Promise<string | null> {
  const lines: string[] = [];
  const budget = AbortSignal.timeout(GIT_BUDGET_MS);
  const signal = a.signal ? AbortSignal.any([a.signal, budget]) : budget;
  const facts = await gitFacts(a.workdir, signal);
  if (facts) {
    const gitLines = renderGitFacts(facts.worktrees);
    lines.push(...gitLines);
    if (facts.notChecked > 0) lines.push(`- ${facts.notChecked} more worktree(s) not looked at: their state is unknown.`);
    else if (gitLines.length === 0 && !a.quietWhenClean) {
      lines.push(`- Everything in \`${a.workdir}\`${facts.worktrees.length > 1 ? ' and its worktrees' : ''} is committed.`);
    }
  }
  const timeouts = await timeoutsSince(a.agent, a.session, a.since).catch(() => []);
  for (const t of timeouts.slice(0, 5)) {
    lines.push(`- Timed out ${t.count}× in this session (${Math.round(t.totalMs / 1000)}s in all): \`${t.command.slice(0, 160)}\`.`);
  }
  const jobs = await listJobsForAgent(a.agent).catch(() => []);
  for (const job of jobs.filter((j) => j.state === 'running' && j.session === a.session && j.started_at >= a.since && j.target === 'local').slice(0, 5)) {
    const live = await probeLocalJob(a.agent, job).catch(() => job);
    if (live.state === 'running') lines.push(`- Still running in the background: \`${job.command.slice(0, 160)}\` (job ${job.job_id}).`);
  }
  if (lines.length === 0) return null;
  return `${FACTS_HEADING}\n\n${lines.join('\n')}`;
}
