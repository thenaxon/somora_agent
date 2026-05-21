// Dream-Mode tool surface (Phase 2-Stufe-D, DECISIONS pending). Lets the
// agent walk pending dreams with the user step-by-step, applying or
// dismissing each finding. dream_apply translates a finding into the
// equivalent memory_* action — no creative logic at apply-time, just
// confirmation of the extractor's proposal.
//
//   dream_list                            — overview of pending (non-processed) dreams
//   dream_get(dream_id)                   — full content + per-finding state
//   dream_apply(dream_id, finding_id)     — execute a finding's action; auto-archive
//                                            when all findings resolved
//   dream_dismiss(dream_id, finding_id?)  — reject a single finding; without finding_id:
//                                            whole dream dismissed

import { z } from 'zod';
import {
  dismissEntireDream,
  listDreams,
  readDreamById,
  updateFindingStatus,
} from '../../dream/storage.ts';
import type { Finding } from '../../dream/types.ts';
import { loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ToolDefinition } from '../types.ts';
import type { DeepWorker } from '../../dream/deep-worker.ts';
import type { LucidWorker } from '../../dream/lucid-worker.ts';
import {
  dismissEntireLucidRun,
  listLucidRuns,
  readLucidRunById,
  setRunStatus,
  updateLucidFindingStatus,
  writeLucidRun,
} from '../../dream/lucid-storage.ts';
import type { LucidFinding, LucidRun } from '../../dream/lucid-types.ts';
import { applyLucidFinding } from '../../dream/lucid-actions.ts';
import {
  clearLoopState,
  getLoopState,
  setLoopState,
} from '../../dream/loop-state.ts';
import { resolveObsidianSource } from '../../memory/registry.ts';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

// ── Shared helpers ────────────────────────────────────────────────────

const DreamIdSchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/, 'invalid dream id');

function findingSummary(f: Finding): string {
  const parts: string[] = [`#${f.id} ${f.action} → ${f.slug}`];
  if (f.status !== 'pending') parts.push(`(${f.status})`);
  return parts.join(' ');
}

// ── dream_list ────────────────────────────────────────────────────────

const ListInput = z.object({
  include_processed: z.boolean().optional(),
});

export const dreamList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'dream_list',
  toolset: 'dream',
  description:
    'List pending dreams awaiting user review. Returns both per-agent memory dreams (REM phase: ' +
    'atomic findings from your sessions, scoped to YOUR agent) and global wiki-cleanup runs ' +
    '(Lucid phase: contradictions / stale claims / wanted-pages / outdated content in the shared ' +
    "wiki, same for every agent). Each entry has a `kind` field = 'memory' or 'wiki_lucid' so the " +
    'agent can describe them differently to the user. Pass include_processed=true to also see ' +
    'already-resolved entries. Use this first when the user asks "hast du was geträumt?" or ' +
    '"gibt\'s was zum aufräumen?" — pick the oldest and walk through it with `dream_get`.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      include_processed: {
        type: 'boolean',
        description: 'Include dreams whose findings have all been resolved (default false).',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const includeProcessed = input.include_processed === true;
    const memoryDreams = await listDreams(ctx.agent, { includeProcessed });
    const lucidRuns = await listLucidRuns();
    const memEntries = memoryDreams.map((d) => ({
      id: d.meta.id,
      kind: 'memory' as const,
      trigger: d.meta.trigger,
      source_session: d.meta.source_session,
      status: d.meta.status,
      created_at: d.meta.created_at,
      completed_at: d.meta.completed_at,
      findings_total: d.meta.findings.length,
      findings_pending: d.meta.findings.filter((f) => f.status === 'pending').length,
      findings_applied: d.meta.findings.filter((f) => f.status === 'applied').length,
      findings_dismissed: d.meta.findings.filter((f) => f.status === 'dismissed').length,
    }));
    const lucidEntries = lucidRuns
      .filter((r) => includeProcessed || r.status !== 'processed')
      .map((r) => ({
        id: r.id,
        kind: 'wiki_lucid' as const,
        trigger: r.trigger,
        status: r.status,
        created_at: r.created_at,
        completed_at: r.completed_at,
        pages_scanned: r.pages_scanned,
        findings_total: r.findings.length,
        findings_pending: r.findings.filter((f) => f.status === 'pending').length,
        findings_applied: r.findings.filter((f) => f.status === 'applied').length,
        findings_dismissed: r.findings.filter((f) => f.status === 'dismissed').length,
      }));
    return {
      count: memEntries.length + lucidEntries.length,
      by_kind: { memory: memEntries.length, wiki_lucid: lucidEntries.length },
      dreams: [...memEntries, ...lucidEntries],
    };
  },
};

