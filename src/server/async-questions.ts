// Questions that do not wait (docs/agents.md "Asking the person"): a
// chat agent's ask_user in a turn a person started, and Codex's own
// request_user_input_async. The turn goes on and ends; the question stays
// open in the session meta — through a reload and a restart — until the
// person answers it (a click on an option, sent as their next message) or
// simply writes something else. One open question per session; a newer
// one replaces it.
//
// The waiting kind (a builder's ask_user, an external agent's permission
// request, a task from another agent system) stays in builder-questions.ts:
// a tool call blocks on it, so it lives in memory with its turn.

import { randomUUID } from 'node:crypto';
import { sessionMetaStore } from '../storage/sessions.ts';
import type { PendingQuestion, QuestionOption, QuestionPart } from './builder-questions.ts';
import { logger } from './logger.ts';
import { broadcastToSession, startTurn } from './start-turn.ts';
import { DequeuedError } from './session-queue.ts';
import type { SseEvent } from '../types/events.ts';
import type { TurnOrigin } from './turn-origin-kind.ts';
import { openWork } from './work-ledger.ts';

export const OPEN_QUESTION_KEY = 'openQuestion';

const MAX_PARTS = 6;

function cleanOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionOption[] = [];
  for (const o of raw) {
    const label = typeof o === 'string' ? o : o && typeof o === 'object' ? (o as { label?: unknown }).label : undefined;
    if (typeof label !== 'string' || !label.trim()) continue;
    const description = o && typeof o === 'object' ? (o as { description?: unknown }).description : undefined;
    out.push({ label: label.trim().slice(0, 80), ...(typeof description === 'string' && description ? { description: description.slice(0, 300) } : {}) });
    if (out.length >= 6) break;
  }
  return out;
}

/** The parts of a question, cleaned: text required, options optional
 *  (none: the person answers in their own words). */
export function cleanParts(raw: unknown): QuestionPart[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionPart[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const x = p as { question?: unknown; header?: unknown; options?: unknown; multiple?: unknown };
    if (typeof x.question !== 'string' || !x.question.trim()) continue;
    out.push({
      question: x.question.trim().slice(0, 2000),
      ...(typeof x.header === 'string' && x.header.trim() ? { header: x.header.trim().slice(0, 40) } : {}),
      options: cleanOptions(x.options),
      multiple: x.multiple === true,
    });
    if (out.length >= MAX_PARTS) break;
  }
  return out;
}

function readStored(meta: Record<string, unknown>): PendingQuestion | null {
  const q = meta[OPEN_QUESTION_KEY] as PendingQuestion | undefined;
  if (!q || typeof q !== 'object' || typeof q.id !== 'string' || typeof q.question !== 'string' || !Array.isArray(q.options)) return null;
  return q;
}

/** The open non-waiting question of a session, or null. */
export async function openAsyncQuestion(agent: string, session: string): Promise<PendingQuestion | null> {
  return readStored((await sessionMetaStore.get(agent, session)) as Record<string, unknown>);
}

/** The SSE `question_asked` payload of a question. */
export function questionAskedData(q: PendingQuestion): Extract<SseEvent, { event: 'question_asked' }>['data'] {
  return {
    questionId: q.id,
    question: q.question,
    ...(q.header ? { header: q.header } : {}),
    options: q.options,
    multiple: q.multiple,
    expiresAt: q.expiresAt,
    ...(q.async ? { async: true as const } : {}),
    ...(q.parts ? { parts: q.parts } : {}),
    ...(q.source ? { source: q.source } : {}),
  };
}

/** Open a question that does not wait. Replaces an open one. */
export async function askWithoutWaiting(args: { agent: string; session: string; parts: QuestionPart[]; source: 'ask_user' | 'codex' }): Promise<PendingQuestion> {
  const { agent, session } = args;
  const parts = args.parts.slice(0, MAX_PARTS);
  const first = parts[0];
  if (!first) throw new Error('a question needs at least one part');
  const q: PendingQuestion = {
    id: randomUUID(),
    agent,
    session,
    question: first.question,
    ...(first.header ? { header: first.header } : {}),
    options: first.options,
    multiple: first.multiple,
    askedAt: Date.now(),
    expiresAt: 0,
    async: true,
    ...(parts.length > 1 ? { parts } : {}),
    source: args.source,
  };
  let prior: PendingQuestion | null = null;
  await sessionMetaStore.update(agent, session, (m) => {
    prior = readStored(m as Record<string, unknown>);
    return { ...m, [OPEN_QUESTION_KEY]: q };
  });
  const replaced = prior as PendingQuestion | null;
  if (replaced) {
    await broadcastToSession(agent, session, { event: 'question_answered', data: { questionId: replaced.id, answered: false } });
  }
  logger.info({ msg: 'question.asked_async', agent, session, questionId: q.id, source: args.source, parts: parts.length, options: first.options.length, replaced: replaced?.id ?? null });
  await broadcastToSession(agent, session, { event: 'question_asked', data: questionAskedData(q) });
  return q;
}

