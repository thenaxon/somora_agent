// Deep single-run orchestrator. Collects candidates across all wiki-
// participating agents, dispatches each to the LLM, applies the
// resulting decision to disk, then regenerates index.md and appends
// the monthly log.
//
// As of v2.3 there's a single LLM call per candidate (decideMemoryFate)
// that returns Skip/Promote/Merge in one shot. Wiki-context (index +
// top-N relevant pages) is loaded before the call so the LLM sees
// what's already consolidated.
//
// As of v2.2 every memory file is a 'fresh' candidate (stub-pattern
// gone). After successful action the source memory file is DELETED
// (see deep-actions.ts), keeping the memory dir as a clean inbox for
// un-consolidated knowledge.
//
// Idempotent: if a run is interrupted, the next run picks up. Wiki-
// page write goes through writeIfNotExists / writeIfMtimeUnchanged.
// Memory delete is best-effort.
//
// See `private/dream-system-v2.md`.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

import type { Config, ResolvedModel, ThinkingLevel } from '../config/types.ts';
import { resolveAnyRef } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import { logger } from '../server/logger.ts';
import {
  applyMerge,
  applyPromote,
  type ActionContext,
} from './deep-actions.ts';
import { DefaultPromotionDispatcher } from './deep-dispatcher.ts';
import { resolveWikiSchema } from '../wiki/language.ts';
import { regenerateIndex } from '../wiki/index-builder.ts';
import { appendLogEntries, outcomeToLogEntry, type LogEntry } from '../wiki/log-builder.ts';
import { readWithMtime } from '../wiki/conflict.ts';
import { loadWikiContext } from './wiki-context.ts';
import {
  clearCache,
  clearSlug,
  isCachedSkip,
  isExpiredSkip,
  loadCache,
  recordSkip,
  saveCache,
  type Cache,
} from './deep-skip-cache.ts';
import type {
  CandidateOutcome,
  PromotionCandidate,
  PromotionDispatcher,
} from '../wiki/types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? `${process.env.HOME}/.somora`;

/** Expired skip verdicts re-evaluated per agent in one run (see the
 *  cache check in runDeep). */
const MAX_EXPIRED_RECHECKS_PER_AGENT_RUN = 10;

export interface RunDreamBArgs {
  config: Config;
  /** Agents participating in the wiki (server-side opt-out via
   *  agent.yaml.rem.participate_in_wiki = false is filtered upstream). */
  agents: Array<{ name: string; vaultPath: string }>;
  /** Resolves a per-agent MemoryManager — needed for wiki-context
   *  embedding-search (index + top-N relevant pages). */
  getMemoryManager: (agent: string) => Promise<MemoryManager>;
  dispatcher?: PromotionDispatcher;
  signal?: AbortSignal;
  /** Ignore the per-agent skip-cache and re-evaluate every memory
   *  file with the LLM. Default false. Use after prompt changes or
   *  when debugging. */
  force?: boolean;
}

export interface RunDreamBResult {
  outcomes: CandidateOutcome[];
  candidatesSeen: number;
  durationMs: number;
  /** How many candidates were short-circuited via the skip-cache
   *  (no LLM call). */
  cachedSkips: number;
}

