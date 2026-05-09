// Deep single-run orchestrator. Collects candidates across all wiki-
// participating agents, dispatches each to the LLM, applies the
// resulting plan to disk, then regenerates index.md and appends the
// monthly log.
//
// As of v2.2 every memory file is a 'fresh' candidate (stub-pattern
// gone). Merge-vs-promote is decided by collision-detection: try to
// promote first; if the target wiki slug already exists, re-route to
// merge in the same run. After successful action the source memory
// file is DELETED (see deep-actions.ts), keeping the memory dir as a
// clean inbox for un-consolidated knowledge.
//
// Idempotent: if a run is interrupted, the next run picks up. Wiki-
// page write goes through writeIfNotExists / writeIfMtimeUnchanged.
// Memory delete is best-effort and Deep recovers via the next run if
// it fails.
//
// See `private/dream-system-v2.md`.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

import type { Config, ResolvedModel } from '../config/types.ts';
import { resolveAnyRef } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import {
  applyMerge,
  applyPromote,
  type ActionContext,
} from './deep-actions.ts';
import { DefaultPromotionDispatcher } from './deep-dispatcher.ts';
import { regenerateIndex } from '../wiki/index-builder.ts';
import { appendLogEntries, outcomeToLogEntry, type LogEntry } from '../wiki/log-builder.ts';
import { readWithMtime } from '../wiki/conflict.ts';
import type {
  CandidateOutcome,
  PromotionCandidate,
  PromotionDispatcher,
} from '../wiki/types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? `${process.env.HOME}/.somora`;

export interface RunDreamBArgs {
  config: Config;
  /** Agents participating in the wiki (server-side opt-out via
   *  agent.yaml.rem.participate_in_wiki = false is filtered upstream). */
  agents: Array<{ name: string; vaultPath: string }>;
  dispatcher?: PromotionDispatcher;
  signal?: AbortSignal;
}

export interface RunDreamBResult {
  outcomes: CandidateOutcome[];
  candidatesSeen: number;
  durationMs: number;
}

export async function runDreamB(args: RunDreamBArgs): Promise<RunDreamBResult> {
  const start = Date.now();
  const dispatcher = args.dispatcher ?? new DefaultPromotionDispatcher();

  // Resolve worker model. Without it Deep can't run.
  const ref = args.config.wiki.deep.model;
  if (!ref) {
    logger.warn({ msg: 'dream.deep.no_worker_model_configured' });
    return { outcomes: [], candidatesSeen: 0, durationMs: Date.now() - start };
  }
  const workerModel = resolveAnyRef(args.config, ref);
  if (!workerModel) {
    logger.error({ msg: 'dream.deep.worker_model_unresolved', ref });
    return { outcomes: [], candidatesSeen: 0, durationMs: Date.now() - start };
  }

  // All wiki participants share one vault subfolder layout. We assume
  // all agents point at the same vault (the common case); if they
  // don't, each agent's wiki lives in its own vault and we run per-
  // agent with its own ActionContext.
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

  for (const [vaultPath, agentsInVault] of byVault) {
    if (args.signal?.aborted) break;
    const wikiAbs = join(vaultPath, wikiSubfolder);
    const ctx: ActionContext = { wikiAbs };

    // Build the existing-wiki summary once per vault — Deep feeds it
    // to the promotion prompt so the LLM avoids dupes.
    const wikiSummary = await summarizeWiki(wikiAbs);

    for (const agent of agentsInVault) {
      if (args.signal?.aborted) break;
      const candidates = await collectCandidates(agent.name);
      candidatesSeen += candidates.length;

      for (const c of candidates) {
        if (args.signal?.aborted) break;
        try {
          const outcome = await processCandidate({
            candidate: c,
            ctx,
            wikiSummary,
            workerModel,
            dispatcher,
            timeoutMs: 120_000,
            signal: args.signal,
          });
          allOutcomes.push(outcome);
          const logEntry = outcomeToLogEntry(outcome, Date.now());
          if (logEntry) allLogEntries.push(logEntry);
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
    }

    // Per-vault: append logs + regenerate index.
    if (allLogEntries.length > 0) {
      try {
        await appendLogEntries({ wikiAbs, entries: allLogEntries });
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
      await regenerateIndex({ wikiAbs, recentUpdates });
    } catch (err) {
      logger.error({ msg: 'dream.deep.index_regen_failed', err: (err as Error).message });
    }
  }

  return {
    outcomes: allOutcomes,
    candidatesSeen,
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

async function summarizeWiki(wikiAbs: string): Promise<string> {
  // Walks the wiki sub-folder and emits a compact text summary the
  // promote-prompt can use to avoid duplicate creation.
  try {
    const entries = await readdir(wikiAbs, { withFileTypes: true });
    const sections: string[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'logs' || e.name === 'index.md') continue;
      if (e.isDirectory()) {
        const slugs = await listSlugs(join(wikiAbs, e.name));
        if (slugs.length > 0) {
          sections.push(`${e.name}: ${slugs.join(', ')}`);
        }
      }
    }
    return sections.length > 0
      ? sections.join('\n')
      : '(no wiki pages yet — first Deep run on this vault)';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '(wiki directory does not exist yet — first Deep run will create it)';
    }
    throw err;
  }
}

async function listSlugs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      const sub = await listSlugs(join(dir, e.name));
      out.push(...sub.map((s) => `${e.name}/${s}`));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(e.name.replace(/\.md$/, ''));
    }
  }
  return out;
}

