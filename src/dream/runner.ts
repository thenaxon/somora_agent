// Dream-Mode runner. The universal driver that orchestrates extraction +
// storage + status transitions. Used by both manual triggers (/reset) and
// the future auto-trigger idle worker. Differences between the two reduce
// to: the trigger field on the DreamMeta, and whether an AbortSignal is
// passed (auto = signal cancels on user activity; manual = no signal,
// runs to completion regardless).

import { readFile } from 'node:fs/promises';
import type { Config, ResolvedModel } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { DreamConfig } from '../persona/loader.ts';
import { logger } from '../server/logger.ts';
import { getHistory } from '../storage/sessions.ts';
import {
  dreamIdFor,
  readDreamById,
  transitionDreamStatus,
  writeDreamFile,
} from './storage.ts';
import { extractFromSession, resolveDreamModel } from './extract.ts';
import type { DreamFile, DreamMeta, DreamTriggerKind } from './types.ts';

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
 */
function renderBody(meta: DreamMeta, sourceTitle: string): string {
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

  // Vault references — single combined query, take top-K vault hits.
  const referencedVault: Array<{ slug: string; markdown: string }> = [];
  const recallQuery = buildVaultRecallQuery(eventsInRange);
  if (recallQuery.trim().length > 0) {
    try {
      const hits = await args.mgr.search(recallQuery, { limit: 20, minScore: 0.4 });
      const vaultHits = hits.filter((h) => h.source === 'vault');
      const seenSlugs = new Set<string>();
      for (const h of vaultHits) {
        if (seenSlugs.has(h.slug)) continue;
        seenSlugs.add(h.slug);
        try {
          const raw = await readFile(h.filePath, 'utf8');
          referencedVault.push({ slug: h.slug, markdown: raw });
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
    body: renderBody(meta, args.sourceSession),
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
    referencedVaultCount: referencedVault.length,
    workerModel: meta.worker_model_ref,
  });

  try {
    const result = await extractFromSession({
      agent: args.agent,
      events: eventsInRange,
      existingMemory,
      referencedVault,
      workerModel,
      chunkTimeoutMs: args.dream.chunkTimeoutMs,
      chunkTokens: args.dream.chunkTokens,
      signal: args.signal,
      onChunkComplete: async ({ chunkIndex, totalChunks }) => {
        // Persist progress so a crash mid-flight leaves a recoverable file.
        meta.chunks_done = chunkIndex;
        meta.chunks_total = totalChunks;
        file = { meta, body: renderBody(meta, args.sourceSession) };
        await writeDreamFile(args.agent, file);
      },
    });

    meta.findings = result.findings;
    meta.chunks_done = result.chunksProcessed;
    meta.chunks_total = result.totalChunks;

    if (result.completed) {
      meta.completed_at = new Date().toISOString();
      const final = await transitionDreamStatus(
        args.agent,
        { meta, body: renderBody(meta, args.sourceSession) },
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
      { meta, body: renderBody(meta, args.sourceSession) },
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
      { meta, body: renderBody(meta, args.sourceSession) },
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
