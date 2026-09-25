// REM post-extraction dedup — mechanical filter, no LLM involved.
//
// Why this exists (buffet's report 2026-07-06): the extractor prompt
// already hands the worker model every existing memory note plus the
// wiki context and asks it to propose only NEW facts. Small worker
// models ignore that instruction — buffet's weekly monitoring sessions
// produced the same portfolio findings for weeks, 26/27 findings in one
// review round were repeats, several with byte-identical slugs. The fix
// is to stop trusting the prompt and enforce dedup in code, AFTER
// extraction and BEFORE the findings are persisted for review:
//
//   1. Exact slug collision (memory_write proposing a slug that already
//      exists as a memory note, or matching a wiki page the run loaded)
//      → the finding is DROPPED and logged. Nothing ambiguous about a
//      byte-identical slug.
//   2. Content similarity: hybrid search (memory+wiki sources) over the
//      proposed content; the candidate whose EMBEDDING COSINE
//      similarity is at/above `rem.dedup.similarityThreshold` marks
//      the finding `likely_duplicate` + `duplicate_of`. Not the fused
//      `score` — that one is a rank inside the candidate set (top hit
//      always 1.0 before boosts) and flagged ~70 % of findings against
//      unrelated pages (2026-08-26 report). The finding STAYS in the
//      review — similarity is a judgment call, the marker just lets
//      the user batch-dismiss with confidence.
//
// Dedup stages (1+2) only apply to `memory_write` findings. memory_edit /
// memory_delete address an existing slug by design (a "collision" is
// the point), and vault_hint is a pointer, not new content. A Stage-0
// referential check (below, always-on) additionally guards memory_edit /
// memory_delete against slugs that DON'T exist — invented targets would
// otherwise fail only at dream_apply time (2026-07-23 report).
//
// Scope note: workspace files (e.g. buffet's finance/monitoring/) are
// NOT visible here — that would be the deferred `memory.sourceOfTruth`
// design (option (c) in the report). This pass covers memory + wiki.

import { readFileSync } from 'node:fs';

import type { RemDedupConfig, RemJudgeConfig, ResolvedModel, ThinkingLevel } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { Hit } from '../memory/retrieval.ts';
import { cosineFromVecScore } from '../memory/retrieval.ts';
import { logger } from '../server/logger.ts';
import { askJudge as askJudgeLive, buildCoverageQuestion, type AskJudge, type CoverageText } from './judge.ts';
import type { Finding } from './types.ts';

/**
 * Stage 2b — the coverage judge (rem.dedup.judge, design in
 * private/dream-judge/). Passed by the runner only when enabled; the
 * model is resolved there (fail-loud at run start, like the worker).
 */
export interface RemJudgeArgs {
  model: ResolvedModel;
  config: RemJudgeConfig;
  thinking?: ThinkingLevel;
  /** Test seam — the live judge otherwise. */
  ask?: AskJudge;
  /** Test seam — reads the candidate's whole page; the file otherwise. */
  readPage?: (hit: Hit) => string | null;
}

export interface RemDedupArgs {
  agent: string;
  /** Dream id — for log correlation only. */
  dreamId: string;
  findings: Finding[];
  /** Slugs of ALL existing memory notes (complete list, from listNotes). */
  existingMemorySlugs: string[];
  /** Slugs of the wiki pages this run loaded into context (top-N match —
   *  not the whole wiki; full-wiki slug enumeration isn't available here). */
  loadedWikiSlugs: string[];
  mgr: MemoryManager;
  config: RemDedupConfig;
  judge?: RemJudgeArgs;
}

export interface RemDedupResult {
  findings: Finding[];
  dropped: number;
  marked: number;
  /** memory_edit findings whose slug doesn't exist as a memory note,
   *  converted to memory_write (Stage 0 referential validation). */
  downgraded: number;
  /** Stage 2b counters — all zero when the judge is off. */
  judged: number;
  /** `covered` at or above minConfidence → marked likely_duplicate. */
  judgeMarked: number;
  /** `adds_new` → the finding reads as new (novel_details) even when
   *  the cosine pass had marked it. */
  judgeCleared: number;
  /** Calls that failed or replied unreadably — those findings carry no verdict. */
  judgeFailed: number;
  /** Findings past maxPerRun, left unjudged. */
  judgeSkipped: number;
}

