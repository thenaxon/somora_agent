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
    'List pending dreams (extracted findings awaiting user review). Pass include_processed=true ' +
    'to also see already-resolved dreams. Use this first when the user asks "did you have any dreams?" — ' +
    'pick the oldest and walk through it with `dream_get`.',
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
    const all = await listDreams(ctx.agent, { includeProcessed });
    return {
      count: all.length,
      dreams: all.map((d) => ({
        id: d.meta.id,
        trigger: d.meta.trigger,
        source_session: d.meta.source_session,
        status: d.meta.status,
        created_at: d.meta.created_at,
        completed_at: d.meta.completed_at,
        findings_total: d.meta.findings.length,
        findings_pending: d.meta.findings.filter((f) => f.status === 'pending').length,
        findings_applied: d.meta.findings.filter((f) => f.status === 'applied').length,
        findings_dismissed: d.meta.findings.filter((f) => f.status === 'dismissed').length,
      })),
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
    'Fetch the full content of a dream — all findings with their proposed actions, current memory ' +
    'excerpts, reasons, and per-finding status. Use after `dream_list` to start walking through a dream ' +
    'with the user.',
  inputSchema: GetInput,
  jsonSchema: {
    type: 'object',
    properties: {
      dream_id: { type: 'string', description: 'The id of the dream to retrieve.' },
    },
    required: ['dream_id'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const file = await readDreamById(ctx.agent, input.dream_id);
    if (!file) throw new Error(`dream '${input.dream_id}' not found`);
    return {
      id: file.meta.id,
      trigger: file.meta.trigger,
      source_session: file.meta.source_session,
      status: file.meta.status,
      created_at: file.meta.created_at,
      completed_at: file.meta.completed_at,
      processed_at: file.meta.processed_at,
      worker_model_ref: file.meta.worker_model_ref,
      ...(file.meta.error ? { error: file.meta.error } : {}),
      findings: file.meta.findings,
      pending_count: file.meta.findings.filter((f) => f.status === 'pending').length,
    };
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
    const file = await readDreamById(ctx.agent, input.dream_id);
    if (!file) {
      // Tell the model exactly which ids ARE valid so it can self-correct
      // — small models tend to invent ids on follow-up calls otherwise.
      const all = await listDreams(ctx.agent);
      const known = all.map((d) => d.meta.id);
      throw new Error(
        `dream '${input.dream_id}' not found. Valid pending dream ids: ${
          known.length ? known.map((k) => `'${k}'`).join(', ') : '(none — call dream_list first)'
        }`,
      );
    }
    const finding = file.meta.findings.find((f) => f.id === input.finding_id);
    if (!finding) {
      const validIds = file.meta.findings.map((f) => f.id);
      throw new Error(
        `finding ${input.finding_id} not in dream '${input.dream_id}'. Valid finding ids: ${
          validIds.length ? validIds.join(', ') : '(none)'
        }. Note: finding ids start at 1, not 0.`,
      );
    }
    if (finding.status !== 'pending') {
      throw new Error(
        `finding ${input.finding_id} is already ${finding.status} (resolved at ${finding.resolved_at ?? 'unknown'})`,
      );
    }

    // Execute the finding's action. We delegate to the MemoryManager
    // directly — we already have it scoped to this agent via the
    // ToolContext. Note: vault_hint is no-op (we surface it to the user
    // for visibility but can't auto-write to the vault without an
    // obsidian_write tool, which is future work).
    const mgr = await ctx.getMemoryManager();
    let executed: { description: string };
    switch (finding.action) {
      case 'memory_write': {
        if (!finding.proposed_content) {
          throw new Error(`finding ${input.finding_id}: memory_write needs proposed_content`);
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
          throw new Error(`finding ${input.finding_id}: memory_edit needs proposed_content`);
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
        // No-op auto-action; we just acknowledge so the dream can move on.
        executed = {
          description: `vault hint acknowledged (no auto-write — you can update vault/${finding.slug} yourself)`,
        };
        break;
      }
      default: {
        throw new Error(`finding ${input.finding_id}: unknown action '${(finding as { action: string }).action}'`);
      }
    }

    const result = await updateFindingStatus(ctx.agent, input.dream_id, input.finding_id, 'applied');
    const remaining = result.dream.meta.findings.filter((f) => f.status === 'pending').length;
    return {
      applied: true,
      finding: findingSummary(finding),
      executed: executed.description,
      remaining,
      dream_done: result.allResolved,
    };
  },
};

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
    // Mirror dream_apply's id-validation error path so small models can
    // self-correct on hallucinated ids.
    const file = await readDreamById(ctx.agent, input.dream_id);
    if (!file) {
      const all = await listDreams(ctx.agent);
      const known = all.map((d) => d.meta.id);
      throw new Error(
        `dream '${input.dream_id}' not found. Valid pending dream ids: ${
          known.length ? known.map((k) => `'${k}'`).join(', ') : '(none — call dream_list first)'
        }`,
      );
    }
    if (input.finding_id !== undefined) {
      if (!file.meta.findings.some((f) => f.id === input.finding_id)) {
        const validIds = file.meta.findings.map((f) => f.id);
        throw new Error(
          `finding ${input.finding_id} not in dream '${input.dream_id}'. Valid finding ids: ${
            validIds.length ? validIds.join(', ') : '(none)'
          }. Note: finding ids start at 1, not 0.`,
        );
      }
      const result = await updateFindingStatus(ctx.agent, input.dream_id, input.finding_id, 'dismissed');
      const remaining = result.dream.meta.findings.filter((f) => f.status === 'pending').length;
      return {
        dismissed: true,
        finding_id: input.finding_id,
        remaining,
        dream_done: result.allResolved,
      };
    }
    const result = await dismissEntireDream(ctx.agent, input.dream_id);
    return {
      dismissed: true,
      whole_dream: true,
      dismissed_count: result.dismissedCount,
      dream_done: true,
    };
  },
};

