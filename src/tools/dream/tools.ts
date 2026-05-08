// Dream-Mode tool surface (Phase 2-Stufe-D, DECISIONS pending). Lets the
// agent walk pending dreams with the user step-by-step, applying or
// dismissing each finding. dream_apply translates a finding into the
// equivalent memory_* action — no creative logic at apply-time, just
// confirmation of the extractor's proposal.
//
//   dream_list                — overview of pending (non-processed) dreams
//   dream_get(id)             — full content + per-finding state
//   dream_apply(id, fid)      — execute a finding's action; auto-archive
//                                when all findings resolved
//   dream_dismiss(id, fid?)   — reject a single finding; without fid:
//                                whole dream dismissed

import { z } from 'zod';
import {
  dismissEntireDream,
  listDreams,
  readDreamById,
  updateFindingStatus,
} from '../../dream/storage.ts';
import type { Finding } from '../../dream/types.ts';
import type { ToolDefinition } from '../types.ts';
import type { WikiPromotionWorker } from '../../wiki/auto-worker.ts';
import type { WikiLintWorker } from '../../wiki/lint-worker.ts';
import {
  dismissEntireLintRun,
  listLintRuns,
  readLintRunById,
  updateLintFindingStatus,
} from '../../wiki/lint-storage.ts';
import type { LintFinding, LintRun } from '../../wiki/lint-types.ts';
import { applyLintFinding } from '../../wiki/lint-actions.ts';
import { resolveObsidianSource } from '../../memory/registry.ts';
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
    'List pending dreams awaiting user review. Returns both per-agent memory dreams (Dream-A: ' +
    "atomic findings from your sessions, scoped to YOUR agent) and global wiki-lint runs (Dream-C: " +
    'cleanup suggestions for the shared wiki, same for every agent). Each entry has a `kind` field ' +
    "= 'memory' or 'wiki_lint' so the agent can describe them differently to the user. " +
    'Pass include_processed=true to also see already-resolved entries. Use this first when the user ' +
    'asks "hast du was geträumt?" or "gibt\'s was zum aufräumen?" — pick the oldest and walk through ' +
    'it with `dream_get`.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {
      include_processed: {
        type: 'boolean',
        description: 'Include dreams/lint runs whose findings have all been resolved (default false).',
      },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const includeProcessed = input.include_processed === true;
    const memoryDreams = await listDreams(ctx.agent, { includeProcessed });
    const lintRuns = await listLintRuns({ includeProcessed });
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
    const lintEntries = lintRuns.map((r) => ({
      id: r.id,
      kind: 'wiki_lint' as const,
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
      count: memEntries.length + lintEntries.length,
      by_kind: { memory: memEntries.length, wiki_lint: lintEntries.length },
      dreams: [...memEntries, ...lintEntries],
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
    'per-finding status. Works for both memory dreams (kind=memory, per-agent) and wiki-lint runs ' +
    "(kind=wiki_lint, global). The output's `kind` field tells the agent which type so it can " +
    'describe findings appropriately. Use after `dream_list`.',
  inputSchema: GetInput,
  jsonSchema: {
    type: 'object',
    properties: {
      dream_id: { type: 'string', description: 'The id of the dream/lint run to retrieve.' },
    },
    required: ['dream_id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    // Try memory-dream first; fall back to lint run.
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
    const lintRun = await readLintRunById(input.dream_id);
    if (lintRun) {
      return {
        id: lintRun.id,
        kind: 'wiki_lint' as const,
        trigger: lintRun.trigger,
        status: lintRun.status,
        created_at: lintRun.created_at,
        completed_at: lintRun.completed_at,
        processed_at: lintRun.processed_at,
        pages_scanned: lintRun.pages_scanned,
        ...(lintRun.error ? { error: lintRun.error } : {}),
        findings: lintRun.findings,
        pending_count: lintRun.findings.filter((f) => f.status === 'pending').length,
      };
    }
    throw new Error(`dream '${input.dream_id}' not found (checked memory + wiki-lint)`);
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
    // Fall through to lint run.
    const lintRun = await readLintRunById(input.dream_id);
    if (lintRun) {
      return await applyLintFindingFromRun(lintRun, input.dream_id, input.finding_id, ctx);
    }
    // Neither store has it — provide both kinds of valid ids for self-correction.
    const memDreams = await listDreams(ctx.agent);
    const lintRuns = await listLintRuns();
    const known = [
      ...memDreams.map((d) => `'${d.meta.id}' (memory)`),
      ...lintRuns.map((r) => `'${r.id}' (wiki_lint)`),
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
        description: `vault hint acknowledged (no auto-write to vault from agents — Dream-B/C handle vault)`,
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

async function applyLintFindingFromRun(
  lintRun: LintRun,
  runId: string,
  findingId: number,
  ctx: import('../types.ts').ToolContext,
): Promise<unknown> {
  const finding: LintFinding | undefined = lintRun.findings.find((f) => f.id === findingId);
  if (!finding) {
    const validIds = lintRun.findings.map((f) => f.id);
    throw new Error(
      `finding ${findingId} not in lint run '${runId}'. Valid finding ids: ${
        validIds.length ? validIds.join(', ') : '(none)'
      }. Note: finding ids start at 1, not 0.`,
    );
  }
  if (finding.status !== 'pending') {
    throw new Error(
      `finding ${findingId} is already ${finding.status} (resolved at ${finding.resolved_at ?? 'unknown'})`,
    );
  }
  // Resolve wiki abs path from server config.
  const obs = resolveObsidianSource(ctx.config.obsidian);
  if (!obs?.vaultPath) {
    throw new Error('lint apply: no obsidian vault configured');
  }
  const wikiAbs = join(obs.vaultPath, ctx.config.wiki.vaultSubfolder);
  const outcome = await applyLintFinding(finding, { wikiAbs });
  if (outcome.kind === 'failed') {
    throw new Error(`lint apply failed: ${outcome.error}`);
  }
  // Mark applied or dismissed-effectively (skipped → still mark applied
  // so the dream advances; user dismisses if they want to keep open)
  const newStatus = outcome.kind === 'applied' ? 'applied' : 'applied'; // skipped also closes the slot
  const result = await updateLintFindingStatus(runId, 'completed', findingId, newStatus);
  const remaining = result?.findings.filter((f) => f.status === 'pending').length ?? 0;
  return {
    kind: 'wiki_lint',
    applied: outcome.kind === 'applied',
    finding: `#${finding.id} ${finding.kind}`,
    executed: outcome.kind === 'applied' ? outcome.description : `skipped: ${outcome.reason}`,
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
    // Fall through to lint run.
    const lintRun = await readLintRunById(input.dream_id);
    if (lintRun) {
      if (input.finding_id !== undefined) {
        if (!lintRun.findings.some((f) => f.id === input.finding_id)) {
          const validIds = lintRun.findings.map((f) => f.id);
          throw new Error(
            `finding ${input.finding_id} not in lint run '${input.dream_id}'. Valid finding ids: ${
              validIds.length ? validIds.join(', ') : '(none)'
            }. Note: finding ids start at 1, not 0.`,
          );
        }
        const result = await updateLintFindingStatus(
          input.dream_id,
          'completed',
          input.finding_id,
          'dismissed',
        );
        const remaining = result?.findings.filter((f) => f.status === 'pending').length ?? 0;
        return {
          kind: 'wiki_lint',
          dismissed: true,
          finding_id: input.finding_id,
          remaining,
          dream_done: remaining === 0,
        };
      }
      const result = await dismissEntireLintRun(input.dream_id);
      const dismissedCount = result?.findings.filter((f) => f.status === 'dismissed').length ?? 0;
      return {
        kind: 'wiki_lint',
        dismissed: true,
        whole_dream: true,
        dismissed_count: dismissedCount,
        dream_done: true,
      };
    }
    // Neither — list valid ids
    const memDreams = await listDreams(ctx.agent);
    const lintRuns = await listLintRuns();
    const known = [
      ...memDreams.map((d) => `'${d.meta.id}' (memory)`),
      ...lintRuns.map((r) => `'${r.id}' (wiki_lint)`),
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
// Manual trigger for Dream-B (memory→wiki promotion) and (later) Dream-C
// (lint). Single tool with `mode` arg covers both modes — keeps the
// dream_*-Toolset tight. See `private/wiki-design.md` § Tool-Surface.

interface DreamRunDeps {
  wikiPromotionWorker: WikiPromotionWorker;
  wikiLintWorker: WikiLintWorker;
}

let injectedDreamRunDeps: DreamRunDeps | null = null;

/** Server boot wires the WikiPromotionWorker reference here so the
 *  in-process tool handler can call runNow() directly. The MCP child
 *  doesn't get this — it falls back to the HTTP endpoint. */
export function configureDreamRunTool(deps: DreamRunDeps): void {
  injectedDreamRunDeps = deps;
}

const RunInput = z.object({
  mode: z.enum(['b', 'c']).optional(),
  wait: z.boolean().optional(),
});

export const dreamRun: ToolDefinition<z.infer<typeof RunInput>> = {
  name: 'dream_run',
  toolset: 'dream',
  description:
    'Manually trigger a Dream-Worker run.\n' +
    '\n' +
    "mode='b' (default): Dream-B promotion — reads each agent's short-term memory, " +
    'decides which entries are wiki-worthy, writes them as consolidated wiki pages with ' +
    'cross-references, replaces source memory files with stubs. Stubs that have new ' +
    '"Recent observations" since their last promotion get merged into the existing wiki page.\n' +
    "mode='c' (Phase 4 Stufe 5, not implemented yet): Dream-C lint — periodic wiki health-check " +
    'for contradictions, stale claims, broken links, orphans.\n' +
    '\n' +
    'CALLING CONVENTION — read carefully:\n' +
    '\n' +
    '* Default is fire-and-forget. Just call dream_run({}) (or dream_run({mode:"b"})). ' +
    'The run starts in the background and the tool returns IMMEDIATELY with ' +
    '`{started: true}` — same pattern as /reset triggering Dream-A. Hand the response ' +
    'back to the user, the conversation continues, the run finishes in 1-3 minutes ' +
    'in the background. The user will see results via their Obsidian Vault (wiki/index.md ' +
    'gets regenerated, monthly logs/ get appended).\n' +
    '\n' +
    '* DO NOT pass wait:true unless the user EXPLICITLY says "warte bis fertig" / ' +
    '"block until done" / "lauf synchron" / equivalent. ' +
    'Asking the user "did this run?" or wanting to give a comprehensive summary in your ' +
    'reply is NOT a reason to use wait:true — the agent-blocking duration (1-3 minutes ' +
    'against opus) is bad UX. The async response is the correct response in 99% of cases.\n' +
    '\n' +
    "* Use sparingly — Dream-B's scheduler runs every 12h by default. Manual triggers " +
    'are for "I just added several substantial memory notes and want them in the wiki now".',
  inputSchema: RunInput,
  jsonSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['b', 'c'],
        description:
          "Which Dream worker to fire. Default 'b' (memory→wiki promotion). 'c' (lint) " +
          'is reserved for Phase-4 Stufe 5; calling it today errors out cleanly.',
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
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const mode = input.mode ?? 'b';
    const wait = input.wait ?? false;
    if (!ctx.config.wiki.enabled) {
      throw new Error('config.wiki.enabled is false — wiki layer not active');
    }
    if (mode === 'c') {
      // Dream-C / wiki lint.
      if (injectedDreamRunDeps) {
        if (!wait) {
          void injectedDreamRunDeps.wikiLintWorker.runNow().catch(() => {
            /* errors logged in worker */
          });
          return {
            mode: 'c',
            started: true,
            wait: false,
            message:
              'Dream-C lint started in background. Check ~/.somora/wiki-lint/ for the run report ' +
              "or call dream_list to see findings once it's complete (~5-30s for a small wiki).",
            via: 'in-process',
          };
        }
        const result = await injectedDreamRunDeps.wikiLintWorker.runNow();
        return {
          mode: 'c',
          wait: true,
          runId: result.runId,
          findingsCount: result.findingsCount,
          pagesScanned: result.pagesScanned,
          durationMs: result.durationMs,
          status: result.status,
          via: 'in-process',
        };
      }
      // MCP child fallback: HTTP
      return runDreamCViaHttp(wait);
    }
    // mode === 'b' — Dream-B promotion run.
    if (injectedDreamRunDeps) {
      if (!wait) {
        // Fire-and-forget. Errors during the run land in logs only.
        void injectedDreamRunDeps.wikiPromotionWorker.runNow().catch(() => {
          /* error already logged in worker */
        });
        return {
          mode: 'b',
          started: true,
          wait: false,
          message:
            'Dream-B started in background. Check ~/.somora/logs/server-*.log for ' +
            "'wiki.dream_b.done', or inspect <vault>/<wiki-subfolder>/index.md after ~1-3min.",
          via: 'in-process',
        };
      }
      // wait=true — sync, return outcomes
      const result = await injectedDreamRunDeps.wikiPromotionWorker.runNow();
      const counts = result.outcomes.reduce(
        (acc, o) => {
          acc[o.kind] = (acc[o.kind] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      return {
        mode: 'b',
        wait: true,
        candidatesSeen: result.candidatesSeen,
        durationMs: result.durationMs,
        counts,
        outcomes: result.outcomes,
        via: 'in-process',
      };
    }
    // MCP child fallback: hit the main server's HTTP endpoint.
    return runDreamBViaHttp(wait);
  },
};

async function runDreamBViaHttp(wait: boolean): Promise<unknown> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const url = `http://${host}:${port}/wiki/run-promotion`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wait }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`dream_run HTTP fallback ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return { mode: 'b', ...data, via: 'http' };
}

async function runDreamCViaHttp(wait: boolean): Promise<unknown> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const url = `http://${host}:${port}/wiki/run-lint`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wait }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`dream_run mode=c HTTP fallback ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return { mode: 'c', ...data, via: 'http' };
}

// ── Bundle ────────────────────────────────────────────────────────────

export function dreamTools(): ToolDefinition[] {
  return [dreamList, dreamGet, dreamApply, dreamDismiss, dreamRun] as ToolDefinition[];
}