export async function runDreamB(args: RunDreamBArgs): Promise<RunDreamBResult> {
  const start = Date.now();
  const schema = resolveWikiSchema(args.config.wiki);
  const dispatcher = args.dispatcher ?? new DefaultPromotionDispatcher(schema);

  // Resolve worker model. Without it Deep can't run.
  const ref = args.config.wiki.deep.model;
  if (!ref) {
    logger.warn({ msg: 'dream.deep.no_worker_model_configured' });
    return { outcomes: [], candidatesSeen: 0, cachedSkips: 0, durationMs: Date.now() - start };
  }
  const workerModel = resolveAnyRef(args.config, ref);
  if (!workerModel) {
    logger.error({ msg: 'dream.deep.worker_model_unresolved', ref });
    return { outcomes: [], candidatesSeen: 0, cachedSkips: 0, durationMs: Date.now() - start };
  }

  const thinking = args.config.wiki.deep.thinking;
  const wikiSubfolder = args.config.wiki.vaultSubfolder;
  // Group agents by their vault path so wiki-actions get one ctx per vault.
  const byVault = new Map<string, typeof args.agents>();
  for (const a of args.agents) {
    if (!byVault.has(a.vaultPath)) byVault.set(a.vaultPath, []);
    byVault.get(a.vaultPath)!.push(a);
  }

  const allOutcomes: CandidateOutcome[] = [];
  const allLogEntries: LogEntry[] = [];
  let candidatesSeen = 0;
  let cachedSkips = 0;

  for (const [vaultPath, agentsInVault] of byVault) {
    if (args.signal?.aborted) break;
    const wikiAbs = join(vaultPath, wikiSubfolder);
    const ctx: ActionContext = { wikiAbs, mergeShrinkGuard: args.config.wiki.deep.mergeShrinkGuard, schema };

    for (const agent of agentsInVault) {
      if (args.signal?.aborted) break;
      const candidates = await collectCandidates(agent.name);
      candidatesSeen += candidates.length;
      if (candidates.length === 0) continue;

      const mgr = await args.getMemoryManager(agent.name);

      // Skip-cache: load once per agent. Empty/wiped if force=true.
      if (args.force) await clearCache(agent.name);
      const skipCache = args.force ? ({} as Cache) : await loadCache(agent.name);
      let cacheDirty = false;
      let expiredRechecks = 0;

      for (const c of candidates) {
        if (args.signal?.aborted) break;

        // Cache check before any LLM call. Hash matches → cached skip.
        const skipDays = args.config.wiki.deep.skipCacheDays ?? 30;
        let cached = isCachedSkip(skipCache, c.slug, c.body, skipDays);
        // An expired skip is looked at again — but rationed. The first
        // run after the expiry was introduced found 83 notes overdue on
        // one instance (up to 133 days old); unrationed that is 83 calls
        // to the strong model in a single run. The rest keep their
        // cached verdict and come up in the following runs.
        if (!cached) {
          const expired = isExpiredSkip(skipCache, c.slug, c.body, skipDays);
          if (expired) {
            if (expiredRechecks >= MAX_EXPIRED_RECHECKS_PER_AGENT_RUN) cached = expired;
            else expiredRechecks++;
          }
        }
        if (cached) {
          cachedSkips++;
          allOutcomes.push({
            kind: 'skipped',
            agent: c.agent,
            memorySlug: c.slug,
            reason: `[cached ${cached.skipped_at.slice(0, 10)}] ${cached.reason}`,
          });
          continue;
        }

        try {
          const outcome = await processCandidate({
            candidate: c,
            ctx,
            mgr,
            workerModel,
            dispatcher,
            timeoutMs: 120_000,
            signal: args.signal,
            ...(thinking ? { thinking } : {}),
          });
          allOutcomes.push(outcome);
          const logEntry = outcomeToLogEntry(outcome, Date.now());
          if (logEntry) allLogEntries.push(logEntry);

          // Cache update based on outcome.
          // CRITICAL: only stable skips (model-emitted skip-decisions)
          // are cacheable. Transient skips — LLM call/parse failures,
          // schema mismatches, mtime conflicts, write failures — must
          // NOT poison the cache, otherwise a one-off failure locks
          // the memory file out across all future Deep runs until the
          // user runs `force: true` (verified bug 2026-05-09).
          if (outcome.kind === 'skipped' && !outcome.transient) {
            recordSkip(skipCache, c.slug, c.body, outcome.reason);
            cacheDirty = true;
          } else if (outcome.kind === 'skipped' && outcome.transient) {
            logger.info({
              msg: 'dream.deep.skip_transient_uncached',
              agent: c.agent,
              slug: c.slug,
              reason: outcome.reason,
              hint: 'this memory file will be re-evaluated on the next Deep run',
            });
          } else if (outcome.kind === 'promoted' || outcome.kind === 'merged') {
            // Memory file just got deleted — drop any cache entry too.
            if (skipCache[c.slug]) {
              clearSlug(skipCache, c.slug);
              cacheDirty = true;
            }
          }
        } catch (err) {
          logger.error({
            msg: 'dream.deep.candidate_failed',
            agent: c.agent,
            slug: c.slug,
            err: (err as Error).message,
          });
          allOutcomes.push({
            kind: 'failed',
            agent: c.agent,
            memorySlug: c.slug,
            error: (err as Error).message,
          });
        }
      }

      if (cacheDirty) {
        await saveCache(agent.name, skipCache);
      }
    }

    // Per-vault: append logs + regenerate index.
    if (allLogEntries.length > 0) {
      try {
        await appendLogEntries({ wikiAbs, entries: allLogEntries, schema });
      } catch (err) {
        logger.error({ msg: 'dream.deep.log_append_failed', err: (err as Error).message });
      }
    }
    try {
      const recentUpdates = allLogEntries.slice(-10).map((e) => ({
        wikiPath: e.wikiPath,
        summary: e.summary,
        date: utcDate(e.ts),
      }));
      await regenerateIndex({ wikiAbs, recentUpdates, schema });
    } catch (err) {
      logger.error({ msg: 'dream.deep.index_regen_failed', err: (err as Error).message });
    }
  }

  return {
    outcomes: allOutcomes,
    candidatesSeen,
    cachedSkips,
    durationMs: Date.now() - start,
  };
}

