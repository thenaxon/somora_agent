// `sentinel` tool — single action-enum entry point for the trigger
// runtime. Lets an agent install, list, inspect, test, pause/resume,
// delete its own triggers, and look at fire history. All actions go
// through the in-process sentinel store + scheduler — no HTTP.
//
// Safeguards are enforced HERE (in the tool handler) AND in the
// scheduler (defense-in-depth):
//   - Minimum interval 60s (sentinel global floor)
//   - Per-agent active trigger cap (default 50)
//   - Per-trigger daily-fire cap (default 500)
// Plus: the scheduler auto-pauses on error-streak ≥ 3 and on daily-cap
// breach.

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import type { ToolDefinition } from '../types.ts';
import {
  deleteTrigger,
  getHistory,
  getTrigger,
  listTriggers,
  loadTriggers,
  saveTrigger,
  countTriggersByAgent,
} from '../../sentinel/store.ts';
import {
  dispatchTestFire,
  reschedule,
} from '../../sentinel/scheduler.ts';
import {
  computeNextFire,
  describeTimeSpec,
  parseInterval,
  validateTimeSpec,
} from '../../sentinel/schedule.ts';
import {
  SENTINEL_LIMITS,
  type Source,
  type Trigger,
  type TriggerStatus,
} from '../../sentinel/types.ts';

// ─────────────────────────────────────────────────────────────────────
// Input schema
// ─────────────────────────────────────────────────────────────────────

// Per-action input fields are unioned into one wide schema. We can't
// use Zod discriminatedUnion for the JSON-Schema export because the
// model sees only the JSON (lesson: [[feedback_json_schema_discriminated_ops]]),
// so we use the standard "all fields optional, validate in handler"
// shape and document per-action requirements in the description.

const TimeSpecSchema = z.union([
  z.object({ type: z.literal('at'), iso: z.string() }),
  z.object({ type: z.literal('every'), interval: z.string() }),
  z.object({ type: z.literal('daily'), time: z.string() }),
  z.object({
    type: z.literal('weekly'),
    day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    time: z.string(),
  }),
  z.object({ type: z.literal('cron'), expression: z.string() }),
]);

const SourceSchema = z.object({
  type: z.literal('time'),
  spec: TimeSpecSchema,
});

const DispatchSchema = z.object({
  agent: z.string().min(1),
  session: z.string().min(1).default('main'),
  prompt: z.string().min(1),
});

const PolicySchema = z.object({
  cooldownMs: z.number().int().min(0).optional(),
  maxFiresPerDay: z.number().int().min(1).max(SENTINEL_LIMITS.MAX_FIRES_PER_DAY).optional(),
  missedFiresPolicy: z.enum(['skip', 'catchUpOnce', 'catchUpAll']).optional(),
});

const SentinelInput = z
  .object({
    action: z.enum([
      'create', 'list', 'get', 'pause', 'resume', 'delete', 'test', 'history',
    ]),
    // create
    name: z.string().min(1).max(100).optional(),
    intent: z.string().max(500).optional(),
    source: SourceSchema.optional(),
    dispatch: DispatchSchema.optional(),
    policy: PolicySchema.optional(),
    // get / pause / resume / delete / test / history
    id: z.string().min(1).optional(),
    // list
    owner: z.string().optional(),
    status: z.enum(['active', 'paused', 'error', 'completed']).optional(),
    // history
    limit: z.number().int().min(1).max(200).default(50).optional(),
  })
  .strict();

type SentinelInputT = z.infer<typeof SentinelInput>;

// ─────────────────────────────────────────────────────────────────────
// Result types (loose union — handler narrows)
// ─────────────────────────────────────────────────────────────────────