export interface AsyncAnswer {
  answers?: string[];
  text?: string;
  /** Per part, for a question with several parts (same order). */
  parts?: Array<{ answers?: string[]; text?: string }>;
}

function oneAnswer(a: { answers?: string[]; text?: string } | undefined): string {
  // "(Recommended)" is the agent's note on its own option, not part of
  // what the person says.
  const labels = (a?.answers ?? [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.replace(/\s*\(recommended\)\s*$/i, '').trim() || x.trim());
  const text = typeof a?.text === 'string' ? a.text.trim() : '';
  if (labels.length > 0 && text) return `${labels.join(', ')} — ${text}`;
  return labels.length > 0 ? labels.join(', ') : text;
}

/** The message an answer becomes: the choice alone for one question,
 *  each question with its answer for several. Null when nothing was
 *  chosen or typed. */
export function composeAnswerMessage(q: PendingQuestion, answer: AsyncAnswer): string | null {
  if (!q.parts || q.parts.length < 2) {
    const s = oneAnswer(answer.parts?.[0] ?? answer);
    return s ? s : null;
  }
  const blocks: string[] = [];
  q.parts.forEach((p, i) => {
    const s = oneAnswer(answer.parts?.[i]);
    if (s) blocks.push(`${p.question}\n→ ${s}`);
  });
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/** Take the open question off the session if it is `questionId` (any,
 *  without an id). Returns the question taken, or null. */
async function takeQuestion(agent: string, session: string, questionId?: string): Promise<PendingQuestion | null> {
  let taken: PendingQuestion | null = null;
  await sessionMetaStore.update(agent, session, (m) => {
    const q = readStored(m as Record<string, unknown>);
    if (!q || (questionId && q.id !== questionId)) return m;
    taken = q;
    const next = { ...m } as Record<string, unknown>;
    delete next[OPEN_QUESTION_KEY];
    return next;
  });
  return taken;
}

/** The person answered with the card. Returns the message to send (and
 *  the first choice for the event), or null when no such question is
 *  open or the answer is empty. The question stays open on an empty
 *  answer. */
export async function answerWithoutWaiting(
  agent: string,
  session: string,
  questionId: string,
  answer: AsyncAnswer,
): Promise<{ text: string; choice: string | null } | { error: 'not_found' | 'empty' }> {
  const q = await openAsyncQuestion(agent, session);
  if (!q || q.id !== questionId) return { error: 'not_found' };
  const text = composeAnswerMessage(q, answer);
  if (!text) return { error: 'empty' };
  if (!(await takeQuestion(agent, session, questionId))) return { error: 'not_found' };
  const choice = (answer.parts?.[0]?.answers ?? answer.answers ?? [])[0] ?? null;
  logger.info({ msg: 'question.answered_async', agent, session, questionId, chars: text.length });
  return { text, choice };
}

/** The person wrote something: an open question is answered by that. */
export async function clearAsyncQuestion(agent: string, session: string): Promise<boolean> {
  const q = await takeQuestion(agent, session);
  if (!q) return false;
  logger.info({ msg: 'question.cleared_by_message', agent, session, questionId: q.id });
  await broadcastToSession(agent, session, { event: 'question_answered', data: { questionId: q.id, answered: true, choice: null, by: 'message' } });
  return true;
}

/** Send `text` as the person's message — the same ledger item and turn
 *  a typed message gets (routes/chat.ts POST /chat/send). */
export function sendAsPerson(agent: string, session: string, text: string): string {
  const turnId = randomUUID();
  const origin: TurnOrigin = { kind: 'human', via: 'chat' };
  openWork({ id: turnId, origin, target: { agent, session }, requester: { human: true }, text, wake: 'never' });
  logger.info({ msg: 'chat.send', turnId, agent, session, ref: session, len: text.length, via: 'question_answer' });
  void startTurn({ agent, session, text, turnId, workId: turnId, origin }).catch((err: unknown) => {
    if (err instanceof DequeuedError) return;
    logger.error({ msg: 'chat.send.run_failed', turnId, agent, session, err: (err as Error).message });
    void broadcastToSession(agent, session, { event: 'status', data: { msg: `turn failed: ${(err as Error).message}` } });
  });
  return turnId;
}
