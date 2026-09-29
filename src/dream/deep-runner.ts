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
import { buildWikiMap, checkPromoteTarget, noteNewPage, syncStructureWithMap, type WikiMap } from '../wiki/map.ts';
import { describeFolder, loadStructureFile, noteDuplicate, saveStructureFile, type StructureFile } from '../wiki/structure-file.ts';
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
    const ctx: ActionContext = { wikiAbs, mergeShrinkGuard: args.config.wiki.deep.mergeShrinkGuard, schema, maxPageChars: args.config.wiki.deep.maxPageChars };
    // The map Deep files against: once per vault and run, kept current
    // in memory as pages are created; the structure file is written
    // back at the end when a folder was described or a twin was noted.
    const wiki = await loadDeepWikiState(wikiAbs, schema.language);

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
            wiki,
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

    // Per-vault: structure file, append logs + regenerate index.
    if (wiki.dirty) {
      try {
        await saveStructureFile(wikiAbs, wiki.structure);
        logger.info({ msg: 'dream.deep.structure_file_saved', wikiAbs, folders: wiki.structure.folders.length, duplicates: wiki.structure.duplicates.length });
      } catch (err) {
        logger.error({ msg: 'dream.deep.structure_file_save_failed', err: (err as Error).message });
      }
    }
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
    const parsed = parseMemoryNote(raw, path);
    const slug = e.name.replace(/\.md$/, '');
    const fm = parsed.data;

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

// ─── the wiki map for a run ─────────────────────────────────────────

/** What Deep files against during one run on one vault (see
 *  src/wiki/map.ts): the map, the structure file, and whether the
 *  latter must be written back. */
export interface DeepWikiState {
  map: WikiMap;
  structure: StructureFile;
  dirty: boolean;
}

/** Exported for tests. Reads the structure file, walks the wiki, and
 *  records folders on disk the structure file does not know yet. */
export async function loadDeepWikiState(wikiAbs: string, language: StructureFile['language']): Promise<DeepWikiState> {
  const structure = await loadStructureFile(wikiAbs, language);
  const map = await buildWikiMap({ wikiAbs, language, structure });
  const dirty = syncStructureWithMap(structure, map, (e) => describeFolder(structure, e));
  logger.info({
    msg: 'dream.deep.wiki_map_built',
    wikiAbs,
    folders: map.folders.length,
    undescribed: map.folders.filter((f) => !f.purpose).length,
    planned: map.planned.length,
    twins: [...map.sameName.values()].filter((v) => v.length > 1).length,
  });
  return { map, structure, dirty };
}

/**
 * A memory note's frontmatter and body, tolerant of a header the YAML
 * parser rejects (2026-09-29, a note on a second installation failed
 * every Deep run for weeks with "end of the stream or a document
 * separator is expected"): the first `---` block is read with the
 * strict parser, then leniently line by line (`key: value` only), and
 * as a last resort the note goes to the model with an empty header and
 * its full text — Deep then promotes or skips it like any other, which
 * is how the note heals. Exported for tests.
 */