/** A candidate's whole page, frontmatter off, for the judge. */
function readPageFile(hit: Hit): string | null {
  try {
    return readFileSync(hit.filePath, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '');
  } catch {
    return null;
  }
}

/** The paragraph of `page` that carries one of the finding's hard
 *  tokens — what the reviewer should look at — else the page's head. */
function excerptFor(page: string, findingText: string): string {
  const tokens = hardTokens(findingText);
  const paragraphs = page.split(/\n\s*\n/);
  const hitPara = tokens.length > 0 ? paragraphs.find((p) => tokens.some((t) => p.includes(t))) : undefined;
  return excerptOf(hitPara ?? page);
}

/** Trim a matched chunk to a reviewable excerpt (~240 chars, single
 *  whitespace, ellipsis when cut). */
function excerptOf(chunkText: string, max = 240): string {
  const flat = chunkText.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Concrete "fact-bearing" tokens: number-ish sequences of ≥2 chars
 *  (dates 2026-07-29, counts 1.419, versions 0.144, times 14:05).
 *  Deliberately language-independent — status WORDS ("started",
 *  "beschlossen") vary too much to enumerate; the numbers and dates
 *  that accompany real state changes are the reliable signal. */
export function hardTokens(text: string): string[] {
  const matches = text.match(/\d[\d.,:\-/]*\d|\d{2,}/g) ?? [];
  return [...new Set(matches)];
}

export async function applyRemDedup(args: RemDedupArgs): Promise<RemDedupResult> {
  const memorySlugs = new Set(args.existingMemorySlugs);
  const wikiSlugs = new Set(args.loadedWikiSlugs);

  // Stage 0 — referential validation. Runs ALWAYS, even with dedup
  // disabled: it's a correctness gate, not a dedup heuristic.
  //
  // memory_edit / memory_delete address an existing memory note by
  // design — but small worker models sometimes invent a slug instead
  // (2026-07-23 report: a wanted wiki-page update surfaced as
  // memory_edit against the synthetic slug
  // `wiki-hardware-rene-llm-hardware-upgrade-2026`, which exists
  // nowhere). Such findings explode only later at dream_apply time,
  // which is exactly when agents start improvising. Catch them here:
  //   - memory_edit with proposed_content → downgrade to memory_write
  //     (the content is the point; a fresh note is the correct REM
  //     shape, Deep merges it into the wiki later)
  //   - memory_edit without content / memory_delete → drop with log
  //     (nothing actionable — an edit needs content, deleting a
  //     non-existent note is a no-op)
  const validated: Finding[] = [];
  let downgraded = 0;
  let droppedInvalid = 0;
  for (const f of args.findings) {
    const needsExistingNote = f.action === 'memory_edit' || f.action === 'memory_delete';
    if (needsExistingNote && !memorySlugs.has(f.slug)) {
      if (f.action === 'memory_edit' && f.proposed_content) {
        downgraded++;
        logger.info({
          msg: 'dream.rem.finding_downgraded',
          agent: args.agent,
          dreamId: args.dreamId,
          findingId: f.id,
          slug: f.slug,
          from: 'memory_edit',
          to: 'memory_write',
          reason: 'target memory note does not exist',
        });
        validated.push({
          ...f,
          action: 'memory_write',
          reason: `${f.reason} [auto-converted from memory_edit: note '${f.slug}' does not exist in memory]`,
        });
      } else {
        droppedInvalid++;
        logger.info({
          msg: 'dream.rem.finding_dropped_invalid_ref',
          agent: args.agent,
          dreamId: args.dreamId,
          findingId: f.id,
          action: f.action,
          slug: f.slug,
          reason: 'target memory note does not exist and finding is not convertible',
        });
      }
      continue;
    }
    validated.push(f);
  }

  if (!args.config.enabled) {
    return { findings: validated, dropped: droppedInvalid, marked: 0, downgraded, judged: 0, judgeMarked: 0, judgeCleared: 0, judgeFailed: 0, judgeSkipped: 0 };
  }
  const kept: Finding[] = [];
  let dropped = droppedInvalid;
  let marked = 0;
  let warnedNoVector = false;
  const judge = args.judge && args.judge.config.enabled ? args.judge : undefined;
  const ask = judge?.ask ?? askJudgeLive;
  const readPage = judge?.readPage ?? readPageFile;
  let judged = 0;
  let judgeMarked = 0;
  let judgeCleared = 0;
  let judgeFailed = 0;
  let judgeSkipped = 0;
  let warnedBudget = false;

  for (const f of validated) {
    if (f.action !== 'memory_write') {
      kept.push(f);
      continue;
    }

    // Stage 1 — exact slug collision → drop.
    const slugHit = memorySlugs.has(f.slug)
      ? 'memory'
      : wikiSlugs.has(f.slug)
        ? 'wiki'
        : null;
    // A write onto an existing MEMORY note is not automatically a
    // duplicate: the worker reuses the obvious slug when the person
    // corrects something ("luca-alter" again, now with the new age),
    // and dropping it threw the correction away unseen. If the note
    // does not already say it, keep the finding under its own slug —
    // nothing is overwritten, and Deep merges both next run.
    if (slugHit === 'memory' && f.proposed_content && f.proposed_content.trim().length > 0) {
      const existing = await readNoteText(args.mgr, f.slug);
      if (existing !== null && !saysTheSame(existing, f.proposed_content)) {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        let fresh = `${f.slug}-update-${stamp}`;
        for (let n = 2; memorySlugs.has(fresh) || kept.some((k) => k.slug === fresh); n++) fresh = `${f.slug}-update-${stamp}-${n}`;
        logger.info({
          msg: 'dream.rem.dedup_reslugged',
          agent: args.agent,
          dreamId: args.dreamId,
          findingId: f.id,
          from: f.slug,
          to: fresh,
          reason: 'existing note with this slug says something else — kept as a separate note',
        });
        kept.push({
          ...f,
          slug: fresh,
          reason: `${f.reason} [a note '${f.slug}' already exists and says something else — kept separately as '${fresh}' so nothing is overwritten]`,
        });
        continue;
      }
    }
    if (slugHit) {
      dropped++;
      logger.info({
        msg: 'dream.rem.dedup_dropped',
        agent: args.agent,
        dreamId: args.dreamId,
        findingId: f.id,
        slug: f.slug,
        matchedSource: slugHit,
        reason: 'exact slug collision with existing note/page',
      });
      continue;
    }

    // Stage 2 — content similarity → mark, keep.
    const text = (f.proposed_content ?? '').trim() || f.reason;
    if (text) {
      try {
        // Candidates come back ranked by the fused score, which is a
        // RANK within this query, not a similarity: min-max normalised
        // per candidate set, then × source boost, so the top wiki hit
        // is 0.98 and the top memory hit 0.85 for ANY query — "Star
        // Wars Tetris" duplicated "urlaubsplaner" at 0.98 (2026-08-26
        // report, ~70 % of findings flagged). The decision below uses
        // the absolute cosine similarity of the embedding instead;
        // minScore is 0 here only to get the candidates.
        const rawHits = await args.mgr.search(text, {
          limit: 5,
          minScore: 0,
          sources: ['memory', 'wiki'],
        });
        // Wiki audit logs (logs/YYYY-MM, written by Deep) are META
        // information — one-liners about promotes/merges — not a
        // knowledge store. They matched as "duplicates" for findings
        // whose content Deep had merely LOGGED processing, producing
        // false batch-dismiss hints (2 of 6 false positives in the
        // 2026-07-29 report). Exclude them from the dedup corpus.
        const candidates = rawHits.filter(
          (h) => !(h.source === 'wiki' && (h.slug === 'logs' || h.slug.startsWith('logs/'))),
        );
        // BM25-only hits carry vecScore 0 — no embedding, no similarity
        // judgment. They are never flagged; if NOTHING has a vector the
        // run says so once instead of silently flagging nothing.
        // Rounded to 4 places so a threshold set to what a user reads
        // in duplicate_of (2 places) compares the way they expect.
        const withVec = candidates
          .map((h) => ({ hit: h, similarity: Math.round(cosineFromVecScore(h.vecScore) * 1e4) / 1e4 }))
          .filter((c) => c.hit.vecScore > 0)
          .sort((a, b) => b.similarity - a.similarity);
        if (candidates.length > 0 && withVec.length === 0 && !warnedNoVector) {
          warnedNoVector = true;
          logger.warn({
            msg: 'dream.rem.dedup_no_vector_scores',
            agent: args.agent,
            dreamId: args.dreamId,
            hint: 'hybrid search returned BM25-only hits (no embeddings?) — content dedup cannot judge similarity, nothing flagged',
          });
        }
        const best = withVec[0];
        const hits = withVec.map((c) => c.hit);
        const top = best && best.similarity >= args.config.similarityThreshold ? best.hit : undefined;
        if (top && best) {
          marked++;
          f.likely_duplicate = true;
          f.duplicate_of = `${top.source}:${top.slug}@${best.similarity.toFixed(2)}`;
          // Show WHAT matched, not just how much — similarity flags
          // topic-overlap, and for a project page every project fact
          // scores high whether or not it's already written there.
          f.matched_excerpt = excerptOf(top.text);
          // Novelty: concrete tokens (numbers, dates, versions) in the
          // finding that appear in NONE of the matched chunks of the
          // duplicate target strongly suggest a NEW fact on a known
          // topic ("waiting for GO" vs "GO given on 2026-07-29").
          const corpus = hits
            .filter((h) => h.source === top.source && h.slug === top.slug)
            .map((h) => h.text)
            .join('\n');
          const novel = hardTokens(text).filter((t) => !corpus.includes(t));
          if (novel.length > 0) {
            f.novel_details = true;
          }
          logger.info({
            msg: 'dream.rem.dedup_marked',
            agent: args.agent,
            dreamId: args.dreamId,
            findingId: f.id,
            slug: f.slug,
            duplicateOf: f.duplicate_of,
            ...(novel.length > 0 ? { novelTokens: novel.slice(0, 8) } : {}),
          });
        }

        // Stage 2b — the coverage judge: a model reads the WHOLE pages
        // of the closest candidates and says whether the finding's
        // substance is already there. Cosine keeps its marks and its
        // number; the judge adds its verdict beside them, and marks on
        // its own when cosine did not (design: both signals visible).
        if (judge && candidates.length > 0) {
          if (judged >= judge.config.maxPerRun) {
            judgeSkipped++;
            if (!warnedBudget) {
              warnedBudget = true;
              logger.warn({
                msg: 'dream.rem.judge_budget_exhausted',
                agent: args.agent,
                dreamId: args.dreamId,
                maxPerRun: judge.config.maxPerRun,
                hint: 'further findings of this run carry no judge verdict — raise rem.dedup.judge.maxPerRun if this is regular',
              });
            }
          } else {
            const seen = new Set<string>();
            const pages: Array<{ id: string; hit: Hit; text: string }> = [];
            for (const h of candidates) {
              const id = `${h.source}:${h.slug}`;
              if (seen.has(id)) continue;
              seen.add(id);
              const page = readPage(h) ?? h.text;
              pages.push({ id, hit: h, text: page.slice(0, judge.config.maxPageChars) });
              if (pages.length >= judge.config.candidates) break;
            }
            const question = buildCoverageQuestion(
              { reason: f.reason, content: f.proposed_content ?? '' },
              pages.map((p): CoverageText => ({ id: p.id, text: p.text })),
              { maxPageChars: judge.config.maxPageChars },
            );
            judged++;
            try {
              const a = await ask({
                model: judge.model,
                question,
                timeoutMs: judge.config.timeoutMs,
                logCtx: { agent: args.agent, op: 'rem:judge', dreamId: args.dreamId, findingId: f.id, slug: f.slug },
                ...(judge.thinking ? { thinking: judge.thinking } : {}),
              });
              if (a.answer === null) {
                judgeFailed++;
                logger.warn({
                  msg: 'dream.rem.judge_unreadable',
                  agent: args.agent,
                  dreamId: args.dreamId,
                  findingId: f.id,
                  raw: a.raw.slice(0, 200),
                });
              } else {
                const cited = a.by && a.by >= 1 && a.by <= pages.length ? pages[a.by - 1] : undefined;
                f.judge_verdict = a.answer as Finding['judge_verdict'];
                f.judge_confidence = a.confidence;
                if (a.why) f.judge_reason = a.why;
                if (a.answer === 'covered') {
                  if (cited) f.judge_by = cited.id;
                  if (a.confidence >= judge.config.minConfidence) {
                    judgeMarked++;
                    if (!f.likely_duplicate) {
                      marked++;
                      f.likely_duplicate = true;
                      const target = cited ?? pages[0]!;
                      f.duplicate_of = `${target.id}@judge`;
                      f.matched_excerpt = excerptFor(target.text, text);
                    }
                  }
                } else {
                  judgeCleared++;
                  // "Adds new" is the judge's word for what novel_details
                  // guesses from numbers: do not batch-dismiss this one.
                  if (f.likely_duplicate) f.novel_details = true;
                }
                logger.info({
                  msg: 'dream.rem.judge_verdict',
                  agent: args.agent,
                  dreamId: args.dreamId,
                  findingId: f.id,
                  slug: f.slug,
                  verdict: a.answer,
                  confidence: a.confidence,
                  ...(cited ? { by: cited.id } : {}),
                  cosineMarked: !!top,
                  pages: pages.map((p) => p.id),
                });
              }
            } catch (err) {
              judgeFailed++;
              logger.warn({
                msg: 'dream.rem.judge_failed',
                agent: args.agent,
                dreamId: args.dreamId,
                findingId: f.id,
                err: (err as Error).message,
              });
            }
          }
        }
      } catch (err) {
        // Search failure must never cost the user a finding — degrade to
        // unmarked, same posture as the rest of the dream pipeline.
        logger.warn({
          msg: 'dream.rem.dedup_search_failed',
          agent: args.agent,
          dreamId: args.dreamId,
          findingId: f.id,
          err: (err as Error).message,
        });
      }
    }
    kept.push(f);
  }

  if (dropped > 0 || marked > 0 || downgraded > 0 || judged > 0) {
    logger.info({
      msg: 'dream.rem.dedup_summary',
      agent: args.agent,
      dreamId: args.dreamId,
      inputFindings: args.findings.length,
      dropped,
      marked,
      downgraded,
      ...(judge
        ? {
            judge_model: `${judge.model.providerName}/${judge.model.modelId}`,
            judged,
            judge_marked: judgeMarked,
            judge_cleared: judgeCleared,
            judge_failed: judgeFailed,
            judge_skipped: judgeSkipped,
          }
        : {}),
    });
  }
  return { findings: kept, dropped, marked, downgraded, judged, judgeMarked, judgeCleared, judgeFailed, judgeSkipped };
}

async function readNoteText(mgr: { getNote?: (slug: string) => Promise<unknown> }, slug: string): Promise<string | null> {
  try {
    const note = (await mgr.getNote?.(slug)) as { content?: unknown; markdown?: unknown; body?: unknown } | string | null | undefined;
    if (typeof note === 'string') return note;
    if (!note) return null;
    const text = note.content ?? note.markdown ?? note.body;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** True when `existing` already carries what `proposed` says: equal, or
 *  the proposed text contained in the note, ignoring case, markdown
 *  emphasis and whitespace. Deliberately strict — when in doubt the
 *  finding is kept and a person decides in the review. */
function saysTheSame(existing: string, proposed: string): boolean {
  const norm = (t: string): string => t.toLowerCase().replace(/[*_`#>-]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(existing);
  const b = norm(proposed);
  return b.length === 0 || a === b || a.includes(b);
}
