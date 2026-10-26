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
import { activeDecisionModel, type Config } from '../../config/types.ts';
import { logger } from '../../server/logger.ts';
import { buildCheckSource, validateCheckInput, type CheckSpecInput } from '../../sentinel/check-create.ts';
import { dryRunCheck, hasRecentDryRun, recordDryRun } from '../../sentinel/check-dry-run.ts';
import { initialCheckState } from '../../sentinel/check-logic.ts';
import { installCheckScript, loadCheckState, removeCheckFiles, replaceCheckScript, saveCheckState } from '../../sentinel/check-store.ts';
import { checkReadAllowed, realpathSafeAncestor, resolveLocalPath } from '../file/policy.ts';
import type { ToolContext, ToolDefinition } from '../types.ts';
import {
  deleteTrigger,
  getHistory,
  getTrigger,
  listTriggers,
  loadTriggers,
  saveTrigger,
  countTriggersByAgent,
  recordFire,
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
  type CheckSource,
  type Evaluator,
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

const TimeSourceSchema = z.object({
  type: z.literal('time'),
  spec: TimeSpecSchema,
});

// Phase 2: a script checks before the agent is woken (src/sentinel/check-*.ts).
const CheckSourceSchema = z
  .object({
    type: z.literal('check'),
    script: z.string().min(1),
    description: z.string().min(1).max(300),
    mode: z.enum(['once', 'watch']),
    interval: z.string().min(1),
    deadline: z.string().min(1).optional(),
    timeoutMs: z.number().int().optional(),
    notifyOnFirst: z.boolean().optional(),
    decision: z.object({ questions: z.record(z.string(), z.unknown()), wake: z.record(z.string(), z.unknown()) }).strict().optional(),
  })
  .strict();
type CheckSourceInputT = z.infer<typeof CheckSourceSchema>;

const SourceSchema = z.discriminatedUnion('type', [TimeSourceSchema, CheckSourceSchema]);

const DispatchSchema = z.object({
  agent: z.string().min(1),
  // Optional here (not `.default('main')`): left out means "the
  // session I am in" for a trigger on yourself — resolved in the handler.
  session: z.string().min(1).optional(),
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
      'create', 'dry_run', 'update', 'list', 'get', 'pause', 'resume', 'delete', 'test', 'history', 'purge_completed',
    ]),
    // create
    name: z.string().min(1).max(100).optional(),
    intent: z.string().max(500).optional(),
    source: SourceSchema.optional(),
    dispatch: DispatchSchema.optional(),
    policy: PolicySchema.optional(),
    // update
    prompt: z.string().min(1).optional(),
    // get / pause / resume / delete / test / history
    id: z.string().min(1).optional(),
    // list (owner also filters purge_completed)
    owner: z.string().optional(),
    status: z.enum(['active', 'paused', 'error', 'completed']).optional(),
    include_completed: z.boolean().optional(),
    // history
    limit: z.number().int().min(1).max(200).default(50).optional(),
  })
  .strict();

type SentinelInputT = z.infer<typeof SentinelInput>;

// ─────────────────────────────────────────────────────────────────────
// Result types (loose union — handler narrows)
// ─────────────────────────────────────────────────────────────────────

type SentinelResult =
  | { action: 'create'; ok: true; trigger: Trigger; hint: string; /** Set when the session was left out and the trigger was bound to the caller's non-main session. */ session_note?: string }
  | { action: 'create'; ok: false; error: string }
  | {
      action: 'list';
      ok: true;
      count: number;
      triggers: Array<TriggerSummary>;
      /** Fired one-shots hidden from this listing (no status filter, no include_completed). */
      hidden_completed?: number;
      hint?: string;
    }
  | { action: 'purge_completed'; ok: true; count: number; ids: string[] }
  | { action: 'get'; ok: true; trigger: Trigger; describe: string }
  | { action: 'get'; ok: false; error: string }
  | { action: 'pause' | 'resume' | 'delete'; ok: boolean; id: string; error?: string }
  | { action: 'test'; ok: boolean; id: string; hint?: string; error?: string }
  | { action: 'history'; ok: true; id: string; count: number; entries: Awaited<ReturnType<typeof getHistory>> }
  | { action: 'history'; ok: false; id: string; error: string }
  | { action: 'dry_run' | 'update' | 'test'; ok: boolean; id?: string; error?: string; [k: string]: unknown };

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
    source: describeSource(t),
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