// ─── candidate collection ───────────────────────────────────────────

async function collectCandidates(agent: string): Promise<PromotionCandidate[]> {
  const memoryRoot = join(SOMORA_HOME, 'agents', agent, 'memory');
  let entries;
  try {
    entries = await readdir(memoryRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: PromotionCandidate[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const path = join(memoryRoot, e.name);
    let raw: string;
    let mtimeMs: number;
    try {
      const buf = await readFile(path, 'utf8');
      const st = await stat(path);
      raw = buf;
      mtimeMs = st.mtimeMs;
    } catch (err) {
      logger.warn({ msg: 'dream.deep.candidate_unreadable', agent, path, err: (err as Error).message });
      continue;
    }
    const parsed = matter(raw);
    const slug = e.name.replace(/\.md$/, '');
    const fm = (parsed.data ?? {}) as Record<string, unknown>;

    // Opt-out marker: memory file with `wiki_promote: false` stays in
    // memory, never gets evaluated by Deep.
    if (fm.wiki_promote === false) continue;

    out.push({
      agent,
      slug,
      path,
      raw,
      frontmatter: fm,
      body: parsed.content,
      mtimeMs,
    });
  }
  return out;
}

// ─── per-candidate processing ───────────────────────────────────────

/** Exported for tests. */
export async function processCandidate(args: {
  candidate: PromotionCandidate;
  ctx: ActionContext;
  mgr: MemoryManager;
  workerModel: ResolvedModel;
  dispatcher: PromotionDispatcher;
  timeoutMs: number;
  signal?: AbortSignal;
  thinking?: ThinkingLevel;
}): Promise<CandidateOutcome> {
  const { candidate, ctx, mgr, workerModel, dispatcher, timeoutMs, signal, thinking } = args;

  // 1. Load wiki context: index + top-N relevant pages.
  const wikiCtx = await loadWikiContext({
    mgr,
    query: candidate.body,
    wikiAbs: ctx.wikiAbs,
  });

  // 2. Single LLM call: skip / promote / merge.
  const decision = await dispatcher.decideMemoryFate({
    candidate,
    wikiIndex: wikiCtx.indexSummary,
    relevantPages: wikiCtx.relevantPages.map((p) => ({
      slug: p.slug,
      markdown: p.markdown,
    })),
    workerModel,
    timeoutMs,
    ...(signal ? { signal } : {}),
    ...(thinking ? { thinking } : {}),
  });

  if (decision.kind === 'skip') {
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: decision.reason,
      ...(decision.transient ? { transient: true as const } : {}),
    };
  }

  if (decision.kind === 'promote') {
    const promoteResult = await applyPromote({ candidate, decision, ctx });
    if (promoteResult.kind !== 'failed') return promoteResult;
    // Collision (LLM picked a slug that already exists despite our
    // wiki-context). Fall back to merge with the existing page.
    return await mergeCollidingPage({
      candidate,
      ctx,
      mgr,
      workerModel,
      dispatcher,
      wikiPath: decision.slug,
      timeoutMs,
      ...(signal ? { signal } : {}),
      ...(thinking ? { thinking } : {}),
    });
  }

  // decision.kind === 'merge'
  //
  // A merge REPLACES the page body with what the model wrote. That is
  // only safe when the model saw the whole, current page:
  //  - loaded in full → write against the mtime captured when the page
  //    was READ for the prompt. (It used to be read again here, after
  //    the LLM call — an edit made during those up-to-120s looked
  //    "unchanged" and was overwritten.)
  //  - loaded shortened (pages over 8000 chars arrive cut to 6000), or
  //    not loaded at all (the model picked it from index.md alone) →
  //    the body it returned is built on a page it has not read. Ask
  //    again with that one page in full. Live logs to 2026-09-21: 207
  //    of 208 shrink-guard trips were on such pages, e.g. a 22788-char
  //    page "rewritten" as 6 chars, 132 times over.
  const target = normalizeWikiPath(decision.wikiPath);
  const loaded = wikiCtx.relevantPages.find((p) => normalizeWikiPath(p.slug) === target);
  if (loaded && !loaded.truncated) {
    return applyMerge({
      candidate,
      decision,
      ctx,
      wikiPageMtimeMs: loaded.mtimeMs,
    });
  }
  return await mergeCollidingPage({
    candidate,
    ctx,
    mgr,
    workerModel,
    dispatcher,
    wikiPath: decision.wikiPath,
    why: loaded ? 'target was only seen shortened' : 'target was not in the loaded context',
    timeoutMs,
    ...(signal ? { signal } : {}),
    ...(thinking ? { thinking } : {}),
  });
}

function normalizeWikiPath(p: string): string {
  return p.replace(/^\/+/, '').replace(/\.md$/i, '');
}

/** Ask the LLM again with exactly one page — in full, mtime captured
 *  before the call — and merge into it. Used when promote collided
 *  with an existing slug, and when a merge targeted a page the model
 *  had not fully seen. */
async function mergeCollidingPage(args: {
  candidate: PromotionCandidate;
  ctx: ActionContext;
  mgr: MemoryManager;
  workerModel: ResolvedModel;
  dispatcher: PromotionDispatcher;
  wikiPath: string;
  /** For the log. Default: promote collided with an existing slug. */
  why?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  thinking?: ThinkingLevel;
}): Promise<CandidateOutcome> {
  const { candidate, ctx, mgr, workerModel, dispatcher, wikiPath, timeoutMs, signal, thinking } = args;
  const wikiFileAbs = join(ctx.wikiAbs, `${wikiPath}.md`);
  const existing = await readWithMtime(wikiFileAbs);
  if (!existing) {
    return {
      kind: 'failed',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      error: args.why
        ? `LLM merge target ${wikiPath} does not exist`
        : `collision recovery failed: ${wikiPath} disappeared mid-run`,
    };
  }
  logger.info({
    msg: args.why ? 'dream.deep.merge_reask_full_page' : 'dream.deep.collision_reroute_to_merge',
    agent: candidate.agent,
    memorySlug: candidate.slug,
    wikiPath,
    ...(args.why ? { why: args.why, pageChars: existing.text.length } : {}),
  });

  // Re-call the LLM with the existing page now in the relevantPages
  // context, asking it to merge.
  const decision = await dispatcher.decideMemoryFate({
    candidate,
    wikiIndex: args.why
      ? '(single page focus — this is the complete current page, integrate into it)'
      : '(collision recovery — single page focus)',
    relevantPages: [{ slug: wikiPath, markdown: existing.text }],
    workerModel,
    timeoutMs,
    ...(signal ? { signal } : {}),
    ...(thinking ? { thinking } : {}),
  });

  if (decision.kind === 'skip') {
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: decision.reason,
      ...(decision.transient ? { transient: true as const } : {}),
    };
  }
  if (decision.kind !== 'merge') {
    return {
      kind: 'failed',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      error: `collision recovery: LLM returned ${decision.kind} instead of merge`,
    };
  }
  return applyMerge({
    candidate,
    decision,
    ctx,
    wikiPageMtimeMs: existing.mtimeMs,
  });
}

function utcDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
