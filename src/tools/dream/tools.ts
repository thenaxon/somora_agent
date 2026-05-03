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

// ── Bundle ────────────────────────────────────────────────────────────

export function dreamTools(): ToolDefinition[] {
  return [dreamList, dreamGet, dreamApply, dreamDismiss] as ToolDefinition[];
}