export function parseMemoryNote(raw: string, path: string): { data: Record<string, unknown>; content: string } {
  try {
    const parsed = matter(raw);
    return { data: (parsed.data ?? {}) as Record<string, unknown>, content: parsed.content };
  } catch (err) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    const data: Record<string, unknown> = {};
    let content = raw;
    if (m) {
      content = raw.slice(m[0].length);
      for (const line of m[1]!.split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (kv && kv[2] && !/^[>|]/.test(kv[2])) data[kv[1]!] = kv[2].replace(/^['"]|['"]$/g, '');
      }
    }
    logger.warn({ msg: 'dream.deep.frontmatter_unreadable', path, err: (err as Error).message.split('\n')[0], keptKeys: Object.keys(data), hint: 'note is processed with a lenient header' });
    return { data, content };
  }
}

// ─── per-candidate processing ───────────────────────────────────────

/** Exported for tests. */
export async function processCandidate(args: {
  candidate: PromotionCandidate;
  ctx: ActionContext;
  mgr: MemoryManager;
  workerModel: ResolvedModel;
  dispatcher: PromotionDispatcher;
  /** The run's map; built on the spot when a caller (tests) has none. */
  wiki?: DeepWikiState;
  timeoutMs: number;
  signal?: AbortSignal;
  thinking?: ThinkingLevel;
}): Promise<CandidateOutcome> {
  const { candidate, ctx, mgr, workerModel, dispatcher, timeoutMs, signal, thinking } = args;
  const wiki = args.wiki ?? (await loadDeepWikiState(ctx.wikiAbs, ctx.schema?.language ?? 'de'));

  // 1. Load wiki context: top-N relevant pages.
  const wikiCtx = await loadWikiContext({
    mgr,
    query: candidate.body,
    wikiAbs: ctx.wikiAbs,
  });

  // 2. Single LLM call: skip / promote / merge.
  const decision = await dispatcher.decideMemoryFate({
    candidate,
    wikiMap: wiki.map.text,
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
    // Where the page would land, checked against the whole wiki — not
    // only the exact path (2026-09-29: `hardware` and `homelab` folders
    // reinvented, 15 page names living in several folders at once).
    let check = checkPromoteTarget(wiki.map, decision);
    if (check.kind === 'subTopic') {
      // Ask once more with the entity page in full: merge as a detail
      // of it, or — when it really is a thing of its own — promote.
      const entity = await readWithMtime(join(ctx.wikiAbs, `${check.target}.md`));
      if (entity) {
        logger.info({ msg: 'dream.deep.sub_topic_reask', agent: candidate.agent, memorySlug: candidate.slug, wanted: decision.slug, entity: check.target, prefix: check.prefix });
        const again = await dispatcher.decideMemoryFate({
          candidate,
          wikiMap: `${wiki.map.text}\n\nNOTE: the page you wanted to create, ${decision.slug}, is named after the existing entity page ${check.target} (shown below in full). A detail, decision, event or status of that entity belongs INTO its page — answer "merge" with the full updated body (add it to the timeline or the fitting section). Answer "promote" again only when this is a thing of its own that merely shares the name.`,
          relevantPages: [{ slug: check.target, markdown: entity.text }],
          workerModel,
          timeoutMs,
          ...(signal ? { signal } : {}),
          ...(thinking ? { thinking } : {}),
        });
        if (again.kind === 'skip') {
          return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: again.reason, ...(again.transient ? { transient: true as const } : {}) };
        }
        if (again.kind === 'merge') {
          if (ctx.maxPageChars && entity.text.length > ctx.maxPageChars) {
            return subPageInstead({ candidate, ctx, workerModel, dispatcher, wiki, target: check.target, targetText: entity.text, timeoutMs, ...(signal ? { signal } : {}), ...(thinking ? { thinking } : {}) });
          }
          return applyMerge({ candidate, decision: { ...again, wikiPath: check.target }, ctx, wikiPageMtimeMs: entity.mtimeMs });
        }
        // The model insists on a page of its own: take its second
        // answer through the ordinary checks, sub-topic excluded.
        const second = checkPromoteTarget(wiki.map, again, { ignoreSubTopic: true });
        if (second.kind === 'ok') {
          const r = await applyPromote({ candidate, decision: again, ctx });
          if (r.kind === 'promoted') {
            if (second.describe && describeFolder(wiki.structure, second.describe)) wiki.dirty = true;
            noteNewPage(wiki.map, r.wikiPath, second.describe);
            logger.info({ msg: 'dream.deep.sub_topic_kept_own_page', agent: candidate.agent, memorySlug: candidate.slug, wikiPath: r.wikiPath, entity: check.target });
          }
          return r;
        }
        return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: `refused after sub-topic re-ask: ${second.kind}`, transient: true };
      }
      // The entity page vanished mid-run: judge the target without it.
      check = checkPromoteTarget(wiki.map, decision, { ignoreSubTopic: true });
    }
    if (check.kind === 'sameName') {
      if (check.others.length > 0 && noteDuplicate(wiki.structure, decision.slug.split('/').pop()!, [check.target, ...check.others])) wiki.dirty = true;
      logger.info({
        msg: 'dream.deep.same_name_reroute_to_merge',
        agent: candidate.agent,
        memorySlug: candidate.slug,
        wanted: decision.slug,
        existing: check.target,
        ...(check.others.length > 0 ? { alsoAt: check.others } : {}),
      });
      return await mergeCollidingPage({
        candidate,
        ctx,
        mgr,
        workerModel,
        dispatcher,
        wiki,
        wikiPath: check.target,
        why: `a page named like ${decision.slug} already exists at ${check.target}`,
        timeoutMs,
        ...(signal ? { signal } : {}),
        ...(thinking ? { thinking } : {}),
      });
    }
    if (check.kind === 'unknownFolder' || check.kind === 'tooDeep') {
      logger.warn({
        msg: check.kind === 'tooDeep' ? 'dream.deep.promote_folder_too_deep' : 'dream.deep.promote_folder_without_purpose',
        agent: candidate.agent,
        memorySlug: candidate.slug,
        wanted: decision.slug,
        folder: check.folder,
        ...(decision.newFolder ? { newFolder: decision.newFolder } : {}),
      });
      return {
        kind: 'skipped',
        agent: candidate.agent,
        memorySlug: candidate.slug,
        reason: check.kind === 'tooDeep'
          ? `refused: ${check.folder} is deeper than one subfolder level`
          : `refused: ${check.folder} is not a folder of this wiki and no purpose was given for it`,
        transient: true,
      };
    }
    if (check.kind !== 'ok') {
      // Only reachable when the sub-topic re-check found a twin — rare
      // enough to leave for the next run.
      return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: `refused: ${check.kind} after re-check`, transient: true };
    }
    const promoteResult = await applyPromote({ candidate, decision, ctx });
    if (promoteResult.kind === 'promoted') {
      if (check.describe && describeFolder(wiki.structure, check.describe)) wiki.dirty = true;
      noteNewPage(wiki.map, promoteResult.wikiPath, check.describe);
      if (check.describe) {
        logger.info({ msg: 'dream.deep.folder_described', folder: check.describe.path, origin: check.describe.origin, purpose: check.describe.purpose });
      }
      return promoteResult;
    }
    if (promoteResult.kind !== 'failed') return promoteResult;
    // Collision (LLM picked a slug that already exists despite our
    // wiki-context). Fall back to merge with the existing page.
    return await mergeCollidingPage({
      candidate,
      ctx,
      mgr,
      workerModel,
      dispatcher,
      wiki,
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
  const tooBig = await pageTooBig(ctx, target);
  if (tooBig) {
    return subPageInstead({ candidate, ctx, workerModel, dispatcher, wiki, target, targetText: tooBig.text, timeoutMs, ...(signal ? { signal } : {}), ...(thinking ? { thinking } : {}) });
  }
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
    wiki,
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

/** The page's text when it is over `maxPageChars`, else null. */
async function pageTooBig(ctx: ActionContext, wikiPath: string): Promise<{ text: string } | null> {
  if (!ctx.maxPageChars) return null;
  const page = await readWithMtime(join(ctx.wikiAbs, `${wikiPath}.md`));
  if (!page || page.text.length <= ctx.maxPageChars) return null;
  return { text: page.text };
}

/**
 * The size guard (Rene, 2026-09-29: "so große Seiten sollten nie
 * entstehen"). A page over `wiki.deep.maxPageChars` takes no more
 * content: Deep is asked once more to write the note as a SUB-PAGE
 * under the page — `<page>/<sub-topic>` with its own current state and
 * timeline — and the folder `<page>/` is described in the structure
 * file the first time. A model that still answers merge leaves the
 * note for the next run.
 */
async function subPageInstead(args: {
  candidate: PromotionCandidate;
  ctx: ActionContext;
  workerModel: ResolvedModel;
  dispatcher: PromotionDispatcher;
  wiki: DeepWikiState;
  target: string;
  targetText: string;
  timeoutMs: number;
  signal?: AbortSignal;
  thinking?: ThinkingLevel;
}): Promise<CandidateOutcome> {
  const { candidate, ctx, workerModel, dispatcher, wiki, target, timeoutMs, signal, thinking } = args;
  const kb = Math.round(args.targetText.length / 1024);
  const existingSubs = wiki.map.folders.find((f) => f.path === target);
  logger.info({ msg: 'dream.deep.sub_page_instead', agent: candidate.agent, memorySlug: candidate.slug, target, kb, limitKb: Math.round((ctx.maxPageChars ?? 0) / 1024), subPages: existingSubs?.pages ?? 0 });
  const head = args.targetText.slice(0, 6000);
  const decision = await dispatcher.decideMemoryFate({
    candidate,
    wikiMap: `${wiki.map.text}

NOTE: the page ${target} is ${kb} KB and takes no more content (limit ${Math.round((ctx.maxPageChars ?? 0) / 1024)} KB). Write this note as a SUB-PAGE under it instead: answer "promote" with "subfolder": "${target}" and a slug "${target}/<sub-topic>" — the sub-topic this note is about (a component, a phase, a device, a decision), with its own current state and timeline. Reuse an existing sub-page name when the map lists one under ${target}/ that fits (then answer "merge" into THAT sub-page). Only the opening of ${target} is shown below.`,
    relevantPages: [{ slug: target, markdown: head }, ...wiki.map.folders.filter((f) => f.path === target).length ? [] : []],
    workerModel,
    timeoutMs,
    ...(signal ? { signal } : {}),
    ...(thinking ? { thinking } : {}),
  });
  if (decision.kind === 'skip') {
    return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: decision.reason, ...(decision.transient ? { transient: true as const } : {}) };
  }
  if (decision.kind === 'merge') {
    const sub = normalizeWikiPath(decision.wikiPath);
    if (sub.startsWith(target + '/')) {
      const page = await readWithMtime(join(ctx.wikiAbs, `${sub}.md`));
      if (page && page.text.length <= (ctx.maxPageChars ?? Infinity)) return applyMerge({ candidate, decision: { ...decision, wikiPath: sub }, ctx, wikiPageMtimeMs: page.mtimeMs });
    }
    return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: `refused: ${target} is over the size limit (${kb} KB) and the model still wanted to merge into ${sub}`, transient: true };
  }
  const slug = normalizeWikiPath(decision.slug);
  if (!slug.startsWith(target + '/') || slug.split('/').length !== target.split('/').length + 1) {
    return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: `refused: sub-page expected under ${target}/, got ${slug}`, transient: true };
  }
  const check = checkPromoteTarget(wiki.map, { ...decision, slug, subfolder: target, newFolder: { path: target, purpose: `Unterseiten von ${target.split('/').pop()}: Teilthemen mit eigener Zeitleiste` } }, { ignoreSubTopic: true });
  if (check.kind === 'sameName') {
    return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: `refused: a page named like ${slug} exists at ${check.target}`, transient: true };
  }
  if (check.kind !== 'ok') {
    return { kind: 'skipped', agent: candidate.agent, memorySlug: candidate.slug, reason: `refused: ${check.kind} for ${slug}`, transient: true };
  }
  const r = await applyPromote({ candidate, decision: { ...decision, slug, subfolder: target }, ctx });
  if (r.kind === 'promoted') {
    if (check.describe && describeFolder(wiki.structure, check.describe)) wiki.dirty = true;
    noteNewPage(wiki.map, r.wikiPath, check.describe);
    logger.info({ msg: 'dream.deep.sub_page_created', agent: candidate.agent, memorySlug: candidate.slug, wikiPath: r.wikiPath, parent: target });
  }
  return r;
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
  /** The run's map — needed for the size guard's sub-page path. */
  wiki?: DeepWikiState;
  timeoutMs: number;
  signal?: AbortSignal;
  thinking?: ThinkingLevel;
}): Promise<CandidateOutcome> {
  const { candidate, ctx, mgr, workerModel, dispatcher, wikiPath, timeoutMs, signal, thinking } = args;
  const wikiFileAbs = join(ctx.wikiAbs, `${wikiPath}.md`);
  const existing = await readWithMtime(wikiFileAbs);
  if (existing && args.wiki && ctx.maxPageChars && existing.text.length > ctx.maxPageChars) {
    return subPageInstead({ candidate, ctx, workerModel, dispatcher, wiki: args.wiki, target: normalizeWikiPath(wikiPath), targetText: existing.text, timeoutMs, ...(signal ? { signal } : {}), ...(thinking ? { thinking } : {}) });
  }
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
    wikiMap: args.why
      ? `(single page focus — this is the complete current page, integrate into it: ${args.why})`
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
