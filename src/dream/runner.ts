// Dream-Mode runner. The universal driver that orchestrates extraction +
// storage + status transitions. Used by both manual triggers (/reset) and
// the future auto-trigger idle worker. Differences between the two reduce
// to: the trigger field on the DreamMeta, and whether an AbortSignal is
// passed (auto = signal cancels on user activity; manual = no signal,
// runs to completion regardless).

import { readFile, unlink } from 'node:fs/promises';
import type { Config, ResolvedModel } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { DreamConfig } from '../persona/loader.ts';
import { logger } from '../server/logger.ts';
import { getHistory } from '../storage/sessions.ts';
import {
  dreamFilePath,
  dreamIdFor,
  readDreamById,
  transitionDreamStatus,
  writeDreamFile,
} from './storage.ts';
import { extractFromSession, resolveDreamModel } from './extract.ts';
import type { DreamFile, DreamMeta, DreamTriggerKind } from './types.ts';
import { loadReferencedWiki } from './wiki-context.ts';
import { readObsidianConfigForAgent } from '../memory/registry.ts';
import { join } from 'node:path';

export interface RunDreamArgs {
  agent: string;
  /** Source session whose JSONL delta to analyze. */
  sourceSession: string;
  trigger: DreamTriggerKind;
  /**
   * Lower bound (inclusive) of the JSONL range to extract. Use 0 for
   * "from the start of the session". Auto-trigger passes the session's
   * dreamReadThroughTs marker; manual /reset usually passes the same.
   */
  rangeFromTs: number;
  /** Upper bound (inclusive). Date.now() for "all events up to now". */
  rangeThroughTs: number;
  /** Resolved per-agent dream config (model, chunk sizes, timeouts). */
  dream: DreamConfig;
  /** Loaded server config — used to resolve dream.model to a ResolvedModel. */
  config: Config;
  /** Per-agent memory manager (already initialized). */
  mgr: MemoryManager;
  /**
   * Optional AbortSignal — auto-trigger sets one and aborts on user
   * activity; manual trigger leaves undefined (run to completion).
   */
  signal?: AbortSignal;
}

/**
 * Build a single combined search query from all user messages in the
 * range. Used to find which vault notes would have been referenced by
 * the runtime auto-inject for this conversation. Approximation but
 * cheaper than re-running search per user message.
 */
function buildVaultRecallQuery(events: Awaited<ReturnType<typeof getHistory>>): string {
  return events
    .filter((e) => e.kind === 'user_message')
    .map((e) => (e as { text: string }).text)
    .join(' ');
}

/**
 * Render the human-readable Markdown body for a completed dream.
 * Optional sources block lets the caller surface which memory + vault
 * notes were considered as input — useful to verify the extractor saw
 * the right source material.
 */
function renderBody(
  meta: DreamMeta,
  sourceTitle: string,
  sources?: {
    memorySlugs: string[];
    vaultSlugsWithScore: string[]; // pre-formatted "slug@0.74"
    wikiSlugs?: string[]; // Phase 4
  },
): string {
  const triggerWord = meta.trigger === 'manual' ? 'manual' : 'auto';
  const lines: string[] = [
    `# Dream — ${sourceTitle} (${triggerWord})`,
    '',
    `Source session: \`${meta.source_session}\`  `,
    `Range: \`${new Date(meta.range_from_ts).toISOString()}\` → \`${new Date(meta.range_through_ts).toISOString()}\`  `,
    `Worker model: \`${meta.worker_model_ref}\`  `,
    `Created: \`${meta.created_at}\`  `,
    `Status: **${meta.status}**`,
    '',
  ];
  if (sources) {
    lines.push('## Sources analyzed', '');
    lines.push(
      `- Memory notes (full content): ${sources.memorySlugs.length === 0 ? '_none_' : sources.memorySlugs.map((s) => `\`${s}\``).join(', ')}`,
    );
    lines.push(
      `- Vault notes (recall hits): ${sources.vaultSlugsWithScore.length === 0 ? '_none_' : sources.vaultSlugsWithScore.map((s) => `\`${s}\``).join(', ')}`,
    );
    if (sources.wikiSlugs && sources.wikiSlugs.length > 0) {
      lines.push(
        `- Wiki pages (stub-derived + recall): ${sources.wikiSlugs.map((s) => `\`wiki/${s}\``).join(', ')}`,
      );
    }
    lines.push('');
  }
  if (meta.findings.length === 0) {
    lines.push('No memory-worthy findings extracted from this range.', '');
  } else {
    lines.push('## Findings', '');
    for (const f of meta.findings) {
      const statusBadge =
        f.status === 'applied'
          ? '✓ applied'
          : f.status === 'dismissed'
            ? '✗ dismissed'
            : '· pending';
      lines.push(`### ${f.id}. \`${f.action}\` → \`${f.slug}\` (${statusBadge})`);
      lines.push('');
      lines.push(f.reason);
      lines.push('');
      if (f.current_excerpt) {
        lines.push('> Current memory:');
        lines.push('');
        lines.push('```');
        lines.push(f.current_excerpt);
        lines.push('```');
        lines.push('');
      }
      if (f.proposed_content) {
        lines.push('> Proposed content:');
        lines.push('');
        lines.push('```markdown');
        lines.push(f.proposed_content);
        lines.push('```');
        lines.push('');
      }
    }
  }
  return lines.join('\n');
}

