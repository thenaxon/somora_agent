// Builder tools (agent.yaml `kind: builder`, docs/builder.md):
//   todo_write  — the session's task list, shown in the task panel
//   ask_user    — a question with options, answered in the task panel
//   plan_write  — the plan file, the one write allowed in the plan phase
//
// All three go through the main server over the loopback API (the same
// pattern as session_model), so they work from the in-process invoker
// and from the MCP child alike, and the server is the only writer of
// session state and the only publisher of the panel's SSE events.

import { z } from 'zod';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import { DEFAULT_QUESTION_TIMEOUT_MS, MAX_QUESTION_TIMEOUT_MS } from '../../server/builder-questions.ts';
import type { ToolDefinition } from '../types.ts';

function baseUrl(): string {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
}

async function call<T>(tool: string, method: string, path: string, body: unknown): Promise<T> {
  let res;
  try {
    res = await loopbackFetch(`${baseUrl()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const c = classifyFetchError(err);
    throw new Error(`${tool} [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${tool}: ${data.error ?? `HTTP ${res.status}`}`);
  return data;
}

const sessionOf = (ctx: { agent: string; session?: string }, tool: string): string => {
  if (!ctx.session) throw new Error(`${tool}: not running inside a session`);
  return ctx.session;
};

// ── todo_write ──────────────────────────────────────────────────────

const TodoInput = z
  .object({
    todos: z
      .array(
        z.object({
          content: z.string().min(1).describe('Brief, specific, actionable description of the task.'),
          status: z.string().min(1).describe('pending | in_progress | completed | cancelled'),
          priority: z.string().optional().describe('high | medium | low'),
        }),
      )
      .describe('The COMPLETE task list — every call replaces the whole list.'),
  })
  .strict();

export const todoWrite: ToolDefinition<z.infer<typeof TodoInput>> = {
  name: 'todo_write',
  toolset: 'builder',
  description:
    'Create and maintain the task list of this session. The person sees it beside the chat. Send the WHOLE ' +
    'list every time. Use it when the work has 3+ distinct steps, when several tasks arrive, or when you ' +
    'discover follow-ups; skip it for a single small change. States: pending, in_progress (exactly ONE at a ' +
    'time), completed, cancelled. Mark a task in_progress before you start it and completed the moment it is ' +
    'really done — verified, not intended; never batch completions. If blocked, keep it in_progress and add ' +
    'a follow-up describing the blocker.',
  inputSchema: TodoInput,
  jsonSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list (replaces the previous one).',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Brief description of the task.' },
            status: { type: 'string', description: 'pending | in_progress | completed | cancelled' },
            priority: { type: 'string', description: 'high | medium | low' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 15_000,
  async handler(input, ctx) {
    const session = sessionOf(ctx, 'todo_write');
    const r = await call<{ todos: Array<{ content: string; status: string }> }>(
      'todo_write',
      'PUT',
      `/agents/${encodeURIComponent(ctx.agent)}/sessions/${encodeURIComponent(session)}/todos`,
      { todos: input.todos, by_agent: ctx.agent },
    );
    const open = r.todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length;
    return { ok: true, count: r.todos.length, open, todos: r.todos };
  },
};

// ── ask_user ────────────────────────────────────────────────────────

const AskInput = z
  .object({
    question: z.string().min(1).describe('The complete question.'),
    header: z.string().max(40).optional().describe('Very short label for the panel (max 40 chars).'),
    options: z
      .array(
        z.object({
          label: z.string().min(1).describe('Display text, 1-5 words.'),
          description: z.string().optional().describe('What choosing this means.'),
        }),
      )
      .min(2)
      .max(6)
      .describe('2-6 choices. A free-text answer is always possible too — do not add an "other" option.'),
    multiple: z.boolean().optional().describe('Allow choosing more than one option.'),
    timeout_ms: z
      .number()
      .int()
      .min(10_000)
      .max(MAX_QUESTION_TIMEOUT_MS)
      .optional()
      .describe(`How long to wait for the person (default ${DEFAULT_QUESTION_TIMEOUT_MS / 60000} min).`),
  })
  .strict();

export const askUser: ToolDefinition<z.infer<typeof AskInput>> = {
  name: 'ask_user',
  toolset: 'builder',
  description:
    'Ask the person watching this session a question with options; the call waits for the answer (or a ' +
    'timeout) and returns it. Use it for a real fork in the road you cannot decide from the code or the ' +
    'task — never for "should I proceed?" or routine choices. If you recommend an option, put it first and ' +
    'add "(Recommended)" to its label. Returns {answered, answers[], text?}; when unanswered, decide ' +
    'yourself and note the decision in your report. Only offered while the session is attended.',
  inputSchema: AskInput,
  jsonSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The complete question.' },
      header: { type: 'string', description: 'Very short label (max 40 chars).' },
      options: {
        type: 'array',
        description: '2-6 choices; a free-text answer is always possible too.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Display text, 1-5 words.' },
            description: { type: 'string', description: 'What choosing this means.' },
          },
          required: ['label'],
        },
      },
      multiple: { type: 'boolean', description: 'Allow more than one choice.' },
      timeout_ms: { type: 'integer', description: 'Wait time in ms (default 30 min).' },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
  timeoutFromInput: (input) => (input.timeout_ms ?? DEFAULT_QUESTION_TIMEOUT_MS) + 5_000,
  maxTimeoutMs: MAX_QUESTION_TIMEOUT_MS + 5_000,
  async handler(input, ctx) {
    const session = sessionOf(ctx, 'ask_user');
    return call<{ answered: boolean; answers: string[]; text?: string }>(
      'ask_user',
      'POST',
      `/agents/${encodeURIComponent(ctx.agent)}/sessions/${encodeURIComponent(session)}/ask`,
      {
        question: input.question,
        ...(input.header ? { header: input.header } : {}),
        options: input.options,
        multiple: input.multiple === true,
        ...(input.timeout_ms ? { timeout_ms: input.timeout_ms } : {}),
      },
    );
  },
};

// ── plan_write ──────────────────────────────────────────────────────

const PlanInput = z
  .object({
    content: z.string().min(1).describe('The whole plan, Markdown. Replaces the file.'),
  })
  .strict();

export const planWrite: ToolDefinition<z.infer<typeof PlanInput>> = {
  name: 'plan_write',
  toolset: 'builder',
  description:
    'Write the plan file of this session (the path is in your prompt under "Mode and phase"). The one ' +
    'file you may write in the PLAN phase; in the BUILD phase use it to record plan changes. Content is ' +
    'Markdown: goal, steps in order, files to touch, how to verify, open risks and decisions. Replaces ' +
    'the whole file.',
  inputSchema: PlanInput,
  jsonSchema: {
    type: 'object',
    properties: { content: { type: 'string', description: 'The whole plan (Markdown).' } },
    required: ['content'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 15_000,
  async handler(input, ctx) {
    const session = sessionOf(ctx, 'plan_write');
    return call<{ path: string; bytes: number }>(
      'plan_write',
      'PUT',
      `/agents/${encodeURIComponent(ctx.agent)}/sessions/${encodeURIComponent(session)}/plan`,
      { content: input.content, by_agent: ctx.agent },
    );
  },
};

export function builderTools(): ToolDefinition[] {
  return [todoWrite, askUser, planWrite] as ToolDefinition[];
}
