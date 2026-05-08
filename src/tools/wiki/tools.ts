// Wiki tools — user-triggerable operations on the Phase-4 wiki layer.
//
// Tools so far:
//   - wiki_run_promotion  — manual Dream-B trigger
//   - wiki_status         — last-run summary, scheduler state
//
// Future (Stufe 5+6):
//   - wiki_run_lint       — manual Dream-C trigger
//   - wiki_bootstrap      — one-time migration of existing memories
//
// Tools are configured via `configureWikiTools` from server boot so
// they can call into the singleton WikiPromotionWorker.

import { z } from 'zod';

import type { WikiPromotionWorker } from '../../wiki/auto-worker.ts';
import type { ToolDefinition } from '../types.ts';

interface WikiDeps {
  wikiPromotionWorker: WikiPromotionWorker;
}

let injectedDeps: WikiDeps | null = null;

export function configureWikiTools(deps: WikiDeps): void {
  injectedDeps = deps;
}

// ── wiki_run_promotion ────────────────────────────────────────────

const RunPromotionInput = z.object({});

export const wikiRunPromotion: ToolDefinition<z.infer<typeof RunPromotionInput>> = {
  name: 'wiki_run_promotion',
  toolset: 'wiki',
  description:
    'Manually trigger a Dream-B promotion run RIGHT NOW (instead of waiting for the next scheduled cycle). ' +
    'Dream-B reads each agent\'s short-term memory, decides which entries are wiki-worthy, writes them as ' +
    'consolidated wiki pages with cross-references, and replaces the source memory file with a stub. ' +
    'Stubs that have new "Recent observations" since their last promotion get merged into the existing ' +
    'wiki page. Returns a summary with counts of promoted/merged/skipped/failed candidates. ' +
    'Use sparingly — the scheduler runs Dream-B every 12h by default. Useful right after the user has ' +
    'added several substantial memory notes and wants them in the shared wiki immediately.',
  inputSchema: RunPromotionInput,
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_input, ctx) {
    if (!ctx.config.wiki.enabled) {
      throw new Error('config.wiki.enabled is false — wiki layer not active');
    }
    if (!injectedDeps) {
      throw new Error('wiki tools not configured (server boot did not call configureWikiTools)');
    }
    const result = await injectedDeps.wikiPromotionWorker.runNow();
    const counts = result.outcomes.reduce(
      (acc, o) => {
        acc[o.kind] = (acc[o.kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    return {
      candidatesSeen: result.candidatesSeen,
      durationMs: result.durationMs,
      counts,
      outcomes: result.outcomes.map((o) => ({
        kind: o.kind,
        agent: o.agent,
        memorySlug: o.memorySlug,
        ...('wikiPath' in o ? { wikiPath: o.wikiPath } : {}),
        ...('logSummary' in o ? { logSummary: o.logSummary } : {}),
        ...('observationsConsumed' in o ? { observationsConsumed: o.observationsConsumed } : {}),
        ...('reason' in o ? { reason: o.reason } : {}),
        ...('error' in o ? { error: o.error } : {}),
      })),
    };
  },
};

// ── wiki_status ────────────────────────────────────────────────────

const StatusInput = z.object({});

export const wikiStatus: ToolDefinition<z.infer<typeof StatusInput>> = {
  name: 'wiki_status',
  toolset: 'wiki',
  description:
    'Return the configured wiki layer state: enabled flag, vault subfolder, scheduler interval, ' +
    'and which model is configured for promotion. Read-only; does not trigger any operation. ' +
    'Use this when the user asks how the wiki is configured or when troubleshooting.',
  inputSchema: StatusInput,
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_input, ctx) {
    return {
      enabled: ctx.config.wiki.enabled,
      vaultSubfolder: ctx.config.wiki.vaultSubfolder,
      defaultSubdirs: ctx.config.wiki.defaultSubdirs,
      promotion: {
        enabled: ctx.config.wiki.promotion.enabled,
        intervalHours: ctx.config.wiki.promotion.intervalHours,
        preSweepMinutes: ctx.config.wiki.promotion.preSweepMinutes,
        model: ctx.config.wiki.promotion.model ?? null,
        requireApproval: ctx.config.wiki.promotion.requireApproval,
      },
      lint: {
        enabled: ctx.config.wiki.lint.enabled,
        intervalDays: ctx.config.wiki.lint.intervalDays,
        model: ctx.config.wiki.lint.model ?? null,
        requireApproval: ctx.config.wiki.lint.requireApproval,
        approvalAgent: ctx.config.wiki.lint.approvalAgent,
      },
      search: ctx.config.wiki.search,
    };
  },
};

// ── bundle ─────────────────────────────────────────────────────────

export function wikiTools(): ToolDefinition[] {
  return [wikiRunPromotion, wikiStatus] as ToolDefinition[];
}