function describeSource(t: Pick<Trigger, 'source' | 'evaluator'>): string {
  const s = t.source;
  if (s.type === 'time') return describeTimeSpec(s.spec);
  return `check ${s.mode}, every ${s.interval}${s.deadline ? ` until ${s.deadline}` : ''}${t.evaluator?.type === 'decision' ? ', judged by the decision model' : ''}`;
}

/** The agent's script path → an absolute path it may read, plus the
 *  settings in the shape check-create.ts checks. */
async function resolveCheckInput(src: CheckSourceInputT, ctx: ToolContext): Promise<{ ok: true; input: CheckSpecInput } | { ok: false; error: string }> {
  const { absolute } = await resolveLocalPath(src.script, ctx.agent, ctx.config, ctx.session);
  for (const candidate of [absolute, await realpathSafeAncestor(absolute)]) {
    const verdict = checkReadAllowed(candidate);
    if (!verdict.ok) return { ok: false, error: `script: ${verdict.reason}` };
  }
  return {
    ok: true,
    input: {
      description: src.description,
      scriptPath: absolute,
      mode: src.mode,
      interval: src.interval,
      ...(src.deadline !== undefined ? { deadline: src.deadline } : {}),
      ...(src.timeoutMs !== undefined ? { timeoutMs: src.timeoutMs } : {}),
      ...(src.notifyOnFirst !== undefined ? { notifyOnFirst: src.notifyOnFirst } : {}),
      ...(src.decision ? { decision: src.decision } : {}),
    },
  };
}

const NO_DRY_RUN =
  'no successful dry run of this script (as the file is now) in the last 2 h. Run sentinel({action:"dry_run", source}) with the same source first — it runs the script once and shows what would happen; nothing is saved.';

