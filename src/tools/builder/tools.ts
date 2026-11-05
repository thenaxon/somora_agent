// Builder tools (agent.yaml `kind: builder`, docs/builder.md):
//   todo_write  — the session's task list, shown in the task panel
//   ask_user    — a question with options, answered in the task panel
//   plan_write  — the plan file, the one write allowed in the plan phase
//   acceptance_write — the acceptance list: one item per requirement of
//                 the order, with status and evidence (builder-acceptance.ts)
//
// All four go through the main server over the loopback API (the same
// pattern as session_model), so they work from the in-process invoker
// and from the MCP child alike, and the server is the only writer of
// session state and the only publisher of the panel's SSE events.

import { z } from 'zod';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import { DEFAULT_QUESTION_TIMEOUT_MS, MAX_QUESTION_TIMEOUT_MS } from '../../server/builder-questions.ts';
import { CHAT_QUESTION_TIMEOUT_MS } from '../../server/ask-attended.ts';
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
      .describe(`How long a waiting question waits (default ${DEFAULT_QUESTION_TIMEOUT_MS / 60000} min for a builder, ${CHAT_QUESTION_TIMEOUT_MS / 60000} min for other agents).`),
  })
  .strict();

export const askUser: ToolDefinition<z.infer<typeof AskInput>> = {
  name: 'ask_user',
  // Every agent's, not only a builder's: asking the person is talking,
  // like agent_ask. Offered only while someone watches (sessionOffersAsk).
  toolset: 'agents',
  // The long text is a chat agent's; a builder sees its short one
  // (short-descriptions.ts), which keeps "only for a real fork".
  description:
    'Ask the person a question with 2-6 options; they see it as a card with a button per option and can ' +
    'also answer in their own words. Use it whenever you would end your reply with a question that has ' +
    'clear choices — "go on or stop here?", "which of these two?" — instead of writing the question as ' +
    'text. In a conversation with a person the call returns at once ({asked: true}): end your turn then; ' +
    'the answer arrives as their next message. When another agent system sent the task, the call waits ' +
    'and returns {answered, answers[], text?}; when unanswered, decide yourself and say what you decided. ' +
    'If you recommend an option, put it first and add "(Recommended)" to its label.',
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
      timeout_ms: { type: 'integer', description: 'How long a waiting question waits, in ms (default 30 min for a builder, 10 min for other agents).' },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
  timeoutFromInput: (input) => (input.timeout_ms ?? DEFAULT_QUESTION_TIMEOUT_MS) + 5_000,
  maxTimeoutMs: MAX_QUESTION_TIMEOUT_MS + 5_000,
  async handler(input, ctx) {
    const session = sessionOf(ctx, 'ask_user');
    return call<{ answered: boolean; answers: string[]; text?: string } | { asked: true; questionId: string; note: string }>(
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

// ── acceptance_write ────────────────────────────────────────────────

const AcceptanceInput = z
  .object({
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(20).describe('Stable id: A01, A02, … Never reuse an id for another requirement.'),
          requirement: z.string().max(500).optional().describe('The requirement in the words of the order. Needed when the item is new; an existing item keeps its first wording.'),
          status: z.string().min(1).describe('open | passed | failed | not_run'),
          evidence: z.string().max(1000).optional().describe('What shows the status: command and result, file, test, revision. Required for passed and failed.'),
        }),
      )
      .optional()
      .describe('The COMPLETE list — every call replaces it. Leave out to read the current list.'),
  })
  .strict();

export const acceptanceWrite: ToolDefinition<z.infer<typeof AcceptanceInput>> = {
  name: 'acceptance_write',
  toolset: 'builder',
  description:
    'Keep the acceptance list of this session: one item per requirement of the order (id A01, A02, …, the ' +
    'requirement in the words of the order), each with a status and the evidence. Not the task list — the task ' +
    'list says what you do, this list says what the order asked for and what shows it is met. Statuses: open, ' +
    'passed, failed, not_run. passed and failed need evidence: the command and its result, the file, the test, ' +
    'the revision — a test count alone is not evidence that a requirement holds; not_run needs the reason in ' +
    'evidence. When the session requires the list, an item without them is refused and keeps its status. Check the deciding counter-case ' +
    '(a rejected result, a real contradiction, an interrupted run), not only the happy path. Items cannot be ' +
    'removed or reworded, and accepted is not yours to set: the person or the orderer reviews. Send the whole ' +
    'list every time; an item that did not change goes as id and status only — it keeps its evidence and its review, ' +
    'while new evidence clears the review (an accepted item would need accepting again). Call without items to read it.',
  inputSchema: AcceptanceInput,
  jsonSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'The complete acceptance list (replaces the previous one). Leave out to read it.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable id: A01, A02, …' },
            requirement: { type: 'string', description: 'The requirement in the words of the order (new items).' },
            status: { type: 'string', description: 'open | passed | failed | not_run' },
            evidence: { type: 'string', description: 'Command and result, file, test, revision. Required for passed and failed.' },
          },
          required: ['id', 'status'],
        },
      },
    },
    additionalProperties: false,
  },
  defaultTimeoutMs: 15_000,
  async handler(input, ctx) {
    const session = sessionOf(ctx, 'acceptance_write');
    const path = `/agents/${encodeURIComponent(ctx.agent)}/sessions/${encodeURIComponent(session)}/acceptance`;
    if (!input.items) {
      let res;
      try {
        res = await loopbackFetch(`${baseUrl()}${path}`);
      } catch (err) {
        const c = classifyFetchError(err);
        throw new Error(`acceptance_write [${c.category}${c.code ? '/' + c.code : ''}]: ${c.message}`);
      }
      const data = (await res.json().catch(() => ({}))) as { items?: unknown[]; required?: boolean; error?: string };
      if (!res.ok) throw new Error(`acceptance_write: ${data.error ?? `HTTP ${res.status}`}`);
      return { ok: true, items: data.items ?? [], required: data.required === true };
    }
    const r = await call<{ items: Array<{ status: string }>; required: boolean; warnings: string[] }>('acceptance_write', 'PUT', path, {
      items: input.items,
      by_agent: ctx.agent,
    });
    const count = (s: string) => r.items.filter((i) => i.status === s).length;
    return {
      ok: true,
      count: r.items.length,
      passed: count('passed'),
      failed: count('failed'),
      open: count('open'),
      not_run: count('not_run'),
      ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}),
      items: r.items,
    };
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
  return [todoWrite, askUser, planWrite, acceptanceWrite] as ToolDefinition[];
}