// ─── per-candidate processing ───────────────────────────────────────

async function processCandidate(args: {
  candidate: PromotionCandidate;
  ctx: ActionContext;
  wikiSummary: string;
  workerModel: ResolvedModel;
  dispatcher: PromotionDispatcher;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CandidateOutcome> {
  const { candidate, ctx, wikiSummary, workerModel, dispatcher, timeoutMs, signal } = args;

  // Step 1: ask LLM if/how to promote.
  const decision = await dispatcher.decidePromotion({
    candidate,
    existingWikiSummary: wikiSummary,
    workerModel,
    timeoutMs,
    ...(signal ? { signal } : {}),
  });
  if (decision.kind === 'skip') {
    // Memory file stays — could become substantial later. Hash-cache
    // (v2.4) avoids re-evaluating identical content on the next Deep run.
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: decision.reason,
    };
  }

  // Step 2: try to promote (creates wiki page, deletes memory file).
  const promoteResult = await applyPromote({ candidate, decision, ctx });
  if (promoteResult.kind !== 'failed') {
    return promoteResult;
  }

  // Step 3: collision — wiki page at decision.slug already exists.
  // Re-route to merge in this run instead of waiting for the next.
  const wikiPath = decision.slug;
  const wikiFileAbs = join(ctx.wikiAbs, `${wikiPath}.md`);
  const existing = await readWithMtime(wikiFileAbs);
  if (!existing) {
    // Race: file disappeared between writeIfNotExists and this read.
    // Bail — memory file stays for next run.
    return {
      kind: 'failed',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      error: `collision recovery failed: ${wikiPath} disappeared mid-run`,
    };
  }
  logger.info({
    msg: 'dream.deep.collision_reroute_to_merge',
    agent: candidate.agent,
    memorySlug: candidate.slug,
    wikiPath,
  });
  const mergeDecision = await dispatcher.decideMerge({
    candidate,
    existingWikiPage: existing.text,
    workerModel,
    timeoutMs,
    ...(signal ? { signal } : {}),
  });
  if (mergeDecision.kind === 'no_change') {
    // Observation already covered by the existing wiki page. Memory
    // file stays for next-run hash-cache check.
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: mergeDecision.reason,
    };
  }
  return applyMerge({
    candidate,
    decision: mergeDecision,
    ctx,
    wikiPath,
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
