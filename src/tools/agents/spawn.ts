// spawn_subagent + spawn_subagents — A2A delegation tools (Modus 1).
//
// Runs a sealed task in a fresh session of a target persona (defaults
// to a clone of the caller). Each spawn:
//   - creates a sub-session with slug `sub-<parent>-<ms-ts>` (or
//     `sub-self-<ms-ts>` for self-clones)
//   - records spawn-meta on the session: { kind, parent_agent,
//     parent_session, task_summary }
//   - runs through the full somora pipeline (memory inject, tools,
//     self-pointer with sub-context note, fallback engine)
//   - returns the final assistant text + session slug for traceability
//
// Caps:
//   - subagent_depth max 3 (configurable via SOMORA_MAX_SUBAGENT_DEPTH)
//   - per-agent concurrent spawns: 4
//   - global concurrent spawns: 16
//
// Memory + Dream: sub-sessions are normal sessions in the target
// persona's session-dir. Auto-inject runs per turn; the auto-dream
// worker picks them up like any other session.

import { z } from 'zod';
import { describeModelRefs, resolveAnyRef } from '../../config/types.ts';
import { loadPersona } from '../../persona/loader.ts';
import {
  completeTask,
  failTask,
  getTask,
  newTaskId,
  registerTask,
  type AsyncTaskEntry,
} from '../../server/async-tasks.ts';
import { registerWait } from '../../server/ask-wait-graph.ts';
import { registerChatAbort } from '../../server/chat-aborts.ts';
import { logger } from '../../server/logger.ts';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import type { ChatTurnResolveDeps, ChatTurnResult } from '../../server/run-turn-types.ts';
import { runChatTurn } from '../../server/run-turn.ts';
import { acquireSessionLock } from '../../server/session-queue.ts';
import { createSession, sessionMetaStore } from '../../storage/sessions.ts';
import type { ToolDefinition } from '../types.ts';
import { longTaskMaxMs } from './long-task-timeouts.ts';

const MAX_SUBAGENT_DEPTH = parseInt(process.env.SOMORA_MAX_SUBAGENT_DEPTH ?? '3', 10) || 3;
const MAX_CONCURRENT_PER_AGENT = 4;
const MAX_CONCURRENT_GLOBAL = 16;

// Process-wide concurrency tracker. Survives only as long as the
// somora process — sub-spawns across server restarts are fresh starts.
const activeByAgent = new Map<string, number>();
let activeGlobal = 0;

/** Try to reserve a spawn slot. Returns null on success, or an error
 *  message string on cap-rejection. Slot must be paired with
 *  releaseSpawnSlot() — release in a finally so a thrown background
 *  doesn't leak the counter. Same semantics for sync and async paths;
 *  the bug audit 2026-05-16 found the async path skipped accounting
 *  entirely, letting agents fan out way past the per-agent cap.
 *
 *  Cap fairness (2026-07-28 feedback): spawns issued BY a sub
 *  (fromDepth ≥ 1) may fill the per-agent cap only up to cap-1 — the
 *  last slot is reserved for top-level spawns, so an orchestrator sub
 *  fanning out into children can never lock the main agent out of
 *  spawning (e.g. a replacement or corrective sub). */
export function reserveSpawnSlot(targetPersona: string, fromDepth = 0): string | null {
  if (activeGlobal >= MAX_CONCURRENT_GLOBAL) {
    return `spawn_subagent: global concurrent cap (${MAX_CONCURRENT_GLOBAL}) reached`;
  }
  const perAgent = activeByAgent.get(targetPersona) ?? 0;
  const effectiveCap = fromDepth >= 1 ? MAX_CONCURRENT_PER_AGENT - 1 : MAX_CONCURRENT_PER_AGENT;
  if (perAgent >= effectiveCap) {
    return (
      `spawn_subagent: per-agent concurrent cap for '${targetPersona}' ` +
      `(${effectiveCap}${fromDepth >= 1 ? ` of ${MAX_CONCURRENT_PER_AGENT}; the last slot is reserved for top-level spawns` : ''}) reached`
    );
  }
  activeByAgent.set(targetPersona, perAgent + 1);
  activeGlobal++;
  return null;
}

