// builder_dispatch — hand a build order to a builder agent in one call.
//
// What an orchestrator used to assemble by hand (create a session, pin
// the project, brief, then poll a terminal) is one tool: a fresh session
// on the builder, the project pinned (its folder becomes the working
// directory), the session set to unattended + build, and the order sent
// as an agent_ask with wait:false — so the caller is woken with the
// builder's report when it lands, exactly like any other agent answer,
// and reads it with agent_ask_result. Nothing in between: no interim
// check-ins, no corrections into running work. A correction is a new
// message into that session (steer or next turn).

import { z } from 'zod';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import { listAgents, loadPersona } from '../../persona/loader.ts';
import { projectWorkdir } from '../../projects/focus.ts';
import type { ToolDefinition } from '../types.ts';
import { agentAsk } from './ask.ts';

const Input = z
  .object({
    builder: z
      .string()
      .min(1)
      .optional()
      .describe('Name of the builder agent (kind: builder). Optional when exactly one builder exists; with several, choose by their team description (the result of a missing name lists them).'),
    task: z
      .string()
      .min(1)
      .describe(
        'The complete order: what to build or change, in which repository, what "done" means, where to write the report. ' +
          'The builder sees nothing of your conversation — give it everything.',
      ),
    project: z
      .string()
      .min(1)
      .optional()
      .describe('Project slug to pin on the builder session. A project with `workdir` makes that folder the working directory.'),
    plan_path: z.string().min(1).optional().describe('Absolute path of an already written plan file the builder must read first.'),
    done_criteria: z.string().min(1).optional().describe('What "done" means, e.g. "tests green and the CLI prints the new column". Appended to the order.'),
    report_path: z.string().min(1).optional().describe('Absolute path the builder writes its report to at the end (besides answering).'),
    mode: z
      .enum(['attended', 'unattended'])
      .optional()
      .describe('Default unattended: the builder decides open points itself. attended: it may ask the person via ask_user.'),
    phase: z
      .enum(['plan', 'build'])
      .optional()
      .describe('Default build (the order is complete, go). plan: the builder first reads and writes a plan file, then stops with "Plan ready"; the person presses Go in the task panel (or you send the next message) to start the build.'),
    session: z
      .string()
      .min(1)
      .optional()
      .describe('Slug for the new builder session (default: build-<project or ts>-<rand>).'),
    timeout_ms: z.number().int().min(1_000).max(7_200_000).optional().describe('Passed to agent_ask (wait:false — the wake comes when the report lands).'),
  })
  .strict();

function baseUrl(): string {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
}