// ── dream_get ─────────────────────────────────────────────────────────

const GetInput = z.object({
  dream_id: DreamIdSchema,
});

export const dreamGet: ToolDefinition<z.infer<typeof GetInput>> = {
  name: 'dream_get',
  toolset: 'dream',
  description:
    'Fetch the full content of a dream — all findings with their proposed actions, reasons, and ' +
    'per-finding status. Works for both memory dreams (kind=memory, per-agent) and wiki-cleanup ' +
    "runs (kind=wiki_lucid, global). The output's `kind` field tells the agent which type so it " +
    'can describe findings appropriately. Use after `dream_list`.',
  inputSchema: GetInput,
  jsonSchema: {
    type: 'object',
    properties: {
      dream_id: { type: 'string', description: 'The id of the dream/lucid run to retrieve.' },
    },
    required: ['dream_id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    // Try memory-dream first; fall back to lucid run.
    const memFile = await readDreamById(ctx.agent, input.dream_id);
    if (memFile) {
      return {
        id: memFile.meta.id,
        kind: 'memory' as const,
        trigger: memFile.meta.trigger,
        source_session: memFile.meta.source_session,
        status: memFile.meta.status,
        created_at: memFile.meta.created_at,
        completed_at: memFile.meta.completed_at,
        processed_at: memFile.meta.processed_at,
        worker_model_ref: memFile.meta.worker_model_ref,
        ...(memFile.meta.error ? { error: memFile.meta.error } : {}),
        findings: memFile.meta.findings,
        pending_count: memFile.meta.findings.filter((f) => f.status === 'pending').length,
      };
    }
    const lucidRun = await readLucidRunById(input.dream_id);
    if (lucidRun) {
      return {
        id: lucidRun.id,
        kind: 'wiki_lucid' as const,
        trigger: lucidRun.trigger,
        status: lucidRun.status,
        created_at: lucidRun.created_at,
        completed_at: lucidRun.completed_at,
        processed_at: lucidRun.processed_at,
        pages_scanned: lucidRun.pages_scanned,
        worker_model_ref: lucidRun.worker_model_ref,
        ...(lucidRun.error ? { error: lucidRun.error } : {}),
        findings: lucidRun.findings,
        pending_count: lucidRun.findings.filter((f) => f.status === 'pending').length,
      };
    }
    throw new Error(`dream '${input.dream_id}' not found (checked memory + wiki_lucid)`);
  },
};

// ── dream_apply ───────────────────────────────────────────────────────

const ApplyInput = z.object({
  dream_id: DreamIdSchema,
  finding_id: z.number().int().positive(),
});

export const dreamApply: ToolDefinition<z.infer<typeof ApplyInput>> = {
  name: 'dream_apply',
  toolset: 'dream',
  description:
    'Accept a single finding from a dream — executes its proposed memory action and marks the finding ' +
    'as applied. After the last finding of a dream is resolved, the dream auto-archives to processed/. ' +
    'Returns whether the dream is now fully done so the agent knows when to stop walking. ' +
    'IMPORTANT: pass `dream_id` and `finding_id` EXACTLY as returned by `dream_list` / `dream_get` ' +
    '— do not invent or guess values. Finding ids start at 1.',
  inputSchema: ApplyInput,
  jsonSchema: {
    type: 'object',
    properties: {
      dream_id: { type: 'string', description: 'Dream containing the finding.' },
      finding_id: {
        type: 'integer',
        minimum: 1,
        description: 'Numeric finding id (`id` field within the dream\'s findings array).',
      },
    },
    required: ['dream_id', 'finding_id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    // Try memory dream first.
    const memFile = await readDreamById(ctx.agent, input.dream_id);
    if (memFile) {
      return await applyMemoryFinding(memFile, input.dream_id, input.finding_id, ctx);
    }
    // Fall through to lucid run.
    const lucidRun = await readLucidRunById(input.dream_id);
    if (lucidRun) {
      return await applyLucidFindingFromRun(lucidRun, input.dream_id, input.finding_id, ctx);
    }
    // Neither store has it — provide both kinds of valid ids for self-correction.
    const memDreams = await listDreams(ctx.agent);
    const lucidRuns = await listLucidRuns();
    const known = [
      ...memDreams.map((d) => `'${d.meta.id}' (memory)`),
      ...lucidRuns.map((r) => `'${r.id}' (wiki_lucid)`),
    ];
    throw new Error(
      `dream '${input.dream_id}' not found. Valid ids: ${
        known.length ? known.join(', ') : '(none — call dream_list first)'
      }`,
    );
  },
};

async function applyMemoryFinding(
  memFile: NonNullable<Awaited<ReturnType<typeof readDreamById>>>,
  dreamId: string,
  findingId: number,
  ctx: import('../types.ts').ToolContext,
): Promise<unknown> {
  const finding = memFile.meta.findings.find((f) => f.id === findingId);
  if (!finding) {
    const validIds = memFile.meta.findings.map((f) => f.id);
    throw new Error(
      `finding ${findingId} not in dream '${dreamId}'. Valid finding ids: ${
        validIds.length ? validIds.join(', ') : '(none)'
      }. Note: finding ids start at 1, not 0.`,
    );
  }
  if (finding.status !== 'pending') {
    throw new Error(
      `finding ${findingId} is already ${finding.status} (resolved at ${finding.resolved_at ?? 'unknown'})`,
    );
  }
  const mgr = await ctx.getMemoryManager();
  let executed: { description: string };
  switch (finding.action) {
    case 'memory_write': {
      if (!finding.proposed_content) {
        throw new Error(`finding ${findingId}: memory_write needs proposed_content`);
      }
      const fm =
        finding.frontmatter_tags && finding.frontmatter_tags.length > 0
          ? { tags: finding.frontmatter_tags }
          : undefined;
      await mgr.writeNote(finding.slug, finding.proposed_content, fm);
      executed = { description: `wrote memory/${finding.slug}.md` };
      break;
    }
    case 'memory_edit': {
      if (!finding.proposed_content) {
        throw new Error(`finding ${findingId}: memory_edit needs proposed_content`);
      }
      await mgr.writeNote(finding.slug, finding.proposed_content, undefined, { mustExist: true });
      executed = { description: `edited memory/${finding.slug}.md` };
      break;
    }
    case 'memory_delete': {
      const ok = await mgr.deleteNote(finding.slug);
      executed = { description: ok ? `deleted memory/${finding.slug}.md` : `memory/${finding.slug}.md was already gone` };
      break;
    }
    case 'vault_hint': {
      executed = {
        description: `vault hint acknowledged (no auto-write to vault from agents — Deep/Lucid handle vault)`,
      };
      break;
    }
    default: {
      throw new Error(`finding ${findingId}: unknown action '${(finding as { action: string }).action}'`);
    }
  }
  const result = await updateFindingStatus(ctx.agent, dreamId, findingId, 'applied');
  const remaining = result.dream.meta.findings.filter((f) => f.status === 'pending').length;
  return {
    kind: 'memory',
    applied: true,
    finding: findingSummary(finding),
    executed: executed.description,
    remaining,
    dream_done: result.allResolved,
  };
}

async function applyLucidFindingFromRun(
  lucidRun: LucidRun,
  runId: string,
  findingId: number,
  ctx: import('../types.ts').ToolContext,
): Promise<unknown> {
  const finding: LucidFinding | undefined = lucidRun.findings.find((f) => f.id === findingId);
  if (!finding) {
    const validIds = lucidRun.findings.map((f) => f.id);
    throw new Error(
      `finding ${findingId} not in lucid run '${runId}'. Valid finding ids: ${
        validIds.length ? validIds.join(', ') : '(none)'
      }. Note: finding ids start at 1, not 0.`,
    );
  }
  if (finding.status !== 'pending') {
    throw new Error(
      `finding ${findingId} is already ${finding.status} (resolved at ${finding.resolved_at ?? 'unknown'})`,
    );
  }
  const obs = resolveObsidianSource(ctx.config.obsidian);
  if (!obs?.vaultPath) {
    throw new Error('lucid apply: no obsidian vault configured');
  }
  const wikiAbs = join(obs.vaultPath, ctx.config.wiki.vaultSubfolder);
  const outcome = await applyLucidFinding(finding, { wikiAbs });
  if (outcome.kind === 'failed') {
    throw new Error(`lucid apply failed: ${outcome.error}`);
  }
  // Both 'applied' and 'skipped' close the slot — agent reviews the
  // outcome string, user dismisses explicitly if they want to retry.
  const result = await updateLucidFindingStatus(runId, findingId, 'applied');
  const remaining = result?.run.findings.filter((f) => f.status === 'pending').length ?? 0;
  return {
    kind: 'wiki_lucid',
    applied: outcome.kind === 'applied',
    finding: `#${finding.id} ${finding.kind}`,
    executed:
      outcome.kind === 'applied' ? outcome.detail : `skipped: ${outcome.reason}`,
    remaining,
    dream_done: remaining === 0,
  };
}

// ── dream_dismiss ─────────────────────────────────────────────────────

const DismissInput = z.object({
  dream_id: DreamIdSchema,
  finding_id: z.number().int().positive().optional(),
});

export const dreamDismiss: ToolDefinition<z.infer<typeof DismissInput>> = {
  name: 'dream_dismiss',
  toolset: 'dream',
  description:
    'Reject a finding (no memory action, just mark as dismissed). Pass finding_id to dismiss one; ' +
    'omit it to dismiss the whole dream (all still-pending findings → dismissed, dream auto-archives). ' +
    'Use the no-finding-id form for "this whole dream was off-base". ' +
    'IMPORTANT: pass `dream_id` and (if used) `finding_id` EXACTLY as returned by `dream_list` / ' +
    '`dream_get`. Finding ids start at 1.',
  inputSchema: DismissInput,
  jsonSchema: {
    type: 'object',
    properties: {
      dream_id: { type: 'string', description: 'Dream id.' },
      finding_id: {
        type: 'integer',
        minimum: 1,
        description: 'Optional. Without it, the entire dream is dismissed.',
      },
    },
    required: ['dream_id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    // Try memory dream first.
    const memFile = await readDreamById(ctx.agent, input.dream_id);
    if (memFile) {
      if (input.finding_id !== undefined) {
        if (!memFile.meta.findings.some((f) => f.id === input.finding_id)) {
          const validIds = memFile.meta.findings.map((f) => f.id);
          throw new Error(
            `finding ${input.finding_id} not in dream '${input.dream_id}'. Valid finding ids: ${
              validIds.length ? validIds.join(', ') : '(none)'
            }. Note: finding ids start at 1, not 0.`,
          );
        }
        const result = await updateFindingStatus(ctx.agent, input.dream_id, input.finding_id, 'dismissed');
        const remaining = result.dream.meta.findings.filter((f) => f.status === 'pending').length;
        return {
          kind: 'memory',
          dismissed: true,
          finding_id: input.finding_id,
          remaining,
          dream_done: result.allResolved,
        };
      }
      const result = await dismissEntireDream(ctx.agent, input.dream_id);
      return {
        kind: 'memory',
        dismissed: true,
        whole_dream: true,
        dismissed_count: result.dismissedCount,
        dream_done: true,
      };
    }
    // Fall through to lucid run.
    const lucidRun = await readLucidRunById(input.dream_id);
    if (lucidRun) {
      if (input.finding_id !== undefined) {
        if (!lucidRun.findings.some((f) => f.id === input.finding_id)) {
          const validIds = lucidRun.findings.map((f) => f.id);
          throw new Error(
            `finding ${input.finding_id} not in lucid run '${input.dream_id}'. Valid finding ids: ${
              validIds.length ? validIds.join(', ') : '(none)'
            }. Note: finding ids start at 1, not 0.`,
          );
        }
        const result = await updateLucidFindingStatus(
          input.dream_id,
          input.finding_id,
          'dismissed',
        );
        const remaining = result?.run.findings.filter((f) => f.status === 'pending').length ?? 0;
        return {
          kind: 'wiki_lucid',
          dismissed: true,
          finding_id: input.finding_id,
          remaining,
          dream_done: remaining === 0,
        };
      }
      const result = await dismissEntireLucidRun(input.dream_id);
      const dismissedCount = result?.findings.filter((f) => f.status === 'dismissed').length ?? 0;
      return {
        kind: 'wiki_lucid',
        dismissed: true,
        whole_dream: true,
        dismissed_count: dismissedCount,
        dream_done: true,
      };
    }
    // Neither — list valid ids
    const memDreams = await listDreams(ctx.agent);
    const lucidRuns = await listLucidRuns();
    const known = [
      ...memDreams.map((d) => `'${d.meta.id}' (memory)`),
      ...lucidRuns.map((r) => `'${r.id}' (wiki_lucid)`),
    ];
    throw new Error(
      `dream '${input.dream_id}' not found. Valid ids: ${
        known.length ? known.join(', ') : '(none — call dream_list first)'
      }`,
    );
  },
};

// ── dream_run ─────────────────────────────────────────────────────────
//
// Manual trigger for Deep (memory→wiki consolidation) and Lucid
// (wiki cleanup). Single tool with `phase` arg covers both — keeps
// the dream_*-Toolset tight. See `private/dream-system-v2.md` for
// the full Phase model (REM/Deep/Lucid).

interface DreamRunDeps {
  deepWorker: DeepWorker;
  lucidWorker: LucidWorker;
}

let injectedDreamRunDeps: DreamRunDeps | null = null;

/** Server boot wires the DeepWorker reference here so the in-process
 *  tool handler can call runNow() directly. The MCP child doesn't
 *  get this — it falls back to the HTTP endpoint. */
export function configureDreamRunTool(deps: DreamRunDeps): void {
  injectedDreamRunDeps = deps;
}

const RunInput = z.object({
  phase: z.enum(['deep', 'lucid']).optional(),
  wait: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const dreamRun: ToolDefinition<z.infer<typeof RunInput>> = {
  name: 'dream_run',
  toolset: 'dream',
  description:
    'Manually trigger a platform-wide dream phase.\n' +
    '\n' +
    "phase='deep' (default): Memory → Wiki consolidation. Reads each agent's " +
    'short-term memory, decides via Opus which entries are wiki-worthy, writes them ' +
    'as consolidated wiki pages with cross-references, deletes the source memory ' +
    'files after successful consolidation. Memory entries already covered in the ' +
    'wiki get merged into the existing page; transient/scratchpad entries get skipped.\n' +
    "phase='lucid': Wiki cleanup — periodic health-check for contradictions, stale " +
    'claims, broken links, orphans, refactor candidates. LLM-driven (Opus) with full ' +
    'wiki context. Findings need user approval before any wiki edits apply.\n' +
    '\n' +
    'NOTE: REM (Session → Memory, per-agent) is NOT triggered via this tool. ' +
    'Use /reset on a session to manually fire REM, or wait for the per-agent ' +
    'idle-timeout auto-trigger.\n' +
    '\n' +
    'CALLING CONVENTION — read carefully:\n' +
    '\n' +
    '* Default is fire-and-forget. Just call dream_run({}) (or dream_run({phase:"deep"})). ' +
    'The run starts in the background and the tool returns IMMEDIATELY with ' +
    '`{started: true}`. Hand the response back to the user, the conversation continues, ' +
    'the run finishes in 1-3 minutes (deep) or 5-30s (lucid) in the background. ' +
    'Results land in the Obsidian Vault (Deep) or as pending findings via dream_list (Lucid).\n' +
    '\n' +
    '* DO NOT pass wait:true unless the user EXPLICITLY says "warte bis fertig" / ' +
    '"block until done" / "lauf synchron" / equivalent. ' +
    'Asking the user "did this run?" or wanting to give a comprehensive summary in your ' +
    'reply is NOT a reason to use wait:true — the agent-blocking duration is bad UX. ' +
    'The async response is the correct response in 99% of cases.\n' +
    '\n' +
    "* Use sparingly — Deep's scheduler runs every 12h by default, Lucid weekly. " +
    'Manual triggers are for "I just added several substantial memory notes and want ' +
    'them in the wiki now" or "let me cleanup the wiki right now".\n' +
    '\n' +
    "* force:true (phase='deep' only) bypasses the per-agent skip-cache so every " +
    'memory file gets re-evaluated with a fresh LLM call. Use when a memory note ' +
    "should have ended up in the wiki but didn't, or after a Deep prompt change. " +
    'Costs extra tokens (no cached skips), so reach for it deliberately.',
  inputSchema: RunInput,
  jsonSchema: {
    type: 'object',
    properties: {
      phase: {
        type: 'string',
        enum: ['deep', 'lucid'],
        description:
          "Which dream phase to fire. Default 'deep' (Memory→Wiki). 'lucid' triggers wiki cleanup.",
      },
      wait: {
        type: 'boolean',
        description:
          'OMIT in normal use. Default behavior is async (fire-and-forget) — the tool returns ' +
          'immediately and the run continues in the background. Set wait:true ONLY when the ' +
          'user has explicitly asked for synchronous/blocking behavior (e.g. "warte bis der ' +
          'Run fertig ist", "lauf synchron", "block this turn until done"). Wanting to ' +
          'summarize results in your reply is NOT a valid reason to use wait:true.',
      },
      force: {
        type: 'boolean',
        description:
          "ONLY for phase='deep'. Default false. When true, ignore the per-agent skip-cache " +
          'and re-evaluate every memory file with the LLM. Use after Deep prompt changes, ' +
          'when debugging why a specific memory was skipped, or when a memory file should ' +
          "have been consolidated but didn't show up in the wiki. Costs extra tokens — " +
          "most runs shouldn't need this.",
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const phase = input.phase ?? 'deep';
    const wait = input.wait ?? false;
    const force = input.force ?? false;
    if (!ctx.config.wiki.enabled) {
      throw new Error('config.wiki.enabled is false — wiki layer not active');
    }
    if (phase === 'lucid') {
      if (injectedDreamRunDeps) {
        if (!wait) {
          void injectedDreamRunDeps.lucidWorker.runNow().catch(() => {
            /* errors logged in worker */
          });
          return {
            phase: 'lucid',
            started: true,
            wait: false,
            message:
              'Lucid started in background. Check ~/.somora/wiki-lucid/ for the run report ' +
              "or call dream_list to see findings once it's complete (~1-3min for a small wiki).",
            via: 'in-process',
          };
        }
        const result = await injectedDreamRunDeps.lucidWorker.runNow();
        return {
          phase: 'lucid',
          wait: true,
          runId: result.runId,
          findingsCount: result.findingsCount,
          pagesScanned: result.pagesScanned,
          durationMs: result.durationMs,
          status: result.status,
          via: 'in-process',
        };
      }
      return runLucidViaHttp(wait);
    }
    // phase === 'deep'
    if (injectedDreamRunDeps) {
      if (!wait) {
        void injectedDreamRunDeps.deepWorker.runNow({ force }).catch(() => {
          /* error already logged in worker */
        });
        return {
          phase: 'deep',
          started: true,
          wait: false,
          force,
          message:
            'Deep started in background. Check ~/.somora/logs/server-*.log for ' +
            "'dream.deep.done', or inspect <vault>/<wiki-subfolder>/index.md after ~1-3min.",
          via: 'in-process',
        };
      }
      const result = await injectedDreamRunDeps.deepWorker.runNow({ force });
      const counts = result.outcomes.reduce(
        (acc, o) => {
          acc[o.kind] = (acc[o.kind] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      return {
        phase: 'deep',
        wait: true,
        force,
        candidatesSeen: result.candidatesSeen,
        cachedSkips: result.cachedSkips,
        durationMs: result.durationMs,
        counts,
        outcomes: result.outcomes,
        via: 'in-process',
      };
    }
    return runDeepViaHttp(wait, force);
  },
};

async function runDeepViaHttp(wait: boolean, force: boolean): Promise<unknown> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const url = `${scheme}://${host}:${port}/dream/run-deep`;
  const res = await loopbackFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wait, force }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`dream_run HTTP fallback ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return { phase: 'deep', ...data, via: 'http' };
}

async function runLucidViaHttp(wait: boolean): Promise<unknown> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const url = `${scheme}://${host}:${port}/dream/run-lucid`;
  const res = await loopbackFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wait }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`dream_run phase=lucid HTTP fallback ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return { phase: 'lucid', ...data, via: 'http' };
}

// ── dream_review ──────────────────────────────────────────────────────

const ReviewInput = z.object({
  dream_id: DreamIdSchema,
  action: z.enum(['start', 'end']),
  summary: z.string().optional(),
});

const SOMORA_HOME = process.env.SOMORA_HOME ?? `${process.env.HOME}/.somora`;
const LUCID_ROOT = join(SOMORA_HOME, 'wiki-lucid');

function runFilePath(id: string, processed: boolean): string {
  const dir = processed ? join(LUCID_ROOT, 'processed') : LUCID_ROOT;
  return join(dir, `${id}.json`);
}

export const dreamReview: ToolDefinition<z.infer<typeof ReviewInput>> = {
  name: 'dream_review',
  toolset: 'dream',
  description:
    'Open or close a wiki review loop for a Lucid run. While the loop is active, the calling ' +
    'agent gets the loop-scoped wiki tools (wiki_edit, wiki_create, wiki_delete) AND has its ' +
    'normal file_*/exec_*/agents_*/skill_*/tmux_* tools hidden — the goal is a focused ' +
    'wiki-editing conversation with the user.\n' +
    '\n' +
    "action='start': begin the loop for the named Lucid run id. Each Lucid finding will be " +
    "surfaced in the system context every turn until you call action='end'. Only ONE loop can " +
    'be active per somora instance — concurrent start fails.\n' +
    "action='end': close the loop, archive the Lucid run to processed/, and clear the active " +
    'lock. REQUIRES `summary` arg covering what happened to each finding (applied as edit X, ' +
    'dismissed as no-op, deferred for later — be explicit, no silent drops).\n' +
    '\n' +
    'Use this when the user asks "schau dir das Lucid-Ergebnis an" or similar — open the loop, ' +
    "walk the findings as a conversation, write changes through wiki_*, close with action='end' " +
    'when the user signals done. The loop auto-expires after 24h idle as a safety net.',
  inputSchema: ReviewInput,
  jsonSchema: {
    type: 'object',
    properties: {
      dream_id: { type: 'string', description: 'Lucid run id from dream_list / dream_get.' },
      action: {
        type: 'string',
        enum: ['start', 'end'],
        description: "'start' opens the loop, 'end' closes it.",
      },
      summary: {
        type: 'string',
        description:
          "REQUIRED for action='end'. Brief outcome per finding so the user knows nothing was " +
          'silently dropped. Optional / ignored for action=start.',
      },
    },
    required: ['dream_id', 'action'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const run = await readLucidRunById(input.dream_id);
    if (!run) {
      throw new Error(
        `dream_review: lucid run '${input.dream_id}' not found (only Lucid runs are loop-eligible; ` +
          'REM dreams are reviewed via dream_apply / dream_dismiss).',
      );
    }
    if (input.action === 'start') {
      const existing = getLoopState();
      if (existing && (existing.agent !== ctx.agent || existing.dreamId !== input.dream_id)) {
        throw new Error(
          `dream_review: another review loop is already active (agent='${existing.agent}', ` +
            `dream_id='${existing.dreamId}', startedAt='${existing.startedAt}'). End it via ` +
            'dream_review action=end before starting a new one.',
        );
      }
      const now = new Date().toISOString();
      setLoopState({
        agent: ctx.agent,
        dreamId: input.dream_id,
        startedAt: existing?.startedAt ?? now,
        lastActivityAt: now,
      });
      const open = run.findings.filter((f) => f.status === 'pending');
      return {
        action: 'start',
        dream_id: input.dream_id,
        agent: ctx.agent,
        pending_findings: open.length,
        total_findings: run.findings.length,
        message:
          'Wiki review loop is now active for you. The findings are now in your system context ' +
          'every turn; wiki_edit/wiki_create/wiki_delete are exposed; file_*/exec_*/agents_*/' +
          "skill_*/tmux_* are hidden until you call dream_review action='end'.",
      };
    }
    // action === 'end'
    const existing = getLoopState();
    if (!existing) {
      throw new Error('dream_review: no review loop is currently active');
    }
    if (existing.agent !== ctx.agent) {
      throw new Error(
        `dream_review: the active loop is held by a different agent ('${existing.agent}'); ` +
          'cannot close it from this agent.',
      );
    }
    if (existing.dreamId !== input.dream_id) {
      throw new Error(
        `dream_review: the active loop is for dream_id='${existing.dreamId}', not '${input.dream_id}'.`,
      );
    }
    const summary = (input.summary ?? '').trim();
    if (!summary) {
      throw new Error(
        "dream_review: action='end' requires a non-empty `summary` describing what happened to " +
          'each finding. Do not silently drop findings.',
      );
    }
    // Mark any still-pending findings as dismissed (the loop is over —
    // they were either addressed in conversation or deferred, both
    // captured in the summary). User can re-open by triggering Lucid
    // anew.
    const now = new Date().toISOString();
    let stillPending = 0;
    for (const f of run.findings) {
      if (f.status === 'pending') {
        f.status = 'dismissed';
        f.resolved_at = now;
        stillPending++;
      }
    }
    setRunStatus(run, 'processed');
    // Stash the loop summary into the run record itself so the audit
    // trail in processed/ is self-contained.
    (run as unknown as Record<string, unknown>).loop_summary = summary;
    (run as unknown as Record<string, unknown>).loop_held_by = ctx.agent;
    (run as unknown as Record<string, unknown>).loop_started_at = existing.startedAt;
    (run as unknown as Record<string, unknown>).loop_ended_at = now;
    await writeLucidRun(run);
    try {
      await rename(runFilePath(run.id, false), runFilePath(run.id, true));
    } catch (err) {
      // ENOENT is fine — could already be archived; otherwise surface.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }
    clearLoopState();
    return {
      action: 'end',
      dream_id: input.dream_id,
      agent: ctx.agent,
      auto_dismissed_pending: stillPending,
      summary,
      message:
        'Loop closed, run archived to processed/, lock released. Wiki tools and the hidden ' +
        'toolsets revert to normal on the next turn.',
    };
  },
};

// ── Bundle ────────────────────────────────────────────────────────────

export function dreamTools(): ToolDefinition[] {
  return [dreamList, dreamGet, dreamApply, dreamDismiss, dreamRun, dreamReview] as ToolDefinition[];
}