export function releaseSpawnSlot(targetPersona: string): void {
  const cur = activeByAgent.get(targetPersona) ?? 0;
  if (cur > 0) activeByAgent.set(targetPersona, cur - 1);
  if (activeGlobal > 0) activeGlobal--;
}

interface SpawnDeps {
  chatTurnDeps: ChatTurnResolveDeps;
}

let injectedDeps: SpawnDeps | null = null;

/**
 * Server boot calls this once with the shared chatTurnDeps so the
 * spawn tools can run the full chat pipeline without re-resolving
 * server wiring on each call.
 */
export function configureSpawnTools(deps: SpawnDeps): void {
  injectedDeps = deps;
}

const TaskSchema = z.object({
  persona: z
    .string()
    .min(1)
    .optional()
    .describe('Target agent name. Omit to spawn a clone of the caller (<your-agent> → <your-agent>-clone).'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Model override — an alias or "provider/modelId" EXACTLY as configured in config.yaml; ' +
        'invented names are rejected. Omit (recommended) to use the persona\'s default.',
    ),
  task: z.string().min(1),
  /**
   * Optional per-spawn agent-loop override. Default global maxRounds=8
   * is fine for sealed research subs; orchestrator subs that
   * themselves spawn + poll can hit the cap fast — pass e.g.
   * { maxRounds: 32 } for those.
   */
  maxRounds: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Per-spawn override of agentLoop.maxRounds (the server config value; 8 if unset). Use higher (e.g. 32) for ' +
        'orchestrator subs that spawn further sub-subs and poll their results.',
    ),
  attention: z
    .boolean()
    .optional()
    .describe(
      'Async spawns only: when the sub finishes and you have not fetched its result, you get ' +
        'an automatic [subagent attention] wake turn (default). Pass false to opt out for ' +
        'subs whose results you will poll yourself or that need no follow-up.',
    ),
});

// ─────────────────────────────────────────────────────────────────────
// spawn_subagent (single)
// ─────────────────────────────────────────────────────────────────────

const SingleInput = TaskSchema.extend({
  wait: z
    .boolean()
    .default(false)
    .describe(
      'When true: block this turn until the sub returns its final answer (good for "I need ' +
        'the result NOW to compose my reply"). When false (default): fire-and-forget — returns ' +
        'a task_id immediately, sub runs in the background. Check progress with subagent_status, ' +
        'fetch the answer with subagent_result.',
    ),
}).strict();