async function call<T>(method: string, path: string, body: unknown): Promise<T> {
  let res;
  try {
    res = await loopbackFetch(`${baseUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const c = classifyFetchError(err);
    throw new Error(`builder_dispatch [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`builder_dispatch: ${data.error ?? `HTTP ${res.status}`}`);
  return data;
}

async function get<T>(path: string): Promise<T> {
  let res;
  try {
    res = await loopbackFetch(`${baseUrl()}${path}`);
  } catch (err) {
    const c = classifyFetchError(err);
    throw new Error(`builder_dispatch [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`builder_dispatch: ${data.error ?? `HTTP ${res.status}`}`);
  return data;
}

/** The builder to use: the named one, or the only one there is. With
 *  several and no name, the error lists them so the caller can choose. */
export async function resolveBuilderName(named: string | undefined): Promise<string> {
  if (named) return named;
  const builders = (await listAgents()).filter((a) => a.kind === 'builder');
  if (builders.length === 1) return builders[0]!.name;
  if (builders.length === 0) throw new Error('builder_dispatch: no builder agent exists (an agent with kind: builder in its agent.yaml)');
  const list = builders.map((b) => `${b.name}${b.role ? ` (${b.role})` : ''}: ${b.description.split('\n')[0]?.slice(0, 120) ?? ''}`).join('; ');
  throw new Error(`builder_dispatch: several builders exist — name one in \`builder\`, chosen by its team description: ${list}`);
}

export function composeBuildOrder(input: { task: string; plan_path?: string; done_criteria?: string; report_path?: string; phase?: 'plan' | 'build' }): string {
  const parts: string[] = [];
  if (input.phase === 'plan') {
    parts.push(input.task.trim());
    if (input.done_criteria) parts.push(`Done means: ${input.done_criteria.trim()}`);
    parts.push(
      'Plan first: read the repository and write the plan with plan_write (goal, steps in order, files to touch, how to verify, open risks). ' +
        'Do not change any file yet. When the plan is complete say "Plan ready" and stop; the build starts with Go.' +
        (input.report_path ? ` The report at the end goes to ${input.report_path}.` : ''),
    );
    return parts.join('\n\n');
  }
  if (input.plan_path) parts.push(`Read the plan at ${input.plan_path} first and follow it.`);
  parts.push(input.task.trim());
  if (input.done_criteria) parts.push(`Done means: ${input.done_criteria.trim()}`);
  if (input.report_path) parts.push(`At the end write your report to ${input.report_path} with file_write, and give the same report as your answer.`);
  parts.push('Decide open questions yourself and list every decision in the report. Do not stop for approval.');
  return parts.join('\n\n');
}

export const builderDispatch: ToolDefinition<z.infer<typeof Input>> = {
  name: 'builder_dispatch',
  toolset: 'agents',
  description:
    'Hand a build order to a builder agent (kind: builder) in one call: creates a fresh session on it, pins the ' +
    'project (its folder becomes the working directory), sets the session to unattended + build, and sends the ' +
    'order. Returns at once with a call_id; you are woken with the builder\'s report when it is done (read it with ' +
    'agent_ask_result). Give the COMPLETE order — repository or project, what to build, what done means, where the ' +
    'report goes; the builder sees nothing of this conversation. Do not check in on it or send corrections into ' +
    'running work: wait for the report, then send a new message into that session if something must change. ' +
    'One builder per project folder at a time: a folder another builder is working in is refused (wait for that report). ' +
    'Several builders: choose by their team description; two orders to different folders may run at the same time.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      builder: { type: 'string', description: 'Builder agent name (kind: builder). Optional when exactly one builder exists.' },
      task: { type: 'string', description: 'The complete order — everything the builder needs.' },
      project: { type: 'string', description: 'Project slug to pin (its `workdir` becomes the working directory).' },
      plan_path: { type: 'string', description: 'Absolute path of a plan file to read first.' },
      done_criteria: { type: 'string', description: 'What "done" means.' },
      report_path: { type: 'string', description: 'Absolute path for the written report.' },
      mode: { type: 'string', enum: ['attended', 'unattended'], description: 'Default unattended.' },
      phase: { type: 'string', enum: ['plan', 'build'], description: 'Default build. plan = plan first, then wait for Go.' },
      session: { type: 'string', description: 'Slug for the new builder session.' },
      timeout_ms: { type: 'integer', description: 'Passed to agent_ask.' },
    },
    required: ['task'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 60_000,
  async handler(input, ctx) {
    const builderName = await resolveBuilderName(input.builder);
    const persona = await loadPersona(builderName);
    if (!persona) throw new Error(`builder_dispatch: agent '${builderName}' not found`);
    if (persona.kind !== 'builder') {
      throw new Error(`builder_dispatch: '${builderName}' is a ${persona.kind} agent, not a builder — use agent_ask for it`);
    }
    // One builder per folder: a project whose folder another builder is
    // working in right now is refused before anything is created.
    if (input.project) {
      const folder = await projectWorkdir(input.project);
      if (folder) {
        const q = await get<{ busy: { agent: string; session: string; reason: string } | null }>(`/builders/busy?workdir=${encodeURIComponent(folder)}`);
        if (q.busy) throw new Error(`builder_dispatch: folder busy — ${q.busy.reason}`);
      }
    }
    const rand = Math.random().toString(36).slice(2, 6);
    const slug = (input.session ?? `build-${input.project ?? new Date().toISOString().slice(0, 10)}-${rand}`).replace(/[^A-Za-z0-9_-]/g, '-');
    const b = encodeURIComponent(builderName);
    const created = await call<{ id: string }>('POST', `/agents/${b}/sessions`, { slug });
    const sid = encodeURIComponent(created.id);
    if (input.project) {
      await call('POST', `/agents/${b}/sessions/${sid}/project`, { slug: input.project });
    }
    const phase = input.phase ?? 'build';
    await call('PATCH', `/agents/${b}/sessions/${sid}/builder`, {
      mode: input.mode ?? 'unattended',
      phase,
      ...(input.plan_path ? { planPath: input.plan_path } : {}),
      // Go (after a plan phase) wakes this agent with the report.
      orderer: { agent: ctx.agent, ...(ctx.session ? { session: ctx.session } : {}) },
    });
    const order = composeBuildOrder({ ...input, phase });
    const ask = await agentAsk.handler(
      {
        agent: builderName,
        message: order,
        session: created.id,
        wait: false,
        ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
      } as Parameters<typeof agentAsk.handler>[0],
      ctx,
    );
    return {
      ok: true,
      builder: builderName,
      session: created.id,
      slug,
      ...(input.project ? { project: input.project } : {}),
      mode: input.mode ?? 'unattended',
      phase,
      dispatch: ask,
      note:
        phase === 'plan'
          ? 'The builder plans in its own session and stops with "Plan ready" — you are woken with the plan ([agent answer]). Then the person presses Go in the task panel, or you send the next message into that session (POST …/builder/go starts the build).'
          : 'The builder works in its own session; you will be woken with its report ([agent answer]). ' +
            'Read it with agent_ask_result(call_id). Corrections go as a new message into that session.',
    };
  },
};
