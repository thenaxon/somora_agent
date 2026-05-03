// subagent_status / subagent_result — companion tools to
// spawn_subagent's wait:false (default) async path. Used by the
// orchestrator agent to poll progress and pull final results out.

import { z } from 'zod';
import { getTask, waitForTaskCompletion, type AsyncTaskEntry } from '../../server/async-tasks.ts';
import type { ChatTurnResult } from '../../server/run-turn-types.ts';
import type { ToolDefinition } from '../types.ts';

// In-process MCP child path runs without server-side task store
// access; we route status/result HTTP calls back to the main server
// just like spawn-async itself does.
async function fetchStatusViaHttp(task_id: string): Promise<AsyncTaskEntry | null> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const res = await fetch(
    `http://${host}:${port}/spawn-status?task_id=${encodeURIComponent(task_id)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`spawn-status HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as AsyncTaskEntry;
}

async function fetchResultViaHttp(
  task_id: string,
  opts: { wait_until_done?: boolean; timeout_ms?: number } = {},
): Promise<{ task_id: string; state: string; result?: ChatTurnResult; error?: string } | null> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const params = new URLSearchParams({ task_id });
  if (opts.wait_until_done) params.set('wait_until_done', '1');
  if (opts.timeout_ms !== undefined) params.set('timeout_ms', String(opts.timeout_ms));
  const res = await fetch(`http://${host}:${port}/spawn-result?${params.toString()}`);
  if (res.status === 404) return null;
  if (res.status === 409) {
    return (await res.json()) as { task_id: string; state: string; error?: string };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`spawn-result HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as { task_id: string; state: string; result?: ChatTurnResult };
}

const StatusInput = z.object({ task_id: z.string().min(1) }).strict();

export const subagentStatus: ToolDefinition<z.infer<typeof StatusInput>> = {
  name: 'subagent_status',
  toolset: 'agents',
  description:
    'Check the status of a sub-agent task spawned with wait:false. Returns running/done/failed ' +
    'plus the target agent + session and timestamps. Cheap — call this freely. Use it when ' +
    'the user asks about progress ("are the subs done yet?"). Use subagent_result to fetch the ' +
    'actual answer once state is "done".',
  inputSchema: StatusInput,
  jsonSchema: {
    type: 'object',
    properties: { task_id: { type: 'string', description: 'task_id from a wait:false spawn_subagent return value.' } },
    required: ['task_id'],
    additionalProperties: false,
  },
  async handler(input) {
    // In-process first; HTTP fallback if not present (MCP child path).
    let entry = getTask(input.task_id);
    if (!entry) {
      const remote = await fetchStatusViaHttp(input.task_id);
      if (!remote) throw new Error(`subagent_status: task '${input.task_id}' not found`);
      entry = remote;
    }
    return {
      task_id: entry.task_id,
      state: entry.state,
      parent_agent: entry.parent_agent,
      parent_session: entry.parent_session,
      target_agent: entry.target_agent,
      target_session: entry.target_session,
      started_at: entry.started_at,
      ...(entry.finished_at !== undefined ? { finished_at: entry.finished_at } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  },
};

const ResultInput = z
  .object({
    task_id: z.string().min(1),
    wait_until_done: z
      .boolean()
      .default(false)
      .describe(
        'When true, the tool blocks server-side until the task finishes (or timeout_ms elapses) ' +
          'instead of erroring on "still running". Use this to avoid burning your own ' +
          'agent-loop tool-call rounds on a polling loop.',
      ),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(60_000)
      .describe('Max ms to wait when wait_until_done. Default 60s, max 10min.'),
  })
  .strict();

export const subagentResult: ToolDefinition<z.infer<typeof ResultInput>> = {
  name: 'subagent_result',
  toolset: 'agents',
  description:
    'Fetch the final result of a completed sub-agent task. Returns the assistant text the sub ' +
    'produced plus token usage. ' +
    'Pass `wait_until_done: true` to block server-side until the task finishes — much more ' +
    'efficient than polling subagent_status in a loop, since each poll burns one of your own ' +
    'agent-loop tool-call rounds. Default `timeout_ms` is 60s (max 10min). ' +
    'Errors if the task is still running and wait_until_done is false (or timeout expired) — ' +
    'use subagent_status if you just want a quick non-blocking peek.',
  inputSchema: ResultInput,
  jsonSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      wait_until_done: { type: 'boolean', description: 'Block until task finishes. Default false.' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Max wait in ms. Default 60000.' },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  async handler(input) {
    let local = getTask(input.task_id);
    if (local) {
      if (local.state === 'running' && input.wait_until_done) {
        local = (await waitForTaskCompletion(input.task_id, input.timeout_ms)) ?? local;
      }
      if (local.state === 'running') {
        throw new Error(
          `subagent_result: task '${input.task_id}' still running — use subagent_status, ` +
            'or call again with wait_until_done:true to block server-side',
        );
      }
      if (local.state === 'failed') {
        return {
          task_id: local.task_id,
          state: 'failed',
          target_agent: local.target_agent,
          target_session: local.target_session,
          error: local.error ?? 'unknown error',
        };
      }
      return {
        task_id: local.task_id,
        state: 'done',
        target_agent: local.target_agent,
        target_session: local.target_session,
        result: local.result?.finalText ?? '',
        usage: local.result?.usage,
        ms: local.result?.ms,
      };
    }
    // HTTP fallback — pass the wait params through.
    const remote = await fetchResultViaHttp(input.task_id, {
      wait_until_done: input.wait_until_done,
      timeout_ms: input.timeout_ms,
    });
    if (!remote) throw new Error(`subagent_result: task '${input.task_id}' not found`);
    if (remote.state === 'running') {
      throw new Error(
        `subagent_result: task '${input.task_id}' still running — call again with wait_until_done:true to block`,
      );
    }
    if (remote.state === 'failed') {
      return {
        task_id: remote.task_id,
        state: 'failed',
        error: remote.error ?? 'unknown error',
      };
    }
    return {
      task_id: remote.task_id,
      state: 'done',
      result: remote.result?.finalText ?? '',
      usage: remote.result?.usage,
      ms: remote.result?.ms,
    };
  },
};
