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

/** Per-turn cap on `wiki_*` tool invocations from the loop holder.
 *  Prevents the model from batch-editing multiple pages without
 *  user-by-user confirmation. Default 3 — enough for a coherent
 *  multi-step plan ("create page + link from two existing pages")
 *  that the user explicitly OK'd, small enough to force a check-in
 *  for anything bigger. The counter resets on every user turn.
 *
 *  Configurable via `wiki.lucid.maxCallsPerTurn` in config.yaml; the
 *  server applies that value once at boot via `setMaxWikiCallsPerTurn`. */
const DEFAULT_MAX_WIKI_CALLS_PER_TURN = 3;
let maxWikiCallsPerTurn = DEFAULT_MAX_WIKI_CALLS_PER_TURN;

export function setMaxWikiCallsPerTurn(cap: number): void {
  if (!Number.isFinite(cap) || cap <= 0) {
    logger.warn({
      msg: 'dream.loop.invalid_max_calls',
      cap,
      fallback: DEFAULT_MAX_WIKI_CALLS_PER_TURN,
    });
    maxWikiCallsPerTurn = DEFAULT_MAX_WIKI_CALLS_PER_TURN;
    return;
  }
  maxWikiCallsPerTurn = Math.floor(cap);
}

export function getMaxWikiCallsPerTurn(): number {
  return maxWikiCallsPerTurn;
}

/** In-memory wiki-call counter for the active turn. Module-level by
 *  design — the lifetime is one user→agent turn, no need to persist. */
let wikiCallsThisTurn = 0;

export function resetWikiCallCounter(): void {
  wikiCallsThisTurn = 0;
}

/** Increment the counter and return whether the call is permitted.
 *  When `ok: false`, the wiki tool handler rejects the call with a
 *  "one-step-at-a-time" error so the model has to come back to the
 *  user before doing more. */
export function noteWikiToolCall(): { ok: boolean; remaining: number; cap: number } {
  wikiCallsThisTurn++;
  const cap = maxWikiCallsPerTurn;
  const remaining = Math.max(0, cap - wikiCallsThisTurn);
  return {
    ok: wikiCallsThisTurn <= cap,
    remaining,
    cap,
  };
}

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
  lines.push('CONVERSATION-FIRST DISCIPLINE — read this carefully, the user has been bitten before:');
  lines.push('');
  lines.push(
    '1. ONE FINDING AT A TIME. Pick the next finding, summarize what Lucid noticed in your own words, ' +
      'propose the SPECIFIC change you would make (which page, which fields, roughly what content), ' +
      'then STOP and wait for the user to respond.',
  );
  lines.push(
    `2. Before any wiki_* tool call you must have (a) described the exact change in your most recent ` +
      `assistant message AND (b) received explicit user OK in their most recent user message for THAT ` +
      `specific change. "Mach das" / "ja" / "passt" / "go" on a concrete proposal counts. A broad ` +
      `instruction like "fix Mac Studio everywhere" does NOT — instead, list the affected pages first ` +
      `and confirm scope before any edit.`,
  );
  const cap = maxWikiCallsPerTurn;
  lines.push(
    `3. NEVER batch edits across pages without per-page confirmation. The server caps you at ${cap} ` +
      `wiki_* calls per turn as a safety net; treat that as the ceiling, not the target. If the user ` +
      `OKs a multi-step plan ("yes, edit those ${cap} pages now"), you may use up to ${cap} ` +
      `calls in this turn and then summarize what you did in your reply.`,
  );
  lines.push(
    `4. After every wiki_* call, summarize what landed and ASK the user before moving to the next ` +
      `finding. Do not preemptively work on findings the user has not addressed.`,
  );
  lines.push(
    `5. Out-of-scope pages: if the user gives a directive like "fix Mac Studio everywhere" and you spot ` +
      `pages outside the Lucid findings that match, LIST them and ask "OK to also touch these?" before ` +
      `editing — never silently extend scope.`,
  );
  lines.push(
    `6. Do NOT silently drop a finding. If the user says "skip this one" / "machen wir später", note ` +
      `that intent for the loop summary.`,
  );
  lines.push(
    `7. When all findings are addressed AND the user signals they are done ("passt", "fertig", "alles ` +
      `gut so", "schliess den loop"), call dream_review with action: "end" and a summary covering ` +
      `what happened to each finding (applied / dismissed / deferred — be explicit).`,
  );
  lines.push('');
  lines.push(
    'Loop-scoped wiki tools: wiki_edit (update body and/or related/sources frontmatter), ' +
      'wiki_create (new page), wiki_delete (remove page). Wiki edits go through mtime-aware writes; if ' +
      'a page changed on disk between read and write, the call fails and you should refetch + retry.',
  );
  lines.push('');
  lines.push(
    'Other tools you can still use during the loop: memory_search/get/list/write/edit/delete (own ' +
      'memory inbox), file_read/file_search/file_list/analyze_file (READ-ONLY filesystem — useful for ' +
      "looking up source material before proposing an edit), web_search/web_fetch (fact-check), " +
      'somora_docs_* (own documentation), time_now, dream_* (especially dream_review for the end ' +
      'call). Hidden during the loop: file_write/file_patch, exec_*, tmux_*, agents_* (spawn/ask), ' +
      'skill_*. They come back when you call dream_review action: "end".',
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
