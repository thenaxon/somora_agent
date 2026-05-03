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

import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { loadPersona } from '../../persona/loader.ts';
import { logger } from '../../server/logger.ts';
import type { ChatTurnResolveDeps, ChatTurnResult } from '../../server/run-turn-types.ts';
import { runChatTurn } from '../../server/run-turn.ts';
import type { ToolDefinition } from '../types.ts';

const MAX_SUBAGENT_DEPTH = parseInt(process.env.SOMORA_MAX_SUBAGENT_DEPTH ?? '3', 10) || 3;
const MAX_CONCURRENT_PER_AGENT = 4;
const MAX_CONCURRENT_GLOBAL = 16;

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

// Process-wide concurrency tracker. Survives only as long as the
// somora process — sub-spawns across server restarts are fresh starts.
const activeByAgent = new Map<string, number>();
let activeGlobal = 0;

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
    .describe('Target agent name. Omit to spawn a clone of the caller (Hans → Hans-clone).'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe('Model alias or "provider/modelId" override. Omit to use the persona\'s default.'),
  task: z.string().min(1),
});

// ─────────────────────────────────────────────────────────────────────
// spawn_subagent (single)
// ─────────────────────────────────────────────────────────────────────

const SingleInput = TaskSchema.extend({
  wait: z
    .boolean()
    .default(true)
    .describe('When true (default), block until the sub returns its final answer.'),
}).strict();

export const spawnSubagent: ToolDefinition<z.infer<typeof SingleInput>> = {
  name: 'spawn_subagent',
  toolset: 'agents',
  description:
    'Spawn a sub-agent to handle a sealed task. The sub runs in a fresh session of the ' +
    'target persona (defaults to a clone of you), goes through normal memory+tool+thinking ' +
    'flow, and returns its final answer. Use this for delegations like "ask Lisa to find X" ' +
    'or for self-spawns when you want a clean slate to research something. ' +
    'Depth cap: 3 (a sub itself can spawn further subs up to that limit). ' +
    'Per-agent concurrent cap: 4. Cross-engine OK — Hans-on-opus can spawn Lisa-on-gpt55. ' +
    'Sub sessions stay visible in /sessions of the target persona with a "sub from X/Y" marker.',
  inputSchema: SingleInput,
  jsonSchema: {
    type: 'object',
    properties: {
      persona: {
        type: 'string',
        description: 'Target agent name (e.g. "lisa", "jarvis"). Omit for a clone of yourself.',
      },
      model: {
        type: 'string',
        description: 'Model alias or "provider/modelId" — omit to use the persona\'s default.',
      },
      task: { type: 'string', description: 'The task / question for the sub. Will become its first user message.' },
      wait: { type: 'boolean', description: 'Block until sub returns. Default true.' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const result = await runOneSpawn({
      ctx,
      task: { task: input.task, ...(input.persona ? { persona: input.persona } : {}), ...(input.model ? { model: input.model } : {}) },
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
            model: { type: 'string' },
            task: { type: 'string' },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const settled = await Promise.allSettled(
      input.tasks.map((t) => runOneSpawn({ ctx, task: t })),
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

export function agentTools(): ToolDefinition[] {
  return [spawnSubagent, spawnSubagents] as ToolDefinition[];
}

// ─────────────────────────────────────────────────────────────────────
// shared spawn machinery
// ─────────────────────────────────────────────────────────────────────

interface OneSpawnArgs {
  ctx: import('../types.ts').ToolContext;
  task: { persona?: string; model?: string; task: string };
}

interface OneSpawnResult {
  ok: boolean;
  persona: string;
  agent_kind: 'self-clone' | 'named';
  session_slug: string;
  model: string;
  result?: string;
  error?: string;
  ms: number;
  thinkingActive: boolean;
}

async function runOneSpawn(args: OneSpawnArgs): Promise<OneSpawnResult> {
  if (!injectedDeps) {
    throw new Error('spawn_subagent: server not initialized — configureSpawnTools() not called');
  }
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
  // Concurrency
  if (activeGlobal >= MAX_CONCURRENT_GLOBAL) {
    throw new Error(`spawn_subagent: global concurrent cap (${MAX_CONCURRENT_GLOBAL}) reached`);
  }
  const perAgent = activeByAgent.get(targetPersona) ?? 0;
  if (perAgent >= MAX_CONCURRENT_PER_AGENT) {
    throw new Error(
      `spawn_subagent: per-agent concurrent cap for '${targetPersona}' (${MAX_CONCURRENT_PER_AGENT}) reached`,
    );
  }

  // Slug + session-meta
  const ts = formatTimestampWithMs(new Date());
  const slug = isSelfClone
    ? `sub-self-${ts}`
    : `sub-${ctx.agent}-${ts}`;
  const sessionId = slug; // session id for non-main is its filename stem
  await ensureSessionFile(targetPersona, sessionId, {
    slug,
    spawn: {
      kind: isSelfClone ? 'self-sub' : 'sub',
      parent_agent: ctx.agent,
      parent_session: ctx.session ?? '?',
      task_summary: task.task.slice(0, 200),
    },
  });

  // Concurrency bookkeeping
  activeByAgent.set(targetPersona, perAgent + 1);
  activeGlobal++;
  try {
    logger.info({
      msg: 'spawn_subagent.start',
      parent_agent: ctx.agent,
      parent_session: ctx.session,
      target: targetPersona,
      session: sessionId,
      depth: parentDepth + 1,
    });
    const result: ChatTurnResult = await runChatTurn({
      agent: targetPersona,
      session: sessionId,
      text: task.task,
      subagentDepth: parentDepth + 1,
      ...(task.model ? { modelOverride: task.model } : {}),
      deps: injectedDeps.chatTurnDeps,
      // No publishSse — sub-flow is silent. Parent's spawn_subagent
      // tool-call is what shows up in the parent's stream; the sub's
      // events flow into the sub's session JSONL only.
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
    activeGlobal--;
    activeByAgent.set(targetPersona, perAgent); // restore prior count
  }
}

function formatTimestampWithMs(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

async function ensureSessionFile(
  agent: string,
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  // Sessions live at <SOMORA_HOME>/agents/<agent>/sessions/<id>.{jsonl,meta.json}.
  // We touch the JSONL so listSessions picks it up before any events
  // land, and write the meta with the spawn marker so /sessions
  // listings can show "sub from ...".
  const dir = join(SOMORA_HOME, 'agents', agent, 'sessions');
  await mkdir(dir, { recursive: true });
  const jsonl = join(dir, `${sessionId}.jsonl`);
  const metaPath = join(dir, `${sessionId}.meta.json`);
  await writeFile(jsonl, '', { flag: 'wx' }).catch(() => {
    /* already exists — fine, runChatTurn will append */
  });
  await writeFile(
    metaPath,
    JSON.stringify(
      { ...meta, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    'utf8',
  );
}