/**
 * Main entry. Creates a `running` dream file, runs extraction, updates the
 * file to `paused` / `failed` / `completed` based on outcome.
 *
 * Errors in extraction are caught and result in a `failed` dream — never
 * thrown to the caller. The caller (server-side trigger) just fires this
 * and forgets. Diagnostic output goes to the Pino log.
 */
export async function runDream(args: RunDreamArgs): Promise<{ id: string; finalStatus: DreamMeta['status'] }> {
  const startedAt = new Date().toISOString();
  const id = dreamIdFor(args.agent, args.sourceSession, args.trigger);

  // Resolve worker model first — fail-loud per design (DreamConfig requires
  // an explicit model when enabled, no fallback).
  let workerModel: ResolvedModel;
  try {
    workerModel = resolveDreamModel(args.config, args.dream.model);
  } catch (err) {
    logger.error({
      msg: 'dream.worker_resolve_failed',
      agent: args.agent,
      err: (err as Error).message,
    });
    // Persist a failed dream so the user sees something rather than silent skip.
    const meta: DreamMeta = {
      id,
      agent: args.agent,
      source_session: args.sourceSession,
      trigger: args.trigger,
      status: 'failed',
      range_from_ts: args.rangeFromTs,
      range_through_ts: args.rangeThroughTs,
      created_at: startedAt,
      error: (err as Error).message,
      chunks_done: 0,
      chunks_total: 0,
      worker_model_ref: args.dream.model,
      findings: [],
    };
    // No `sources` block here — we never got past resolveDreamModel,
    // there's nothing to attribute.
    await writeDreamFile(args.agent, { meta, body: renderBody(meta, args.sourceSession) });
    return { id, finalStatus: 'failed' };
  }

  // Pull source events.
  const events = await getHistory(args.agent, args.sourceSession);
  const eventsInRange = events.filter(
    (e) => e.ts > args.rangeFromTs && e.ts <= args.rangeThroughTs,
  );

  // Memory snapshot.
  const noteSummaries = await args.mgr.listNotes();
  const existingMemory: Array<{ slug: string; markdown: string }> = [];
  for (const n of noteSummaries) {
    try {
      const note = await args.mgr.getNote(n.slug);
      if (note) existingMemory.push({ slug: n.slug, markdown: note.markdown });
    } catch (err) {
      logger.warn({ msg: 'dream.memory_read_failed', slug: n.slug, err: (err as Error).message });
    }
  }

  // Vault references — single combined query. We bump the limit (40) high
  // enough that vault hits don't get crowded out by memory hits in the
  // mixed search results: existing memory is already passed in full (see
  // listNotes() above), so memory-source hits in this search are
  // effectively duplicates and we drop them. Up to 15 vault notes pass
  // through to the extractor.
  const referencedVault: Array<{ slug: string; markdown: string; score: number }> = [];
  const recallQuery = buildVaultRecallQuery(eventsInRange);
  if (recallQuery.trim().length > 0) {
    try {
      const hits = await args.mgr.search(recallQuery, { limit: 40, minScore: 0.4 });
      const vaultHits = hits.filter((h) => h.source === 'vault').slice(0, 15);
      const seenSlugs = new Set<string>();
      for (const h of vaultHits) {
        if (seenSlugs.has(h.slug)) continue;
        seenSlugs.add(h.slug);
        try {
          const raw = await readFile(h.filePath, 'utf8');
          referencedVault.push({ slug: h.slug, markdown: raw, score: h.score });
        } catch (err) {
          logger.debug({
            msg: 'dream.vault_read_failed',
            slug: h.slug,
            err: (err as Error).message,
          });
        }
      }
    } catch (err) {
      logger.warn({ msg: 'dream.vault_recall_failed', err: (err as Error).message });
    }
  }

  // Wiki references (Phase 4 / Stufe 4). Two contributions:
  //  - Stub-derived: wiki pages targeted by promoted_to in agent's
  //    memory stubs. Always included so Dream-A can compare facts
  //    against the latest wiki state for already-promoted topics.
  //  - Recall-derived: wiki hits from the user-text query (topical
  //    overlap; may not have a stub yet).
  // Only populated when config.wiki.enabled.
  const referencedWiki: Array<{ slug: string; markdown: string }> = [];
  if (args.config.wiki.enabled) {
    try {
      const obs = await readObsidianConfigForAgent(args.agent);
      const wikiAbs = obs?.vaultPath
        ? join(obs.vaultPath, args.config.wiki.vaultSubfolder)
        : null;
      const pages = await loadReferencedWiki({
        agent: args.agent,
        mgr: args.mgr,
        recallQuery,
        wikiAbs,
      });
      for (const p of pages) {
        referencedWiki.push({ slug: p.slug, markdown: p.markdown });
      }
    } catch (err) {
      logger.warn({ msg: 'dream.wiki_ctx.load_failed', agent: args.agent, err: (err as Error).message });
    }
  }

  // Sources block — used by renderBody for the audit section in the
  // dream file's Markdown body. Same shape across all subsequent
  // renderBody calls so the file always shows what was considered.
  const sources = {
    memorySlugs: existingMemory.map((m) => m.slug),
    vaultSlugsWithScore: referencedVault.map((v) => `${v.slug}@${v.score.toFixed(2)}`),
    wikiSlugs: referencedWiki.map((w) => w.slug),
  };

  // Initial running file. chunks_total is set after the first chunk-plan
  // happens inside extractFromSession; we backfill once we know.
  const meta: DreamMeta = {
    id,
    agent: args.agent,
    source_session: args.sourceSession,
    trigger: args.trigger,
    status: 'running',
    range_from_ts: args.rangeFromTs,
    range_through_ts: args.rangeThroughTs,
    created_at: startedAt,
    chunks_done: 0,
    chunks_total: 0,
    worker_model_ref: `${workerModel.providerName}/${workerModel.modelId}`,
    findings: [],
  };
  let file: DreamFile = {
    meta,
    body: renderBody(meta, args.sourceSession, sources),
  };
  await writeDreamFile(args.agent, file);

  logger.info({
    msg: 'dream.start',
    agent: args.agent,
    id,
    trigger: args.trigger,
    sourceSession: args.sourceSession,
    eventsInRange: eventsInRange.length,
    existingMemoryCount: existingMemory.length,
    existingMemorySlugs: existingMemory.map((m) => m.slug),
    referencedVaultCount: referencedVault.length,
    referencedVaultSlugs: referencedVault.map((v) => `${v.slug}@${v.score.toFixed(2)}`),
    referencedWikiCount: referencedWiki.length,
    referencedWikiSlugs: referencedWiki.map((w) => w.slug),
    workerModel: meta.worker_model_ref,
  });

  try {
    const result = await extractFromSession({
      agent: args.agent,
      events: eventsInRange,
      existingMemory,
      referencedVault,
      referencedWiki,
      workerModel,
      chunkTimeoutMs: args.dream.chunkTimeoutMs,
      chunkTokens: args.dream.chunkTokens,
      signal: args.signal,
      onChunkComplete: async ({ chunkIndex, totalChunks }) => {
        // Persist progress so a crash mid-flight leaves a recoverable file.
        meta.chunks_done = chunkIndex;
        meta.chunks_total = totalChunks;
        file = { meta, body: renderBody(meta, args.sourceSession, sources) };
        await writeDreamFile(args.agent, file);
      },
    });

    meta.findings = result.findings;
    meta.chunks_done = result.chunksProcessed;
    meta.chunks_total = result.totalChunks;

    if (result.completed) {
      meta.completed_at = new Date().toISOString();
      // Zero-findings dreams have nothing to review — short-circuit straight
      // to processed/ so they don't loiter forever in .dreams/ active state
      // (dream_apply/dismiss can't fire on an empty findings array). Audit
      // trail is preserved in processed/.
      if (meta.findings.length === 0) {
        meta.processed_at = meta.completed_at;
        await transitionDreamStatus(
          args.agent,
          { meta, body: renderBody(meta, args.sourceSession, sources) },
          'processed',
          { completed_at: meta.completed_at, processed_at: meta.processed_at },
        );
        logger.info({
          msg: 'dream.completed_empty',
          agent: args.agent,
          id,
          note: 'no findings — auto-archived to processed/',
        });
        return { id, finalStatus: 'processed' };
      }
      await transitionDreamStatus(
        args.agent,
        { meta, body: renderBody(meta, args.sourceSession, sources) },
        'completed',
        { completed_at: meta.completed_at },
      );
      logger.info({
        msg: 'dream.completed',
        agent: args.agent,
        id,
        findings: meta.findings.length,
      });
      return { id, finalStatus: 'completed' };
    }
    // Cancelled mid-way — only auto-trigger should hit this path.
    await transitionDreamStatus(
      args.agent,
      { meta, body: renderBody(meta, args.sourceSession, sources) },
      'paused',
    );
    logger.info({
      msg: 'dream.paused',
      agent: args.agent,
      id,
      chunksDone: meta.chunks_done,
      chunksTotal: meta.chunks_total,
    });
    return { id, finalStatus: 'paused' };
  } catch (err) {
    meta.error = (err as Error).message;
    await transitionDreamStatus(
      args.agent,
      { meta, body: renderBody(meta, args.sourceSession, sources) },
      'failed',
      { error: meta.error },
    );
    logger.error({
      msg: 'dream.failed',
      agent: args.agent,
      id,
      err: meta.error,
    });
    return { id, finalStatus: 'failed' };
  }
}

