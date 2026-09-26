// Mid-turn compaction for builder turns (openai-compatible engine).
//
// A chat turn ends after a few rounds; the pre-turn compaction sizes the
// conversation once, and when a turn still grows past the window the
// oldest tool results are shortened (context-budget.ts). A builder's
// turn is hundreds of rounds, and its state — which file was patched,
// which test went red, what the plan says now — lives in exactly those
// tool results. Shortening them blank is how a build forgets what it
// did.
//
// So a builder turn compacts itself the way opencode does: when the
// estimate for the next request exceeds the budget, the older rounds of
// THIS turn (from the turn's user message up to the last `keepRounds`
// rounds) are summarised by a worker model into a work-state block, and
// replaced by one user message carrying that block. The last rounds stay
// verbatim so the model keeps its immediate context. The session file is
// untouched — this shapes the request, not the record.

import type { ResolvedModel } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { rankCompactionModels, summarizeViaEngine, SUMMARIZE_ENGINES } from './summarize.ts';
import type { CompactionConfig } from './types.ts';

/** Any chat message shape the engine keeps in its loop. */
export interface LoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

const RESULT_MAX_CHARS = 1500;
const TEXT_MAX_CHARS = 3000;

function asText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string' ? (p as { text: string }).text : '[non-text part]'))
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} … [cut ${s.length - n} chars]` : s);

/** The rounds to compact, rendered as a transcript for the worker. */
export function renderRoundsTranscript(messages: LoopMessage[]): string {
  const names = new Map<string, string>();
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push(`[User]: ${cut(asText(m.content), TEXT_MAX_CHARS)}`);
    else if (m.role === 'assistant') {
      const text = asText(m.content).trim();
      if (text) out.push(`[Assistant]: ${cut(text, TEXT_MAX_CHARS)}`);
      for (const c of m.tool_calls ?? []) {
        const name = c.function?.name ?? 'tool';
        if (c.id) names.set(c.id, name);
        out.push(`[Assistant tool call]: ${name}(${cut(c.function?.arguments ?? '', 600)})`);
      }
    } else if (m.role === 'tool') {
      const name = (m.tool_call_id && names.get(m.tool_call_id)) ?? 'tool';
      out.push(`[Tool result ${name}]: ${cut(asText(m.content), RESULT_MAX_CHARS)}`);
    }
  }
  return out.join('\n');
}

export const WORK_STATE_TEMPLATE = [
  'You summarise the work an engineering agent did so far in ONE turn, so',
  'that the same agent can continue with the summary in place of the',
  'transcript. Output exactly the Markdown structure below, section order',
  'unchanged, terse bullets, exact file paths, symbols, commands and error',
  'strings preserved. Invent nothing. Do not mention the summarising.',
  '',
  '## Objective',
  '- [what the turn is trying to accomplish]',
  '',
  '## Important Details',
  '- [constraints, decisions and why, facts needed to continue, or "(none)"]',
  '',
  '## Work State',
  '### Completed',
  '- [finished, verified work and changes made, or "(none)"]',
  '### Active',
  '- [current work, partial changes, investigation state, or "(none)"]',
  '### Blocked',
  '- [blockers, failing commands, unknowns, or "(none)"]',
  '',
  '## Next Move',
  '1. [immediate concrete action, or "(none)"]',
  '2. [next action if known, or "(none)"]',
  '',
  '## Relevant Files',
  '- [file or directory path: why it matters, or "(none)"]',
].join('\n');

/** Find the loop-message index where the last `keepRounds` rounds start
 *  (a round starts with an assistant message carrying tool_calls). */
export function lastRoundsStart(messages: LoopMessage[], from: number, keepRounds: number): number {
  const starts: number[] = [];
  for (let i = from; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0) starts.push(i);
  }
  if (starts.length <= keepRounds) return -1;
  return starts[starts.length - keepRounds]!;
}

export interface MidturnCompactionInput {
  messages: LoopMessage[];
  /** Index of this turn's user message in `messages`. */
  turnStartIdx: number;
  keepRounds: number;
  resolvedModel: ResolvedModel;
  availableModels: ResolvedModel[];
  config: CompactionConfig;
  agent: string;
  /** The builder's task list as last written with todo_write. It goes
   *  into the block verbatim: a summary tends to drop it, and a model
   *  that no longer sees its list stops keeping it (observed 2026-09-23:
   *  one todo_write before the compaction, none after). */
  todos?: ReadonlyArray<{ content: string; status: string; priority?: string }>;
  /** Test seam. */
  summarize?: (worker: ResolvedModel, system: string, user: string) => Promise<{ text: string }>;
}

export interface MidturnCompactionResult {
  messages: LoopMessage[];
  summary: string;
  compactedMessages: number;
  worker: string;
}

/**
 * Replace the older rounds of the running turn with a work-state
 * summary. Returns null when there is nothing to compact yet (fewer
 * than keepRounds + 1 rounds) or no worker fits.
 */
/** The task list, appended to the compaction block so the model keeps it. */
export function renderTodoReminder(todos: MidturnCompactionInput['todos']): string {
  if (!todos || todos.length === 0) return '';
  const lines = todos.map((t) => `- [${t.status}] ${t.content}`);
  return (
    '\n\nYour task list as last written with todo_write (the person sees it):\n' +
    lines.join('\n') +
    '\nKeep it current: mark what is done completed, the step you take next in_progress, and rewrite it with todo_write as you go.'
  );
}

export async function compactTurnMidway(input: MidturnCompactionInput): Promise<MidturnCompactionResult | null> {
  const { messages, turnStartIdx, keepRounds } = input;
  const cutAt = lastRoundsStart(messages, turnStartIdx + 1, keepRounds);
  if (cutAt < 0 || cutAt <= turnStartIdx + 1) return null;
  const older = messages.slice(turnStartIdx, cutAt);
  const transcript = renderRoundsTranscript(older);
  const user = [
    'Here is the transcript of the work so far in this turn:',
    '',
    '<transcript>',
    transcript,
    '</transcript>',
    '',
    'Write the work-state summary now.',
  ].join('\n');
  const estimate = Math.ceil((WORK_STATE_TEMPLATE.length + user.length) / 4);
  const candidates = input.availableModels.filter((m) => SUMMARIZE_ENGINES.has(m.provider.engine));
  const ranked = rankCompactionModels(estimate, candidates, {
    workers: input.config.workers,
    ...(input.config.preferSessionModel ? { sessionModel: input.resolvedModel } : {}),
  });
  let summary: string | null = null;
  let workerName = '';
  for (const worker of ranked.slice(0, 3)) {
    try {
      const r = input.summarize
        ? await input.summarize(worker, WORK_STATE_TEMPLATE, user)
        : await summarizeViaEngine(worker.provider.engine, {
            systemPrompt: WORK_STATE_TEMPLATE,
            userPrompt: user,
            resolvedModel: worker,
            agent: input.agent,
          });
      if (r.text.trim()) {
        summary = r.text.trim();
        workerName = `${worker.providerName}/${worker.modelId}`;
        break;
      }
    } catch (err) {
      logger.warn({ msg: 'compaction.midturn_worker_failed', agent: input.agent, worker: `${worker.providerName}/${worker.modelId}`, err: (err as Error).message });
    }
  }
  if (!summary) return null;
  const original = messages[turnStartIdx]!;
  const block: LoopMessage = {
    role: 'user',
    content:
      '[somora] The earlier part of this turn was compacted to keep the conversation inside the model\'s context window. ' +
      'The tools listed there already ran — do not run them again. Continue from "Next Move".\n\n' +
      summary +
      renderTodoReminder(input.todos),
  };
  const next = [...messages.slice(0, turnStartIdx), original, block, ...messages.slice(cutAt)];
  return { messages: next, summary, compactedMessages: older.length - 1, worker: workerName };
}