export const spawnSubagent: ToolDefinition<z.infer<typeof SingleInput>> = {
  name: 'spawn_subagent',
  toolset: 'agents',
  description:
    'Spawn a sub-agent to handle a sealed task. The sub runs in a fresh session of the ' +
    'target persona (defaults to a clone of you), goes through normal memory+tool+thinking ' +
    'flow, and produces a final answer. ' +
    'Default is fire-and-forget (wait:false): you get a task_id back immediately and your ' +
    'turn ends — the user can keep chatting with you while the sub runs. When it finishes ' +
    'you get a [subagent attention] wake turn automatically (opt out with attention:false); ' +
    'use subagent_status / subagent_result to check earlier, subagent_cancel to abort a ' +
    'running sub INCLUDING its child-spawns. ' +
    'Set wait:true for synchronous "I need the result NOW to write my reply" delegations. ' +
    'Depth cap: 3 (a sub itself can spawn further subs up to that limit). ' +
    'Per-agent concurrent cap: 4 — NOTE: subs spawned by your subs count against YOUR cap ' +
    'too (child spawns may only fill 3 of the 4 slots; the last is reserved for you), and a ' +
    'self-clone sub inherits your persona default model unless you pass model explicitly — ' +
    'an expensive orchestrator spawning expensive children multiplies cost fast. ' +
    'Cross-engine OK — <agent-a>-on-opus can spawn <agent-b>-on-gpt55. ' +
    'Sub sessions stay visible in /sessions of the target persona with a "sub from X/Y" marker.',
  inputSchema: SingleInput,
  jsonSchema: {
    type: 'object',
    properties: {
      persona: {
        type: 'string',
        description: 'Target agent name (e.g. "<agent-name>", "<other-agent>"). Omit for a clone of yourself.',
      },
      model: {
        type: 'string',
        description:
          'Model override — an alias or "provider/modelId" EXACTLY as configured in config.yaml; ' +
          'invented names are rejected. Omit (recommended) to use the persona\'s default.',
      },
      task: { type: 'string', description: 'The task / question for the sub. Will become its first user message.' },
      maxRounds: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description:
          'Per-spawn override of agentLoop.maxRounds (the server config value; 8 if unset). Use higher (e.g. 32) for ' +
          'orchestrator subs that spawn further sub-subs and poll their results.',
      },
      attention: {
        type: 'boolean',
        description:
          'Async spawns only: automatic [subagent attention] wake turn when the sub finishes ' +
          'unfetched (default true). Pass false to opt out.',
      },
      wait: {
        type: 'boolean',
        description:
          'When true: block this turn until the sub returns its final answer. When false ' +
          '(default): fire-and-forget — returns a task_id immediately, sub runs in the ' +
          'background. Check progress with subagent_status, fetch the answer with subagent_result.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  // wait:false returns immediately (just registers + kicks off async),
  // 30s is plenty. wait:true blocks for the full sub turn — sized off
  // agentLoop.longTaskMaxTimeoutMs (default 30 min) so a sync spawn can
  // legitimately wait for slow local models without artificial cutoff.
  // The sub itself caps via its own agentLoop.maxRounds; this is just
  // a runaway guard. Read at call time so config changes take effect
  // without restart.
  defaultTimeoutMs: 30_000,
  timeoutFromInput: (input) => (input.wait ? longTaskMaxMs() : undefined),
  // Static safety fence; actual cap is dynamic via timeoutFromInput.
  maxTimeoutMs: 7_200_000,
  async handler(input, ctx) {
    const result = await runOneSpawn({
      ctx,
      wait: input.wait,
      task: {
        task: input.task,
        ...(input.persona ? { persona: input.persona } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
        ...(input.attention !== undefined ? { attention: input.attention } : {}),
      },
    });
    return result;
  },
};

// ─────────────────────────────────────────────────────────────────────
// spawn_subagents (parallel batch)
// ─────────────────────────────────────────────────────────────────────

const BatchInput = z
  .object({
    tasks: z
      .array(TaskSchema)
      .min(1)
      .max(8)
      .describe('Up to 8 tasks. Run in parallel; results returned together.'),
    wait: z
      .boolean()
      .default(false)
      .describe(
        'Default false (fire-and-forget): each task gets its own task_id, all run in ' +
          'parallel in the background, your turn ends immediately. true blocks until all ' +
          'complete and returns results inline.',
      ),
  })
  .strict();

export const spawnSubagents: ToolDefinition<z.infer<typeof BatchInput>> = {
  name: 'spawn_subagents',
  toolset: 'agents',
  description:
    'Spawn multiple sub-agents in parallel. Each task is a {persona?, model?, task} record; ' +
    'omitting persona = clone of you. Useful for fan-out queries: send the same task to ' +
    'multiple personas to compare perspectives, or different focused tasks at once. ' +
    'Returns one result per task in the same order. Same caps as spawn_subagent.',
  inputSchema: BatchInput,
  jsonSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            persona: { type: 'string' },
            model: {
              type: 'string',
              description:
                'Model override — alias or "provider/modelId" exactly as configured; omit for the persona default.',
            },
            task: { type: 'string' },
            maxRounds: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description:
                'Per-spawn override of agentLoop.maxRounds (the server config value; 8 if unset). Use higher (e.g. 32) ' +
                'for orchestrator subs that spawn further sub-subs and poll their results.',
            },
            attention: {
              type: 'boolean',
              description:
                'Async spawns only: automatic [subagent attention] wake turn when the sub ' +
                'finishes unfetched (default true). Pass false to opt out.',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
      wait: {
        type: 'boolean',
        description:
          'Default false (fire-and-forget): each task gets its own task_id, all run in ' +
          'parallel in the background, your turn ends immediately. true blocks until all ' +
          'complete and returns results inline.',
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  },
  // Same posture as spawn_subagent: wait:false is instant, wait:true
  // blocks for all subs — sized off agentLoop.longTaskMaxTimeoutMs.
  defaultTimeoutMs: 30_000,
  timeoutFromInput: (input) => (input.wait ? longTaskMaxMs() : undefined),
  maxTimeoutMs: 7_200_000,
  async handler(input, ctx) {
    const settled = await Promise.allSettled(
      input.tasks.map((t) => runOneSpawn({ ctx, wait: input.wait, task: t })),
    );
    const results = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const err = (s.reason as Error).message;
      const t = input.tasks[i]!;
      return {
        ok: false as const,
        persona: t.persona ?? ctx.agent,
        error: err,
        ms: 0,
      };
    });
    return { count: results.length, results };
  },
};


// ─────────────────────────────────────────────────────────────────────
// shared spawn machinery
// ─────────────────────────────────────────────────────────────────────

interface OneSpawnArgs {
  ctx: import('../types.ts').ToolContext;
  wait: boolean;
  task: {
    persona?: string;
    model?: string;
    task: string;
    maxRounds?: number;
    /** Attention-wake opt-out (async spawns). Default: wake. */
    attention?: boolean;
  };
}

interface OneSpawnSyncResult {
  ok: boolean;
  wait: 'sync';
  persona: string;
  agent_kind: 'self-clone' | 'named';
  session_slug: string;
  model: string;
  result?: string;
  error?: string;
  ms: number;
  thinkingActive: boolean;
}

interface OneSpawnAsyncResult {
  ok: true;
  wait: 'async';
  task_id: string;
  persona: string;
  agent_kind: 'self-clone' | 'named';
  session_slug: string;
  hint: string;
}

type OneSpawnResult = OneSpawnSyncResult | OneSpawnAsyncResult;

async function runOneSpawn(args: OneSpawnArgs): Promise<OneSpawnResult> {
  // injectedDeps absent is the normal MCP-child case (configureSpawnTools
  // only runs in the main server). The handler dispatches to the HTTP
  // fallback further down — this guard would have killed that path.
  const { ctx, task } = args;
  const parentDepth = ctx.subagentDepth ?? 0;
  if (parentDepth >= MAX_SUBAGENT_DEPTH) {
    throw new Error(
      `spawn_subagent: recursion depth ${parentDepth} exceeds limit ${MAX_SUBAGENT_DEPTH}`,
    );
  }
  const isSelfClone = !task.persona || task.persona === ctx.agent;
  const targetPersona = task.persona ?? ctx.agent;
  const personaCheck = await loadPersona(targetPersona);
  if (!personaCheck) {
    throw new Error(`spawn_subagent: persona '${targetPersona}' not found`);
  }
  // Validate a model override BEFORE creating the session + reserving a
  // slot: an invented name ("myprovider/model-that-does-not-exist") otherwise fails
  // deep inside the sub's first turn, leaving a dead session behind and
  // an error that doesn't say what WOULD have worked (2026-08-24 report).
  if (task.model && !resolveAnyRef(ctx.config, task.model)) {
    throw new Error(
      `spawn_subagent: model '${task.model}' is not configured — pass an alias or ` +
        `provider/modelId exactly as listed in config.yaml, or omit \`model\` to use ` +
        `${targetPersona}'s default (${personaCheck.model ?? 'unset'}). ` +
        `Available: ${describeModelRefs(ctx.config)}`,
    );
  }
  // Concurrency — slot must be held across the full lifetime of the
  // sub-turn (sync + async both). reserveSpawnSlot also increments the
  // counters atomically; the matching releaseSpawnSlot lives in the
  // finally of each path (sync: line below; async: inside the
  // background IIFE in spawnAsyncInProcess + the HTTP route).
  const slotErr = reserveSpawnSlot(targetPersona, parentDepth);
  if (slotErr) throw new Error(slotErr);

  // Slug carries ms + random suffix so parallel spawns in the same
  // millisecond don't collide (Math.random() collision in 4 lowercase
  // alphanums is ~1/1.7M, paired with ms it's ~1/1.7B per same-ms
  // pair). createSession also has its own collision-retry as a safety
  // net. The slug stem `sub-self`/`sub-<parent>` stays grep-friendly
  // for /sessions listings.
  const ms = String(Date.now() % 1000).padStart(3, '0');
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  const slug = isSelfClone
    ? `sub-self-${ms}-${rand}`
    : `sub-${ctx.agent}-${ms}-${rand}`;
  const sessionId = await createSession(targetPersona, slug);
  // Attach the spawn meta block so /sessions can label this entry
  // "sub from <parent>" without re-deriving from the slug.
  const existingMeta = await sessionMetaStore.get(targetPersona, sessionId);
  await sessionMetaStore.set(targetPersona, sessionId, {
    ...existingMeta,
    spawn: {
      kind: isSelfClone ? 'self-sub' : 'sub',
      parent_agent: ctx.agent,
      parent_session: ctx.session ?? '?',
      task_summary: task.task.slice(0, 200),
    },
  });

  // ─── async path (wait: false) ─────────────────────────────────────
  // Fire-and-forget: register the task, kick off the background work,
  // return the task_id immediately so the parent's turn can finish.
  // The slot reserved above is HELD by the background promise and
  // released in its own finally — caller's `wait:false` is not the
  // same as "free this slot".
  if (!args.wait) {
    try {
      let task_id: string;
      if (injectedDeps) {
        // In-process: the background IIFE owns the slot for the task's
        // whole lifetime and releases it in its own finally.
        task_id = await spawnAsyncInProcess({
          targetPersona,
          sessionId,
          taskText: task.task,
          parentAgent: ctx.agent,
          parentSession: ctx.session ?? '?',
          parentDepth,
          modelOverride: task.model,
          maxRoundsOverride: task.maxRounds,
          attention: task.attention,
        });
      } else {
        // MCP-child HTTP path: the SERVER process owns the task lifetime
        // and releases ITS own slot when the task finishes. The slot we
        // reserved lives in THIS per-turn child process and has no
        // lifetime to track here — release it now, or it leaks for the
        // rest of the child's life and caps the orchestrator at the
        // per-agent/global limit forever within the turn (Juni-Audit
        // 2026-06).
        task_id = await spawnAsyncViaHttp({
          targetAgent: targetPersona,
          targetSession: sessionId,
          taskText: task.task,
          parentAgent: ctx.agent,
          parentSession: ctx.session ?? '?',
          parentDepth,
          modelOverride: task.model,
          maxRoundsOverride: task.maxRounds,
          attention: task.attention,
        });
        releaseSpawnSlot(targetPersona);
      }
      logger.info({
        msg: 'spawn_subagent.async_started',
        task_id,
        parent_agent: ctx.agent,
        target: targetPersona,
        session: sessionId,
        depth: parentDepth + 1,
        via: injectedDeps ? 'in-process' : 'http',
      });
      return {
        ok: true,
        wait: 'async',
        task_id,
        persona: targetPersona,
        agent_kind: isSelfClone ? 'self-clone' : 'named',
        session_slug: slug,
        hint:
          `Sub is running in the background. Check progress with subagent_status({ task_id: "${task_id}" }) ` +
          `or fetch the answer with subagent_result({ task_id: "${task_id}" }).`,
      };
    } catch (err) {
      // Slot release on synchronous setup failure — the background
      // never actually started, so no IIFE finally will fire.
      releaseSpawnSlot(targetPersona);
      throw err;
    }
  }

  // ─── sync path (wait: true) ───────────────────────────────────────
  // The parent's turn now BLOCKS on the sub — that wait must be visible
  // in the A2A wait-graph, or a cycle routed through this spawn
  // (parent waits sub, sub asks X, X asks parent) is undetectable and
  // deadlocks silently (see src/server/ask-wait-graph.ts).
  //
  // No cycle CHECK is needed here: the sub-session was created fresh a
  // few lines up, so no edges into or out of it can exist yet — the
  // registration can't close a cycle. Cycles only become possible once
  // the sub itself starts waiting, and those later calls are checked at
  // their own dispatch points.
  //
  // Two transports, two registration owners:
  //   - in-process (injectedDeps set → we ARE the main server): register
  //     directly. This module is also loaded by MCP children, but the
  //     in-process branch never runs there, so the child's own (empty)
  //     graph instance stays untouched.
  //   - HTTP fallback (MCP child): the child process can't reach the
  //     main server's graph; runChatTurnViaHttp sends waiter_* and the
  //     /chat/send-sync route registers server-side.
  // ctx.session missing (shouldn't happen) degrades to no edge — same
  // graceful posture as agent_ask.
  const releaseWait =
    injectedDeps && ctx.session
      ? registerWait(
          { agent: ctx.agent, session: ctx.session },
          { agent: targetPersona, session: sessionId },
        )
      : undefined;
  try {
    logger.info({
      msg: 'spawn_subagent.start_sync',
      parent_agent: ctx.agent,
      parent_session: ctx.session,
      target: targetPersona,
      session: sessionId,
      depth: parentDepth + 1,
      via: injectedDeps ? 'in-process' : 'http',
    });

    const result: ChatTurnResult = injectedDeps
      ? await runChatTurn({
          agent: targetPersona,
          session: sessionId,
          text: task.task,
          subagentDepth: parentDepth + 1,
          ...(task.model ? { modelOverride: task.model } : {}),
          ...(task.maxRounds
            ? { agentLoopOverride: { maxRounds: task.maxRounds } }
            : {}),
          deps: injectedDeps.chatTurnDeps,
        })
      : await runChatTurnViaHttp({
          agent: targetPersona,
          session: sessionId,
          text: task.task,
          subagentDepth: parentDepth + 1,
          ...(ctx.session
            ? { waiterAgent: ctx.agent, waiterSession: ctx.session }
            : {}),
          ...(task.model ? { modelOverride: task.model } : {}),
          ...(task.maxRounds ? { maxRounds: task.maxRounds } : {}),
        });

    logger.info({
      msg: 'spawn_subagent.done',
      target: targetPersona,
      session: sessionId,
      ms: result.ms,
      bytes: result.finalText.length,
    });
    return {
      ok: !result.error,
      wait: 'sync',
      persona: targetPersona,
      agent_kind: isSelfClone ? 'self-clone' : 'named',
      session_slug: slug,
      model: result.model,
      result: result.finalText,
      ...(result.error ? { error: result.error } : {}),
      ms: result.ms,
      thinkingActive: result.thinkingActive,
    };
  } finally {
    releaseWait?.();
    releaseSpawnSlot(targetPersona);
  }
}

/**
 * In-process async dispatch: register the task, kick off runChatTurn
 * as a background promise, return the task_id. completeTask /
 * failTask write the result back into the shared task store.
 */
async function spawnAsyncInProcess(args: {
  targetPersona: string;
  sessionId: string;
  taskText: string;
  parentAgent: string;
  parentSession: string;
  parentDepth: number;
  modelOverride?: string;
  maxRoundsOverride?: number;
  attention?: boolean;
}): Promise<string> {
  if (!injectedDeps) throw new Error('spawnAsyncInProcess called without injectedDeps');
  const task_id = newTaskId();
  registerTask({
    task_id,
    parent_agent: args.parentAgent,
    parent_session: args.parentSession,
    target_agent: args.targetPersona,
    target_session: args.sessionId,
    started_at: Date.now(),
    ...(args.attention !== undefined ? { attention: args.attention } : {}),
  });
  void (async () => {
    // Hold the per-session lock so two parallel async-spawns on the
    // same (agent, session) serialize like /chat/send does. Pre-audit
    // 2026-05-16 they ran concurrently and interleaved JSONL events.
    const release = await acquireSessionLock(args.targetPersona, args.sessionId, {
      priority: 'agent',
      turnId: task_id,
    });
    // Abort controller for subagent_cancel: registered under the sub's
    // (agent, session) like a normal /chat/send turn, so the cancel
    // cascade can cut the in-flight LLM call via triggerChatAbort —
    // the same signal path the Stop button uses.
    const abort = registerChatAbort(args.targetPersona, args.sessionId);
    try {
      const result = await runChatTurn({
        agent: args.targetPersona,
        session: args.sessionId,
        text: args.taskText,
        subagentDepth: args.parentDepth + 1,
        signal: abort.signal,
        ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
        ...(args.maxRoundsOverride
          ? { agentLoopOverride: { maxRounds: args.maxRoundsOverride } }
          : {}),
        deps: injectedDeps!.chatTurnDeps,
      });
      // completeTask/failTask are no-ops when the task was already
      // cancelled — the registry state stays 'cancelled'.
      completeTask(task_id, result);
    } catch (err) {
      failTask(task_id, (err as Error).message);
    } finally {
      abort.release();
      release();
      // Release the concurrency slot reserved by runOneSpawn — the
      // background promise's lifetime IS the slot lifetime.
      releaseSpawnSlot(args.targetPersona);
    }
  })();
  return task_id;
}

/**
 * HTTP async dispatch: call /spawn-async on the localhost server. The
 * server registers the task and runs it in its own process; we just
 * return the task_id. status / result also go through HTTP later.
 */
async function spawnAsyncViaHttp(args: {
  targetAgent: string;
  targetSession: string;
  taskText: string;
  parentAgent: string;
  parentSession: string;
  parentDepth: number;
  modelOverride?: string;
  maxRoundsOverride?: number;
  attention?: boolean;
}): Promise<string> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  // SOMORA_TLS=1 → server is HTTP/2-over-TLS; loopback must use
  // https://<publicHost> (see runChatTurnViaHttp below).
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  let res;
  try {
    res = await loopbackFetch(`${scheme}://${host}:${port}/spawn-async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: args.targetAgent,
        session: args.targetSession,
        text: args.taskText,
        // Deliberately NO from_agent: a spawn task brief is not an A2A
        // message. Labeling it would render a peer-agent bubble + fire
        // unread badges in the sub's session, and the sub's engine
        // would frame the brief as inbound mail from the parent —
        // while the in-process async path and BOTH sync paths deliver
        // the same brief unlabeled. Parent attribution for the task
        // registry travels via parent_agent below (Juni-Audit 2026-07,
        // decision: briefs are neutral).
        parent_agent: args.parentAgent,
        parent_session: args.parentSession,
        subagent_depth: args.parentDepth + 1,
        ...(args.modelOverride ? { model: args.modelOverride } : {}),
        ...(args.maxRoundsOverride ? { max_rounds: args.maxRoundsOverride } : {}),
        ...(args.attention !== undefined ? { attention: args.attention } : {}),
      }),
    });
  } catch (err) {
    const c = classifyFetchError(err);
    throw new Error(
      `spawn-async [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}` +
        (c.hint ? ` — hint: ${c.hint}` : ''),
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`spawn-async HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { task_id: string };
  return data.task_id;
}

/**
 * MCP-child fallback: when spawn_subagent is invoked from inside a
 * claude-cli or codex-cli MCP server (configureSpawnTools never ran
 * here), reach back to the somora HTTP server on localhost. Same
 * inputs, same eventual JSONL state — just routed through HTTP rather
 * than a direct in-process call.
 *
 * Server host/port from SOMORA_HOST + SOMORA_PORT env (set by the
 * parent server on launch). Falls back to 127.0.0.1:18737.
 */
async function runChatTurnViaHttp(args: {
  agent: string;
  session: string;
  text: string;
  subagentDepth: number;
  /** Parent turn blocked on this call — registered in the server's A2A
   *  wait-graph for circular-wait detection. Deliberately NOT sent as
   *  from_agent: that would relabel the sub's task text as an A2A
   *  message in its session. */
  waiterAgent?: string;
  waiterSession?: string;
  modelOverride?: string;
  maxRounds?: number;
}): Promise<ChatTurnResult> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  // SOMORA_TLS=1 means the parent server is on HTTP/2-over-TLS — the
  // MCP child must reach back via https://<publicHost> rather than
  // plain HTTP loopback, since the cert is bound to that hostname.
  // SOMORA_HOST is rewritten to the publicHost FQDN by the parent at
  // startup when TLS is on, so this is just a scheme switch.
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  const url = `${scheme}://${host}:${port}/chat/send-sync`;
  let res;
  try {
    res = await loopbackFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: args.agent,
        session: args.session,
        text: args.text,
        subagent_depth: args.subagentDepth,
        ...(args.waiterAgent && args.waiterSession
          ? { waiter_agent: args.waiterAgent, waiter_session: args.waiterSession }
          : {}),
        ...(args.modelOverride ? { model: args.modelOverride } : {}),
        ...(args.maxRounds ? { max_rounds: args.maxRounds } : {}),
      }),
    });
  } catch (err) {
    const c = classifyFetchError(err);
    throw new Error(
      `spawn_subagent HTTP fallback [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}` +
        (c.hint ? ` — hint: ${c.hint}` : ''),
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`spawn_subagent HTTP fallback ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as ChatTurnResult;
  return data;
}

