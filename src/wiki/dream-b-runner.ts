// Dream-B single-run orchestrator. Collects candidates across all
// wiki-participating agents, dispatches each to the LLM, applies the
// resulting plan to disk, then regenerates index.md and appends the
// monthly log.
//
// Idempotent: if a run is interrupted (server crash, signal abort),
// the next run picks up where it left off — promote-then-stub is two
// file writes but each step is independently safe (writeIfNotExists
// for the wiki page, writeIfMtimeUnchanged for the stub).
//
// See `private/wiki-design.md` § "Dream-B Verhaltens-Detail".

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';

import type { Config, ResolvedModel } from '../config/types.ts';
import { resolveAnyRef } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { extractObservations, isStub, parseStub } from './templates.ts';
import {
  applyMerge,
  applyPromote,
  classifyCandidate,
  readExistingWikiPage,
  type ActionContext,
} from './dream-b-actions.ts';
import { DefaultPromotionDispatcher } from './dream-b-dispatcher.ts';
import { regenerateIndex } from './index-builder.ts';
import { appendLogEntries, outcomeToLogEntry, type LogEntry } from './log-builder.ts';
import type {
  CandidateOutcome,
  PromotionCandidate,
  PromotionDispatcher,
} from './types.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? `${process.env.HOME}/.somora`;

export interface RunDreamBArgs {
  config: Config;
  /** Agents participating in the wiki (server-side opt-out via
   *  agent.yaml.dream.participate_in_wiki = false is filtered upstream). */
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

  // Resolve worker model. Without it Dream-B can't run.
  const ref = args.config.wiki.promotion.model;
  if (!ref) {
    logger.warn({ msg: 'wiki.dream_b.no_worker_model_configured' });
    return { outcomes: [], candidatesSeen: 0, durationMs: Date.now() - start };
  }
  const workerModel = resolveAnyRef(args.config, ref);
  if (!workerModel) {
    logger.error({ msg: 'wiki.dream_b.worker_model_unresolved', ref });
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

    // Build the existing-wiki summary once per vault — Dream-B feeds it
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
            msg: 'wiki.dream_b.candidate_failed',
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
        logger.error({ msg: 'wiki.dream_b.log_append_failed', err: (err as Error).message });
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
      logger.error({ msg: 'wiki.dream_b.index_regen_failed', err: (err as Error).message });
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
      logger.warn({ msg: 'wiki.dream_b.candidate_unreadable', agent, path, err: (err as Error).message });
      continue;
    }
    const parsed = matter(raw);
    const slug = e.name.replace(/\.md$/, '');
    const fm = (parsed.data ?? {}) as Record<string, unknown>;

    if (isStub(raw)) {
      const stub = parseStub(raw);
      if (!stub) continue;
      const observations = extractObservations(stub.body);
      // Stubs without new observations are a no-op for Dream-B.
      if (observations.length === 0) continue;
      out.push({
        agent,
        slug,
        path,
        raw,
        frontmatter: fm,
        body: parsed.content,
        mtimeMs,
        kind: 'stub_with_observations',
        stub: {
          promotedTo: stub.frontmatter.promoted_to,
          promotedAt: stub.frontmatter.promoted_at,
          observations,
        },
      });
      continue;
    }

    // Fresh memory — check for marker that excludes from promotion.
    if (fm.wiki_promote === false) continue;
    out.push({
      agent,
      slug,
      path,
      raw,
      frontmatter: fm,
      body: parsed.content,
      mtimeMs,
      kind: 'fresh',
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
      : '(no wiki pages yet — first Dream-B run on this vault)';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '(wiki directory does not exist yet — first Dream-B run will create it)';
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
  const route = classifyCandidate(candidate);
  if (route === 'merge') {
    const existing = await readExistingWikiPage({ candidate, ctx });
    if (!existing) {
      // Stub points at non-existent wiki page — could be that the
      // user deleted the page intentionally. Re-promotion would
      // just re-create it. Skip, log, leave the stub for the user.
      return {
        kind: 'skipped',
        agent: candidate.agent,
        memorySlug: candidate.slug,
        reason: `stub points at missing wiki page ${candidate.stub?.promotedTo}; user-deleted? leaving stub untouched`,
      };
    }
    const decision = await dispatcher.decideMerge({
      candidate,
      existingWikiPage: existing.text,
      workerModel,
      timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (decision.kind === 'no_change') {
      return {
        kind: 'skipped',
        agent: candidate.agent,
        memorySlug: candidate.slug,
        reason: decision.reason,
      };
    }
    return applyMerge({
      candidate,
      decision,
      ctx,
      wikiPageMtimeMs: existing.mtimeMs,
    });
  }
  // promote path
  const decision = await dispatcher.decidePromotion({
    candidate,
    existingWikiSummary: wikiSummary,
    workerModel,
    timeoutMs,
    ...(signal ? { signal } : {}),
  });
  if (decision.kind === 'skip') {
    return {
      kind: 'skipped',
      agent: candidate.agent,
      memorySlug: candidate.slug,
      reason: decision.reason,
    };
  }
  return applyPromote({ candidate, decision, ctx });
}

function utcDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
