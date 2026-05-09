// Lucid review-loop state. Server-global lock that pins ONE agent into
// the wiki-edit conversation for ONE Lucid run at a time.
//
// Persistent in `~/.somora/wiki-lucid/loop-state.json` so a server
// restart while the user is mid-review doesn't lose the loop.
//
// Read on every chat turn:
//  - run-turn injects a "<wiki-review-mode>" briefing into the
//    ephemeral context if the calling agent holds the loop.
//  - the tool registry exposes wiki_* tools to the holder and hides
//    file_* / exec_* / tmux_* / agents_* / skill_* during the loop
//    so the holder stays focused on wiki work.
//
// Auto-expiry: a loop with no chat activity for IDLE_TIMEOUT_MS gets
// considered stale on the next read; the reader clears it. Prevents
// "agent forgot to call dream_review({action:'end'})" from locking
// the wiki forever.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { logger } from '../server/logger.ts';
import { readLucidRunById } from './lucid-storage.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? `${process.env.HOME}/.somora`;
const LOOP_STATE_PATH = join(SOMORA_HOME, 'wiki-lucid', 'loop-state.json');

/** Idle timeout — if `lastActivityAt` is older than this when we read,
 *  the loop is considered stale and gets cleared. 24h. */
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface LoopState {
  /** Agent holding the review loop (somora-instance-global, not per-agent). */
  agent: string;
  /** Lucid run id under review. */
  dreamId: string;
  /** ISO timestamp when start was called. */
  startedAt: string;
  /** ISO timestamp of last loop-related activity (start, agent turn, tool
   *  call from the holder). Used by the idle-timeout guard. */
  lastActivityAt: string;
}

function ensureDir(): void {
  try {
    mkdirSync(dirname(LOOP_STATE_PATH), { recursive: true });
  } catch (err) {
    // mkdir -p semantics — EEXIST is fine.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
  }
}

/** Read current loop state. Returns null when no loop is active OR
 *  when the file is older than IDLE_TIMEOUT_MS (auto-expiry). The
 *  expiry path also clears the file as a side effect. */
export function getLoopState(): LoopState | null {
  let raw: string;
  try {
    raw = readFileSync(LOOP_STATE_PATH, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ msg: 'dream.loop.state_parse_failed', err: (err as Error).message });
    clearLoopState();
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const s = parsed as Record<string, unknown>;
  const agent = typeof s.agent === 'string' ? s.agent : '';
  const dreamId = typeof s.dreamId === 'string' ? s.dreamId : '';
  const startedAt = typeof s.startedAt === 'string' ? s.startedAt : '';
  const lastActivityAt = typeof s.lastActivityAt === 'string' ? s.lastActivityAt : '';
  if (!agent || !dreamId || !startedAt || !lastActivityAt) return null;
  const ageMs = Date.now() - new Date(lastActivityAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > IDLE_TIMEOUT_MS) {
    logger.info({
      msg: 'dream.loop.expired',
      agent,
      dreamId,
      ageMs,
      hint: 'no activity for 24h — auto-cleared',
    });
    clearLoopState();
    return null;
  }
  return { agent, dreamId, startedAt, lastActivityAt };
}

/** Replace loop state. Caller is responsible for the lock-or-fail
 *  semantics — the registry-level `dream_review` tool checks
 *  `getLoopState()` before calling this so the second concurrent
 *  start gets a clean error. */
export function setLoopState(state: LoopState): void {
  ensureDir();
  writeFileSync(LOOP_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/** Bump `lastActivityAt` to now. Called on each turn from the loop
 *  holder so the 24h idle clock resets while the conversation is
 *  active. No-op when no loop is active. */
export function refreshLoopActivity(agent: string): void {
  const state = getLoopState();
  if (!state) return;
  if (state.agent !== agent) return;
  state.lastActivityAt = new Date().toISOString();
  setLoopState(state);
}

export function clearLoopState(): void {
  try {
    unlinkSync(LOOP_STATE_PATH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

export function isLoopHolder(agent: string): boolean {
  const state = getLoopState();
  return !!state && state.agent === agent;
}

/**
 * Build the system-prompt-injection block for a loop holder. Loaded
 * from disk on every turn so edits to the Lucid run (e.g. user
 * dismissed a finding via dream_dismiss between turns) reflect
 * immediately. Returns null when the agent isn't holding the loop or
 * the run can't be loaded.
 */
export async function buildReviewLoopBlock(agent: string): Promise<string | null> {
  const state = getLoopState();
  if (!state || state.agent !== agent) return null;
  const run = await readLucidRunById(state.dreamId);
  if (!run) {
    logger.warn({
      msg: 'dream.loop.run_missing',
      agent,
      dreamId: state.dreamId,
      hint: 'review-loop is active but the underlying Lucid run was not found',
    });
    return [
      '<wiki-review-mode>',
      `You are in an active wiki review loop for Lucid run ${state.dreamId}, but the run file could not be loaded.`,
      'Call dream_review with action: "end" and a brief summary to exit the loop, then ask the user how to proceed.',
      '</wiki-review-mode>',
    ].join('\n');
  }
  const open = run.findings.filter((f) => f.status === 'pending');
  const totalCount = run.findings.length;
  const lines: string[] = [];
  lines.push('<wiki-review-mode>');
  lines.push(
    `You are in an active wiki review loop for Lucid run ${state.dreamId} (started ${state.startedAt}).`,
  );
  lines.push('');
  lines.push('Your job during this loop:');
  lines.push(
    '- Walk the user through each pending finding below. State what Lucid noticed, then DISCUSS — do not auto-apply.',
  );
  lines.push(
    '- Take the user\'s direction as authority: they may broaden the change, redirect to other pages, or skip a finding.',
  );
  lines.push(
    '- Use the loop-scoped wiki tools to write changes: wiki_edit (overwrite body), wiki_create (new page), wiki_delete (remove page).',
  );
  lines.push(
    '- Do NOT silently drop a finding. If the user says "skip this one", note that intent for the loop summary.',
  );
  lines.push(
    '- When all findings are addressed AND the user signals they are done ("passt", "fertig", "alles gut so"), call dream_review with action: "end" and a summary covering what happened to each finding.',
  );
  lines.push('');
  lines.push(`Findings (${open.length} pending of ${totalCount} total):`);
  if (open.length === 0) {
    lines.push('- (no pending findings — propose ending the loop unless the user has more wiki edits in mind)');
  } else {
    for (const f of open) {
      const pages = f.affected_pages.length > 0 ? f.affected_pages.join(', ') : '(no specific pages)';
      lines.push(`- [#${f.id}] ${f.kind} on ${pages}`);
      lines.push(`    reason: ${f.reason}`);
    }
  }
  lines.push('');
  lines.push(
    'Toolset constraint while this loop is active: file_*, exec_*, agents_*, skill_*, tmux_* are all hidden so you stay focused. Use wiki_* for wiki edits and memory_* for personal notes only.',
  );
  lines.push('</wiki-review-mode>');
  return lines.join('\n');
}