/**
 * Resume a previously-paused dream from where it left off. Reads the
 * current state from disk, picks up at chunks_done + 1.
 */
export async function resumeDream(args: {
  agent: string;
  id: string;
  dream: DreamConfig;
  config: Config;
  mgr: MemoryManager;
  signal?: AbortSignal;
}): Promise<{ finalStatus: DreamMeta['status'] }> {
  const file = await readDreamById(args.agent, args.id);
  if (!file) throw new Error(`dream '${args.id}' not found`);
  if (file.meta.status !== 'paused') {
    throw new Error(`dream '${args.id}' is ${file.meta.status}, not paused — can't resume`);
  }

  // Delete the old paused file BEFORE kicking off the rerun. Without this,
  // the stale paused file accumulated indefinitely: runDream generates a
  // fresh timestamp-based id (dreamIdFor()), so a resume creates a new
  // `<new-id>.dream.running.md` and the original `<old-id>.dream.paused.md`
  // was never cleaned up. If the new run got aborted again (typical on
  // active accounts), the result was N+1 paused files instead of N. Across
  // a couple of days of idle cycles + user activity, paused dreams piled up
  // (hans bug report 2026-05-05: 5 paused, 0 findings, all from the same
  // source-session). Re-run-from-scratch was a deliberate v1 simplification
  // (see comment below) — we just have to take responsibility for the old
  // file's cleanup as part of resume's contract.
  const oldPath = dreamFilePath(args.agent, args.id, 'paused');
  try {
    await unlink(oldPath);
    logger.info({
      msg: 'dream.resume.unlink_old',
      agent: args.agent,
      id: args.id,
      sourceSession: file.meta.source_session,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({
        msg: 'dream.resume.unlink_old_failed',
        agent: args.agent,
        id: args.id,
        err: (err as Error).message,
      });
    }
  }

  // For v1 we re-run from scratch on resume (don't preserve partial findings).
  // Reason: partial findings without dedup across the full range can produce
  // duplicates we'd then have to reconcile. Cheap for the chunk-cost; not a
  // hot path in any case (auto-trigger gives small deltas).
  return runDream({
    agent: args.agent,
    sourceSession: file.meta.source_session,
    trigger: file.meta.trigger,
    rangeFromTs: file.meta.range_from_ts,
    rangeThroughTs: file.meta.range_through_ts,
    dream: args.dream,
    config: args.config,
    mgr: args.mgr,
    signal: args.signal,
  }).then((r) => ({ finalStatus: r.finalStatus }));
}