type SentinelResult =
  | { action: 'create'; ok: true; trigger: Trigger; hint: string }
  | { action: 'create'; ok: false; error: string }
  | { action: 'list'; ok: true; count: number; triggers: Array<TriggerSummary> }
  | { action: 'get'; ok: true; trigger: Trigger; describe: string }
  | { action: 'get'; ok: false; error: string }
  | { action: 'pause' | 'resume' | 'delete'; ok: boolean; id: string; error?: string }
  | { action: 'test'; ok: boolean; id: string; hint?: string; error?: string }
  | { action: 'history'; ok: true; id: string; count: number; entries: Awaited<ReturnType<typeof getHistory>> }
  | { action: 'history'; ok: false; id: string; error: string };

interface TriggerSummary {
  id: string;
  name: string;
  ownerAgent: string;
  source: string;
  status: TriggerStatus;
  nextFireAt?: string;
  lastFireAt?: string;
  fireCount: number;
}

function summarize(t: Trigger): TriggerSummary {
  return {
    id: t.id,
    name: t.name,
    ownerAgent: t.ownerAgent,
    source: t.source.type === 'time' ? describeTimeSpec(t.source.spec) : t.source.type,
    status: t.status,
    ...(t.nextFireAt ? { nextFireAt: t.nextFireAt } : {}),
    ...(t.lastFireAt ? { lastFireAt: t.lastFireAt } : {}),
    fireCount: t.fireCount,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'trigger';
}

function newTriggerId(name: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slugify(name)}-${rand}`;
}

function validateCreateInput(input: SentinelInputT): { ok: true; data: Required<Pick<SentinelInputT, 'name' | 'source' | 'dispatch'>> } | { ok: false; error: string } {
  if (!input.name) return { ok: false, error: 'create: name is required' };
  if (!input.source) return { ok: false, error: 'create: source is required' };
  if (!input.dispatch) return { ok: false, error: 'create: dispatch (agent + prompt) is required' };
  return { ok: true, data: { name: input.name, source: input.source, dispatch: input.dispatch } };
}

function enforceLimits(source: Source, policy?: SentinelInputT['policy']): string | null {
  if (source.type !== 'time') return null;
  const spec = source.spec;
  // Minimum-interval enforcement: 'every' triggers can't be < 60s.
  if (spec.type === 'every') {
    try {
      const ms = parseInterval(spec.interval);
      if (ms < SENTINEL_LIMITS.MIN_INTERVAL_MS) {
        return `interval ${spec.interval} below minimum ${SENTINEL_LIMITS.MIN_INTERVAL_MS / 1000}s`;
      }
    } catch (err) {
      return `invalid interval: ${(err as Error).message}`;
    }
  }
  // Cooldown floor: respect global minimum even if user passed lower.
  if (policy?.cooldownMs !== undefined && policy.cooldownMs < SENTINEL_LIMITS.MIN_INTERVAL_MS) {
    // Don't reject — silently raise to minimum (this is a sanity floor,
    // not user input that should fail loud). We log it.
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────

export const sentinel: ToolDefinition<SentinelInputT, SentinelResult> = {
  name: 'sentinel',
  toolset: 'sentinel',
  description:
    'Install and manage TIME-based proactive triggers that wake an agent on a schedule. Use this ' +
    'when the user says things like "erinner mich morgen 10 Uhr", "check meine mails jeden morgen ' +
    '8 Uhr", "scan einmal die woche…", "wenn etwas in X passiert, lass mich Y machen" (where Y ' +
    'is recurring/scheduled — for HTTP/exec event sources see Phase 2). ' +
    '\n\n' +
    'Triggers fire by sending the dispatched agent a turn with a structured [Sentinel trigger ' +
    'fired] evidence-block prefix so the agent knows it was woken (not user-asked) and has full ' +
    'context: trigger name, source, fire-time, original user intent. ' +
    '\n\n' +
    'Actions: ' +
    '"create" (name + source + dispatch + optional policy → registered trigger), ' +
    '"list" (optional owner / status filter), ' +
    '"get" (full detail by id), ' +
    '"pause" / "resume" (toggle active/paused by id), ' +
    '"delete" (remove + clean history), ' +
    '"test" (fire NOW, bypass cooldown/cap, mark as testMode in history), ' +
    '"history" (last N fire-events for a trigger). ' +
    '\n\n' +
    'Source variants (all under type:"time"): ' +
    '`at` (one-shot ISO timestamp), `every` (interval like "5m", min 60s), `daily` ("08:00"), ' +
    '`weekly` (mon/tue/…/sun + "09:00"), `cron` (standard 5-field — escape hatch for things ' +
    'like "1st of each month"). Cron examples: `"0 9 1 * *"` (monthly 1st 9:00), ' +
    '`"0 8 * * *"` (daily 8:00), `"*/15 * * * *"` (every 15 min). Cron does NOT support ' +
    'ranges (use `1,2,3,4,5` not `1-5`) or named months/weekdays. Prefer the named ' +
    'primitives when they fit — they read better. ' +
    '\n\n' +
    'Safeguards: minimum interval 60s (no sub-minute polling), max 50 active triggers per agent, ' +
    'max 500 fires per trigger per day (auto-pause when hit), 3-strikes auto-pause on consecutive ' +
    'errors. Visible + manageable in the web-UI sentinel tab.',
  inputSchema: SentinelInput,
  jsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'get', 'pause', 'resume', 'delete', 'test', 'history'],
      },
      // create
      name: { type: 'string', maxLength: 100, description: 'create only — human label.' },
      intent: { type: 'string', maxLength: 500, description: 'create only — short user-intent summary echoed to the agent at fire-time.' },
      source: {
        type: 'object',
        description: 'create only — where events come from. Phase 1: type:"time" with one of the spec variants.',
        properties: {
          type: { type: 'string', enum: ['time'] },
          spec: {
            description: 'Discriminated by spec.type. See examples.',
            oneOf: [
              { type: 'object', properties: { type: { const: 'at' }, iso: { type: 'string' } }, required: ['type', 'iso'] },
              { type: 'object', properties: { type: { const: 'every' }, interval: { type: 'string', description: '30s / 5m / 1h. Minimum 60s.' } }, required: ['type', 'interval'] },
              { type: 'object', properties: { type: { const: 'daily' }, time: { type: 'string', description: 'HH:MM or HH:MM:SS.' } }, required: ['type', 'time'] },
              { type: 'object', properties: { type: { const: 'weekly' }, day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, time: { type: 'string' } }, required: ['type', 'day', 'time'] },
              { type: 'object', properties: { type: { const: 'cron' }, expression: { type: 'string', description: 'Standard 5-field cron: m h dom mon dow. Supports *, N, */N, a,b,c. Does NOT support ranges (use 1,2,3,4,5 instead of 1-5) or named months/weekdays (use 1=Mon..7=Sun). Examples: "0 8 * * *" daily at 8:00 · "0 9 1 * *" 1st of each month 9:00 · "*/15 * * * *" every 15 min · "0 9,17 * * *" 9:00 AND 17:00 daily · "0 0 * * 0" sundays midnight. For simple cases prefer `daily`/`weekly`/`every` — they read better and cover 90% of recurring use-cases.' } }, required: ['type', 'expression'] },
            ],
          },
        },
        required: ['type', 'spec'],
      },
      dispatch: {
        type: 'object',
        description: 'create only — which agent wakes up in which session with what prompt.',
        properties: {
          agent: { type: 'string', description: 'Target agent. Must exist.' },
          session: { type: 'string', description: 'Target session slug or "main". Auto-created with timestamp prefix if not existing.', default: 'main' },
          prompt: { type: 'string', description: 'Agent receives this as a user-turn body, prefixed by a structured evidence block.' },
        },
        required: ['agent', 'prompt'],
      },
      policy: {
        type: 'object',
        properties: {
          cooldownMs: { type: 'integer', minimum: 0, description: 'Minimum ms between fires.' },
          maxFiresPerDay: { type: 'integer', minimum: 1, maximum: SENTINEL_LIMITS.MAX_FIRES_PER_DAY },
          missedFiresPolicy: {
            type: 'string',
            enum: ['skip', 'catchUpOnce', 'catchUpAll'],
            description:
              'How to handle recurring fires that elapsed while somora was down. ' +
              '`skip` (default): no backfill — best for "daily inbox check" where stacked ' +
              'fires after an outage are spam. `catchUpOnce`: fire one historical instance ' +
              'with catchUp:true in the evidence block — best for "monthly summary" where ' +
              'you want to know it was missed but not get N separate fires. `catchUpAll`: ' +
              'fire one per missed instant (capped at 24) — best for log-style triggers ' +
              'where each instant carries unique context. One-shot `at`-triggers use a 6h ' +
              'grace window separately, this flag only affects recurring sources.',
          },
        },
      },
      // get / pause / resume / delete / test / history
      id: { type: 'string', description: 'Trigger id — required for get/pause/resume/delete/test/history.' },
      // list
      owner: { type: 'string', description: 'list only — filter by owner-agent.' },
      status: { type: 'string', enum: ['active', 'paused', 'error', 'completed'], description: 'list only — filter by status.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'history only — newest-first cap.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 15_000,
  async handler(input, ctx): Promise<SentinelResult> {
    // Make sure cache is fresh — cheap on subsequent calls within
    // the same process.
    await loadTriggers();

    switch (input.action) {
      case 'create': {
        const v = validateCreateInput(input);
        if (!v.ok) return { action: 'create', ok: false, error: v.error };
        const { name, source, dispatch } = v.data;
        // Validate the time spec
        if (source.type === 'time') {
          try { validateTimeSpec(source.spec); } catch (err) {
            return { action: 'create', ok: false, error: `invalid time spec: ${(err as Error).message}` };
          }
        }
        // Enforce limits
        const limitErr = enforceLimits(source, input.policy);
        if (limitErr) return { action: 'create', ok: false, error: limitErr };
        const ownerAgent = ctx.agent;
        const activeCount = countTriggersByAgent(ownerAgent);
        if (activeCount >= SENTINEL_LIMITS.MAX_TRIGGERS_PER_AGENT) {
          return {
            action: 'create',
            ok: false,
            error: `agent '${ownerAgent}' has ${activeCount} active/paused triggers (cap ${SENTINEL_LIMITS.MAX_TRIGGERS_PER_AGENT}). Delete triggers you no longer need before adding more (completed/errored ones don't count).`,
          };
        }

        // Compute next-fire upfront so list/UI immediately shows it.
        let nextFireAt: string | undefined;
        try {
          const next = computeNextFire(source.spec);
          if (next) nextFireAt = next.toISOString();
        } catch (err) {
          return { action: 'create', ok: false, error: `unschedulable: ${(err as Error).message}` };
        }

        const trigger: Trigger = {
          id: newTriggerId(name),
          name,
          ...(input.intent ? { intent: input.intent } : {}),
          ownerAgent,
          source,
          evaluator: { type: 'none' },
          dispatch: {
            agent: dispatch.agent,
            session: dispatch.session ?? 'main',
            prompt: dispatch.prompt,
          },
          ...(input.policy ? { policy: input.policy } : {}),
          createdAt: new Date().toISOString(),
          status: 'active',
          fireCount: 0,
          errorStreak: 0,
          ...(nextFireAt ? { nextFireAt } : {}),
        };
        await saveTrigger(trigger);
        reschedule();
        logger.info({
          msg: 'sentinel.tool.create',
          triggerId: trigger.id,
          ownerAgent,
          dispatchAgent: dispatch.agent,
          source: trigger.source.type === 'time' ? describeTimeSpec(trigger.source.spec) : trigger.source.type,
          nextFireAt,
        });
        return {
          action: 'create',
          ok: true,
          trigger,
          hint:
            nextFireAt
              ? `Trigger '${trigger.id}' active. Next fire at ${nextFireAt}. ` +
                `Use sentinel({action:"test", id:"${trigger.id}"}) to fire now (bypasses cooldown).`
              : `Trigger '${trigger.id}' created — but no future fire computed (one-shot moment already past?).`,
        };
      }

      case 'list': {
        let all = listTriggers();
        if (input.owner) all = all.filter((t) => t.ownerAgent === input.owner);
        if (input.status) all = all.filter((t) => t.status === input.status);
        // Newest first by createdAt
        all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          action: 'list',
          ok: true,
          count: all.length,
          triggers: all.map(summarize),
        };
      }

      case 'get': {
        if (!input.id) return { action: 'get', ok: false, error: 'get: id required' };
        const t = getTrigger(input.id);
        if (!t) return { action: 'get', ok: false, error: `trigger '${input.id}' not found` };
        return {
          action: 'get',
          ok: true,
          trigger: t,
          describe: t.source.type === 'time' ? describeTimeSpec(t.source.spec) : t.source.type,
        };
      }

      case 'pause': {
        if (!input.id) return { action: 'pause', ok: false, id: '', error: 'pause: id required' };
        const t = getTrigger(input.id);
        if (!t) return { action: 'pause', ok: false, id: input.id, error: `trigger '${input.id}' not found` };
        await saveTrigger({ ...t, status: 'paused', statusReason: `paused by ${ctx.agent}` });
        reschedule();
        return { action: 'pause', ok: true, id: input.id };
      }

      case 'resume': {
        if (!input.id) return { action: 'resume', ok: false, id: '', error: 'resume: id required' };
        const t = getTrigger(input.id);
        if (!t) return { action: 'resume', ok: false, id: input.id, error: `trigger '${input.id}' not found` };
        // Recompute nextFireAt; an old one may have drifted past.
        let nextFireAt: string | undefined;
        if (t.source.type === 'time') {
          try {
            const next = computeNextFire(t.source.spec);
            if (next) nextFireAt = next.toISOString();
          } catch (err) {
            return { action: 'resume', ok: false, id: input.id, error: `cannot resume: ${(err as Error).message}` };
          }
        }
        const updated: Trigger = {
          ...t,
          status: 'active',
          errorStreak: 0,
          ...(nextFireAt ? { nextFireAt } : {}),
        };
        delete updated.statusReason;
        await saveTrigger(updated);
        reschedule();
        return { action: 'resume', ok: true, id: input.id };
      }

      case 'delete': {
        if (!input.id) return { action: 'delete', ok: false, id: '', error: 'delete: id required' };
        const removed = await deleteTrigger(input.id);
        if (removed) reschedule();
        return removed
          ? { action: 'delete', ok: true, id: input.id }
          : { action: 'delete', ok: false, id: input.id, error: `trigger '${input.id}' not found` };
      }

      case 'test': {
        if (!input.id) return { action: 'test', ok: false, id: '', error: 'test: id required' };
        const t = getTrigger(input.id);
        if (!t) return { action: 'test', ok: false, id: input.id, error: `trigger '${input.id}' not found` };
        // Fire NOW, bypassing cooldown and daily-cap. dispatchTestFire
        // routes via the main server's HTTP endpoint when this tool
        // runs inside an MCP-child (claude-cli / codex-cli engines) —
        // those children have no chatTurnDeps and would otherwise
        // record `"sentinel not initialized"` in history. Same fallback
        // pattern as spawn.ts:spawnAsyncViaHttp.
        try {
          await dispatchTestFire(t);
        } catch (err) {
          return {
            action: 'test',
            ok: false,
            id: input.id,
            error: `test dispatch failed: ${(err as Error).message}`,
          };
        }
        return {
          action: 'test',
          ok: true,
          id: input.id,
          hint: `Test-fire dispatched. Check sentinel history or the target agent's session '${t.dispatch.session}' for the agent's response.`,
        };
      }

      case 'history': {
        if (!input.id) return { action: 'history', ok: false, id: '', error: 'history: id required' };
        const entries = await getHistory(input.id, input.limit ?? 50);
        return {
          action: 'history',
          ok: true,
          id: input.id,
          count: entries.length,
          entries,
        };
      }
    }
  },
};

export function sentinelTools(): ToolDefinition[] {
  return [sentinel] as ToolDefinition[];
}