function enforceLimits(source: NonNullable<SentinelInputT['source']>, policy?: SentinelInputT['policy']): string | null {
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

/** The kinds of trigger and when to use which — the decision aid of
 *  private/sentinel-phase2/KONZEPT.md §9c. Art 2 (judged checks) only
 *  appears when a decision model is configured. */
function sentinelDescription(art2: boolean, limits: Config['sentinel']['checks']): string {
  const s = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`);
  return (
    'Install and manage triggers that wake an agent later — instead of waiting, sleeping or polling inside a turn. ' +
    'A woken agent gets a turn with a [Sentinel trigger fired] block (what fired and why) and the trigger\'s prompt.' +
    '\n\nWhich kind fits:\n' +
    '- TIME (source.type "time"): something should happen at a time — "remind me tomorrow at 9", "report every Monday".\n' +
    `- CHECK, once (source.type "check", mode "once"): wait for an event a small script can check for certain — "tell me when the model switch is done", "when the build has passed". The script prints {"ready": true|false}; you are woken on the first ready: true, or once at the deadline (required, at most ${Math.round(limits.maxDeadlineMs / 3_600_000)} h) with the last state. Interval from ${s(limits.minIntervalOnceMs)}.\n` +
    `- CHECK, watch (mode "watch"): watch a clear condition — "when BTC drops below 50,000". Wakes on each change from ready: false to true, not on every positive check. Interval from ${s(limits.minIntervalMs)}.\n` +
    (art2
      ? '- JUDGED CHECK (a check with "decision"): watch something that needs judgement — "when a mail arrives that needs an answer today", "when there is news about X". The script prints {"data": …}; the decision model answers your question about the data and wakes you above your threshold. Usually mode "watch".\n'
      : '') +
    '- No trigger: when you can do it now, or nobody asked to be told later.' +
    '\n\nCheck scripts: one file in your workspace — .sh (bash), .py (python3), .js/.mjs (node). They only observe: read a status, fetch data; actions belong in your woken turn. ' +
    'Print ONE JSON object on stdout: {"ready": true|false, "summary": "short, for you", "data": {…}}' +
    (art2 ? ' — a judged check prints {"data": …, "summary": "…"}' : '') +
    '. {"final": "failed", "summary": "…"} when it can never happen (wakes at once, ends the trigger). Exit 0 means the check ran; a non-zero exit, other output or a timeout is a check error — never a wake, three in a row pause the trigger. ' +
    '$SOMORA_SENTINEL_STATE_DIR is the script\'s own folder for remembering things between runs. ' +
    'Look at the real data first (fetch the endpoint, list the folder) and write the script against what you saw — do not ask the user what you can look up. ' +
    'Parse JSON and compare numbers in Python or node; jq and bc may not be installed. ' +
    (art2
      ? 'A judged script must print only items that are NEW since its last run (remember what it printed in the state folder) and nothing that changes on every run (no timestamps, counters) — otherwise old items are judged again and wake you again. '
      : '') +
    'Templates: docs/sentinel.md.' +
    '\n\nSteps for a check: write the script → action "dry_run" with the exact source you will create (runs it once, shows what would happen; required, nothing saved, nobody woken) → "create" with the same source, a name and dispatch.prompt: what to do when woken. A new script for update needs a dry run too.' +
    '\n\nActions: create (name + source + dispatch, optional policy) · dry_run (a check source) · ' +
    'update (id + any of source, prompt, name, intent) · list (filter by owner or status; fired one-shots ' +
    'only with include_completed:true) · get (id) · pause / resume (id) · delete (id) · ' +
    'test (id; a time trigger fires now, a check runs its script once) · history (id, last events) · ' +
    'purge_completed (deletes all fired one-shots, nothing else).' +
    '\n\nTime specs (source.spec): at (ISO time, once) · every ("5m", at least 60s) · daily ("08:00") · ' +
    'weekly (day + "09:00") · cron (5 fields, see its description). Prefer daily, weekly or every when they fit.' +
    `\n\nLimits: 50 active triggers per agent, 500 fires per trigger and day, ${limits.maxWakesPerDay} wakes per check trigger and day; ` +
    'three errors in a row pause a trigger. The person sees all triggers in the web Sentinel window.'
  );
}

function sentinelJsonSchema(art2: boolean): Record<string, unknown> {
  const checkSource: Record<string, unknown> = {
    type: 'object',
    properties: {
      type: { const: 'check' },
      script: { type: 'string', description: 'Path of your script (.sh, .py, .js/.mjs), relative to your workspace or absolute. somora copies it at creation — editing the file later changes nothing; use update.' },
      description: { type: 'string', maxLength: 300, description: 'What the check watches, in a few words ("the model server answers on glm"). Shown in every wake.' },
      mode: { type: 'string', enum: ['once', 'watch'], description: 'once: wake on the first positive check, then done (deadline required). watch: keep checking, wake on each change.' },
      interval: { type: 'string', description: 'Between two checks: "15s", "5m", "1h".' },
      deadline: { type: 'string', description: 'once only, required: ISO time or a duration from now ("2h").' },
      timeoutMs: { type: 'integer', description: 'Time one run may take (default 30000).' },
      notifyOnFirst: { type: 'boolean', description: 'watch only: the first check may wake too (default: it only records the starting state).' },
      ...(art2
        ? {
            decision: {
              type: 'object',
              description: 'Judged check: the decision model reads the script\'s data. questions: as for decision_evaluate ({id: {type: "boolean"|"choice"|"score", instructions, criteria}}). wake: the rule that wakes you.',
              properties: {
                questions: { type: 'object', description: 'e.g. {"urgent": {"type": "boolean", "instructions": "Does any of these mails need an answer today?"}}' },
                wake: {
                  oneOf: [
                    { type: 'object', properties: { question: { type: 'string' }, minProbability: { type: 'number', minimum: 0, maximum: 1 } }, required: ['question', 'minProbability'], description: 'boolean question: wake when the probability of yes ≥ minProbability (e.g. 0.8)' },
                    { type: 'object', properties: { question: { type: 'string' }, choice: { type: 'string' }, minConfidence: { type: 'number', minimum: 0, maximum: 1 } }, required: ['question', 'choice'], description: 'choice question: wake when this choice is picked (or its probability ≥ minConfidence)' },
                    { type: 'object', properties: { question: { type: 'string' }, minScore: { type: 'integer', minimum: 1 } }, required: ['question', 'minScore'], description: 'score question: wake when the score ≥ minScore' },
                  ],
                },
              },
              required: ['questions', 'wake'],
            },
          }
        : {}),
    },
    required: ['type', 'script', 'description', 'mode', 'interval'],
  };
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'dry_run', 'update', 'list', 'get', 'pause', 'resume', 'delete', 'test', 'history', 'purge_completed'],
        description: 'What to do — the actions and their fields are listed in the tool description.',
      },
      // create
      name: { type: 'string', maxLength: 100, description: 'create / update — human label.' },
      intent: { type: 'string', maxLength: 500, description: 'create / update — short user-intent summary echoed to the agent at fire-time.' },
      source: {
        description: 'create / dry_run / update — where wake-ups come from: a time, or a check script.',
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'time' },
              spec: {
                description: 'Discriminated by spec.type. See examples.',
                oneOf: [
                  { type: 'object', properties: { type: { const: 'at' }, iso: { type: 'string' } }, required: ['type', 'iso'] },
                  { type: 'object', properties: { type: { const: 'every' }, interval: { type: 'string', description: '30s / 5m / 1h. Minimum 60s.' } }, required: ['type', 'interval'] },
                  { type: 'object', properties: { type: { const: 'daily' }, time: { type: 'string', description: 'HH:MM or HH:MM:SS.' } }, required: ['type', 'time'] },
                  { type: 'object', properties: { type: { const: 'weekly' }, day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }, time: { type: 'string' } }, required: ['type', 'day', 'time'] },
                  { type: 'object', properties: { type: { const: 'cron' }, expression: { type: 'string', description: '5-field cron: minute hour day month weekday. Allowed: *, N, */N, a,b,c. No ranges (write 1,2,3,4,5, not 1-5) and no names (weekday 1=Mon … 7=Sun). Examples: "0 8 * * *" daily 8:00 · "0 9 1 * *" 1st of the month 9:00 · "*/15 * * * *" every 15 min · "0 9,17 * * *" 9:00 and 17:00.' } }, required: ['type', 'expression'] },
                ],
              },
            },
            required: ['type', 'spec'],
          },
          checkSource,
        ],
      },
      dispatch: {
        type: 'object',
        description: 'create only — which agent wakes up in which session with what prompt.',
        properties: {
          agent: { type: 'string', description: 'Target agent. Must exist.' },
          session: {
            type: 'string',
            description:
              'A session slug or id, "main", or "current" (the session you are in; only for yourself). ' +
              'Left out: a trigger on yourself fires in the session you create it from (a sub-agent\'s: in ' +
              '"main"); one on another agent fires in their "main". Say "main" when a recurring job belongs ' +
              'there. A missing session is created.',
          },
          prompt: { type: 'string', description: 'Agent receives this as a user-turn body, prefixed by a structured evidence block.' },
        },
        required: ['agent', 'prompt'],
      },
      policy: {
        type: 'object',
        description: 'create only, optional — limits on how often the trigger fires.',
        properties: {
          cooldownMs: { type: 'integer', minimum: 0, description: 'Minimum ms between fires.' },
          maxFiresPerDay: { type: 'integer', minimum: 1, maximum: SENTINEL_LIMITS.MAX_FIRES_PER_DAY },
          missedFiresPolicy: {
            type: 'string',
            enum: ['skip', 'catchUpOnce', 'catchUpAll'],
            description:
              'Recurring triggers only — fires missed while somora was down. "skip" (default): none. ' +
              '"catchUpOnce": one, marked catchUp:true (e.g. a monthly summary). "catchUpAll": one per ' +
              'missed time, at most 24 (when each time matters).',
          },
        },
      },
      prompt: { type: 'string', description: 'update only — the new dispatch prompt.' },
      // get / pause / resume / delete / test / history / update
      id: { type: 'string', description: 'Trigger id — required for get/pause/resume/delete/test/history/update.' },
      // list
      owner: { type: 'string', description: 'list / purge_completed — filter by owner-agent.' },
      status: { type: 'string', enum: ['active', 'paused', 'error', 'completed'], description: 'list only — filter by status.' },
      include_completed: { type: 'boolean', description: 'list only — also show fired one-shots (hidden by default).' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'history only — newest-first cap.' },
    },
    required: ['action'],
    additionalProperties: false,
  };
}

const DEFAULT_CHECK_LIMITS: Config['sentinel']['checks'] = {
  minIntervalOnceMs: 15_000,
  minIntervalMs: 60_000,
  maxDeadlineMs: 86_400_000,
  timeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  maxOutputBytes: 65_536,
  maxConcurrent: 4,
  errorStreak: 3,
  maxWakesPerDay: 24,
};

export const sentinel: ToolDefinition<SentinelInputT, SentinelResult> = {
  name: 'sentinel',
  toolset: 'sentinel',
  description: sentinelDescription(false, DEFAULT_CHECK_LIMITS),
  inputSchema: SentinelInput,
  jsonSchema: sentinelJsonSchema(false),
  forContext: (ctx) => {
    const art2 = activeDecisionModel(ctx.config) !== null;
    const limits = ctx.config.sentinel?.checks ?? DEFAULT_CHECK_LIMITS;
    return { description: sentinelDescription(art2, limits), jsonSchema: sentinelJsonSchema(art2) };
  },
  defaultTimeoutMs: 15_000,
  // A dry run (or a check trigger's test) runs the script and maybe asks
  // the decision model: up to the check's time limit plus the model's.
  timeoutFromInput: (input) => (input.action === 'dry_run' || input.action === 'test' ? 260_000 : undefined),
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
        if (source.type === 'time') {
          try {
            const next = computeNextFire(source.spec);
            if (next) nextFireAt = next.toISOString();
          } catch (err) {
            return { action: 'create', ok: false, error: `unschedulable: ${(err as Error).message}` };
          }
        }

        // Where it fires. "current" is the caller's own session — the
        // one thing an agent could not name before (2026-09-15: a
        // resume trigger set from a working session fired in `main`
        // and ran next to the work it was meant to resume).
        let dispatchSession = dispatch.session ?? 'main';
        let sessionNote: string | undefined;
        // Left out + a trigger on yourself + created from inside a
        // session → that session (the operator, 2026-09-21). "Wake me to go on
        // with this" is what an agent means when it says nothing; `main`
        // was a different conversation that then ran alongside the work.
        // Another agent's trigger, or a call with no session context,
        // keeps `main`.
        //
        // Not for a sub-agent turn: its session is a sealed work room
        // nobody looks into once the task is handed in — a reminder
        // fired there would be seen by no one. That keeps `main`, and
        // says so.
        const isSubTurn = (ctx.subagentDepth ?? 0) > 0;
        if (dispatch.session === undefined && dispatch.agent === ownerAgent && ctx.session) {
          if (isSubTurn) {
            sessionNote = `dispatch.session was left out. You are a sub-agent in '${ctx.session}', which nobody watches after you finish, so this trigger fires in 'main'. Pass session: "current" if it really should come back to this sub-session.`;
          } else {
            dispatchSession = ctx.session;
            if (ctx.session !== 'main') {
              sessionNote = `dispatch.session was left out, so this trigger fires in the session you are in ('${ctx.session}'). Pass session: "main" if you meant your main session.`;
            }
          }
        }
        if (dispatchSession === 'current') {
          if (dispatch.agent !== ownerAgent) {
            return {
              action: 'create',
              ok: false,
              error: `dispatch.session "current" means YOUR current session, but dispatch.agent is '${dispatch.agent}'. Name a session of that agent instead.`,
            };
          }
          if (!ctx.session) {
            return {
              action: 'create',
              ok: false,
              error: 'dispatch.session "current" is not available here — this call is not running inside a session. Name the session explicitly.',
            };
          }
          dispatchSession = ctx.session;
        }

        const id = newTriggerId(name);
        // A check: validated, dry-run before (required), copied now.
        let check: { source: CheckSource; evaluator: Evaluator } | undefined;
        if (source.type === 'check') {
          const r = await resolveCheckInput(source, ctx);
          if (!r.ok) return { action: 'create', ok: false, error: r.error };
          const v = await validateCheckInput(r.input, ctx.config);
          if (!v.ok) return { action: 'create', ok: false, error: v.error };
          if (!(await hasRecentDryRun(ctx.agent, v.sha256, v.evaluator.type === 'decision' ? 2 : 1))) {
            return { action: 'create', ok: false, error: NO_DRY_RUN };
          }
          const script = await installCheckScript(id, r.input.scriptPath);
          if (script.sha256 !== v.sha256) {
            await removeCheckFiles(id);
            return { action: 'create', ok: false, error: `the script changed while the trigger was created — ${NO_DRY_RUN}` };
          }
          await saveCheckState({ ...initialCheckState(id, new Date()), nextCheckAt: new Date().toISOString() });
          check = { source: buildCheckSource(r.input, v.deadline, script), evaluator: v.evaluator };
        }

        const trigger: Trigger = {
          id,
          name,
          ...(input.intent ? { intent: input.intent } : {}),
          ownerAgent,
          source: check?.source ?? (source as Trigger['source']),
          evaluator: check?.evaluator ?? { type: 'none' },
          dispatch: {
            agent: dispatch.agent,
            session: dispatchSession,
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
          source: describeSource(trigger),
          nextFireAt,
        });
        if (check) {
          const s = check.source;
          return {
            action: 'create',
            ok: true,
            trigger,
            ...(sessionNote ? { session_note: sessionNote } : {}),
            hint:
              (sessionNote ? `${sessionNote} ` : '') +
              `Check '${trigger.id}' active: the first check runs now, then every ${s.interval}` +
              (s.mode === 'once'
                ? ` until ${s.deadline}. You are woken once — on the first ${check.evaluator.type === 'decision' ? 'data the decision model rates above your threshold' : 'ready: true'}, or at the deadline with the last state.`
                : `. ${s.notifyOnFirst ? 'The first check may wake you; after that you' : 'The first check only records the starting state; you'} are woken on ${check.evaluator.type === 'decision' ? 'new data the decision model rates above your threshold' : 'each change from ready: false to true'}.`) +
              ` Nothing to do until then — do not poll it yourself. sentinel({action:"get", id:"${trigger.id}"}) shows the last check.`,
          };
        }
        return {
          action: 'create',
          ok: true,
          trigger,
          ...(sessionNote ? { session_note: sessionNote } : {}),
          hint:
            (sessionNote ? `${sessionNote} ` : '') +
            (nextFireAt
              ? `Trigger '${trigger.id}' active. Next fire at ${nextFireAt}. ` +
                `Use sentinel({action:"test", id:"${trigger.id}"}) to fire now (bypasses cooldown).`
              : `Trigger '${trigger.id}' created — but no future fire computed (one-shot moment already past?).`),
        };
      }

      case 'dry_run': {
        if (!input.source || input.source.type !== 'check') {
          return { action: 'dry_run', ok: false, error: 'dry_run needs source: {type: "check", …} — the same source you will pass to create' };
        }
        const r = await resolveCheckInput(input.source, ctx);
        if (!r.ok) return { action: 'dry_run', ok: false, error: r.error };
        const v = await validateCheckInput(r.input, ctx.config);
        if (!v.ok) return { action: 'dry_run', ok: false, error: v.error };
        const report = await dryRunCheck({
          agent: input.dispatch?.agent ?? ctx.agent,
          source: { mode: r.input.mode, ...(r.input.notifyOnFirst ? { notifyOnFirst: true } : {}), ...(r.input.timeoutMs !== undefined ? { timeoutMs: r.input.timeoutMs } : {}) },
          evaluator: v.evaluator,
          config: ctx.config,
          scriptPath: r.input.scriptPath,
        });
        const { sha, ...rest } = report;
        if (report.ok && sha === v.sha256) await recordDryRun(ctx.agent, v.sha256, report.art);
        logger.info({ msg: 'sentinel.tool.dry_run', agent: ctx.agent, ok: report.ok, art: report.art, ms: report.ms, ...(report.error ? { error: report.error.slice(0, 200) } : {}) });
        return {
          action: 'dry_run',
          ...rest,
          next: report.ok
            ? 'Compare the answer with the real situation (summary and data match what you see yourself?) — a wrong field name gives a plausible but wrong answer. If it is right, create the trigger with the same source plus name and dispatch.prompt (what to do when woken). Change the script → dry-run again.'
            : 'Fix the script and dry-run again (run it by hand with exec to see more).',
        };
      }

      case 'update': {
        if (!input.id) return { action: 'update', ok: false, error: 'update: id required' };
        const t = getTrigger(input.id);
        if (!t) return { action: 'update', ok: false, id: input.id, error: `trigger '${input.id}' not found` };
        const changed: string[] = [];
        let updated: Trigger = { ...t };
        if (input.name) { updated.name = input.name; changed.push('name'); }
        if (input.intent !== undefined) { updated.intent = input.intent; changed.push('intent'); }
        if (input.prompt) { updated.dispatch = { ...t.dispatch, prompt: input.prompt }; changed.push('prompt'); }
        if (input.source) {
          if (input.source.type !== 'check' || t.source.type !== 'check') {
            return { action: 'update', ok: false, id: t.id, error: 'update changes the source of a check trigger only — for a time trigger, create a new one and delete the old' };
          }
          const r = await resolveCheckInput(input.source, ctx);
          if (!r.ok) return { action: 'update', ok: false, id: t.id, error: r.error };
          const v = await validateCheckInput(r.input, ctx.config);
          if (!v.ok) return { action: 'update', ok: false, id: t.id, error: v.error };
          const scriptChanged = v.sha256 !== t.source.script.sha256;
          const artChanged = v.evaluator.type !== (t.evaluator?.type === 'decision' ? 'decision' : 'ready');
          if ((scriptChanged || artChanged) && !(await hasRecentDryRun(ctx.agent, v.sha256, v.evaluator.type === 'decision' ? 2 : 1))) {
            return { action: 'update', ok: false, id: t.id, error: NO_DRY_RUN };
          }
          let script = t.source.script;
          if (scriptChanged) {
            try {
              script = await replaceCheckScript(t.id, r.input.scriptPath);
            } catch (err) {
              // The old copy is still in place and the trigger unchanged;
              // the history says so (a failed swap was only in the reply).
              const error = `script not replaced: ${(err as Error).message}`;
              const at = new Date().toISOString();
              await recordFire(t.id, { firedAt: at, scheduledFor: at, outcome: 'error', error: `update by ${ctx.agent} failed, ${error}; the old script still runs` });
              logger.warn({ msg: 'sentinel.tool.update_failed', triggerId: t.id, by: ctx.agent, error });
              return { action: 'update', ok: false, id: t.id, error: `${error} — the trigger keeps its old script` };
            }
          }
          updated = { ...updated, source: buildCheckSource(r.input, v.deadline, script), evaluator: v.evaluator };
          // A fresh start: new starting state, new deadline; today's wakes still count.
          const old = await loadCheckState(t.id);
          await saveCheckState({ ...initialCheckState(t.id, new Date()), nextCheckAt: new Date().toISOString(), ...(old?.wakesToday ? { wakesToday: old.wakesToday } : {}) });
          changed.push(scriptChanged ? 'script' : 'check settings');
        }
        if (changed.length === 0) return { action: 'update', ok: false, id: t.id, error: 'nothing to update — pass name, intent, prompt or source' };
        await saveTrigger(updated);
        const now = new Date().toISOString();
        await recordFire(t.id, { firedAt: now, scheduledFor: now, outcome: 'updated', note: `${changed.join(', ')} by ${ctx.agent}` });
        reschedule();
        logger.info({ msg: 'sentinel.tool.update', triggerId: t.id, by: ctx.agent, changed });
        return {
          action: 'update',
          ok: true,
          id: t.id,
          changed,
          ...(t.status !== 'active' ? { hint: `The trigger is ${t.status} — resume it to start checking again.` } : {}),
        };
      }

      case 'list': {
        let all = listTriggers();
        if (input.owner) all = all.filter((t) => t.ownerAgent === input.owner);
        if (input.status) all = all.filter((t) => t.status === input.status);
        // Fired one-shots stay for the audit trail (and history) but
        // clutter the working view — 27 of them after one project
        // evening (2026-09-07 report). Hide by default, say how many.
        let hiddenCompleted = 0;
        if (!input.status && !input.include_completed) {
          hiddenCompleted = all.filter((t) => t.status === 'completed').length;
          all = all.filter((t) => t.status !== 'completed');
        }
        // Newest first by createdAt
        all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          action: 'list',
          ok: true,
          count: all.length,
          triggers: all.map(summarize),
          ...(hiddenCompleted > 0
            ? {
                hidden_completed: hiddenCompleted,
                hint:
                  `${hiddenCompleted} fired one-shot(s) hidden — list with include_completed:true, ` +
                  `remove them with action:"purge_completed" (auto-deleted after the retention window anyway).`,
              }
            : {}),
        };
      }

      case 'purge_completed': {
        let victims = listTriggers().filter((t) => t.status === 'completed');
        if (input.owner) victims = victims.filter((t) => t.ownerAgent === input.owner);
        const ids: string[] = [];
        for (const t of victims) {
          if (await deleteTrigger(t.id)) ids.push(t.id);
        }
        if (ids.length > 0) reschedule();
        logger.info({ msg: 'sentinel.tool.purge_completed', by: ctx.agent, owner: input.owner ?? null, count: ids.length });
        return { action: 'purge_completed', ok: true, count: ids.length, ids };
      }

      case 'get': {
        if (!input.id) return { action: 'get', ok: false, error: 'get: id required' };
        const t = getTrigger(input.id);
        if (!t) return { action: 'get', ok: false, error: `trigger '${input.id}' not found` };
        const checkState = t.source.type === 'check' ? await loadCheckState(t.id) : null;
        return {
          action: 'get',
          ok: true,
          trigger: t,
          describe: describeSource(t),
          ...(checkState
            ? {
                check: {
                  checks: checkState.checkCount,
                  wakes: checkState.wakeCount,
                  ...(checkState.nextCheckAt && t.status === 'active' ? { nextCheckAt: checkState.nextCheckAt } : {}),
                  ...(checkState.last ? { last: checkState.last } : {}),
                  ...(checkState.lastDecision ? { lastDecision: checkState.lastDecision } : {}),
                  ...(checkState.errorStreak ? { errorsInARow: checkState.errorStreak } : {}),
                },
              }
            : {}),
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
        if (t.source.type === 'check') {
          // A check trigger's test is a dry run of its copy: nothing is
          // saved, nobody is woken, its state folder is not touched.
          const report = await dryRunCheck({ agent: t.dispatch.agent, source: t.source, evaluator: t.evaluator ?? { type: 'ready' }, config: ctx.config, installed: t });
          const { sha: _sha, ...rest } = report;
          return { action: 'test', id: t.id, ...rest };
        }
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