// ── dream_run ─────────────────────────────────────────────────────────
//
// Manual trigger for Dream-B (memory→wiki promotion) and (later) Dream-C
// (lint). Single tool with `mode` arg covers both modes — keeps the
// dream_*-Toolset tight. See `private/wiki-design.md` § Tool-Surface.

interface DreamRunDeps {
  wikiPromotionWorker: WikiPromotionWorker;
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
    'Manually trigger a Dream-Worker run. ' +
    "mode='b' (default): Dream-B promotion — reads each agent's short-term memory, " +
    'decides which entries are wiki-worthy, writes them as consolidated wiki pages with ' +
    'cross-references, replaces source memory files with stubs. Stubs that have new ' +
    '"Recent observations" since their last promotion get merged into the existing wiki page. ' +
    "mode='c' (Phase 4 Stufe 5, not implemented yet): Dream-C lint — periodic wiki health-check " +
    'for contradictions, stale claims, broken links, orphans. ' +
    'wait (default false): when false, the run starts in the background and the tool returns ' +
    'immediately — same pattern as /reset triggering Dream-A. The user can inspect outcomes ' +
    'later via the wiki/index.md, the monthly logs/, or by tailing server logs for ' +
    "`wiki.dream_b.done`. When wait=true, the call blocks until the run finishes and returns " +
    'the full outcome counts (useful for debugging or when the user explicitly wants to see ' +
    'the result before continuing). ' +
    "Use sparingly — Dream-B's scheduler runs every 12h by default.",
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
          'When true, block until the run finishes and return outcome counts. ' +
          'Default false: kick off in background, return immediately. Match /reset semantics.',
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
      throw new Error("dream_run mode='c' (lint) not implemented yet (Phase-4 Stufe 5)");
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

// ── Bundle ────────────────────────────────────────────────────────────

export function dreamTools(): ToolDefinition[] {
  return [dreamList, dreamGet, dreamApply, dreamDismiss, dreamRun] as ToolDefinition[];
}
