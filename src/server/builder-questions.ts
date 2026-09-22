// Questions a builder asks the person (ask_user) while its turn runs.
//
// The tool call blocks until the person answers in the task panel or
// the wait runs out; then the model gets the answer (or "unanswered —
// decide yourself"). One open question per session at a time. In
// memory: a restart ends the wait, and the tool call fails with the
// turn.

import { randomUUID } from 'node:crypto';
import { logger } from './logger.ts';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  id: string;
  agent: string;
  session: string;
  question: string;
  header?: string;
  options: QuestionOption[];
  multiple: boolean;
  askedAt: number;
  expiresAt: number;
}

export interface QuestionAnswer {
  answered: boolean;
  /** Labels chosen (or the free text as the only entry). */
  answers: string[];
  /** Free text typed instead of / in addition to the options. */
  text?: string;
}

interface Slot {
  q: PendingQuestion;
  resolve: (a: QuestionAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Slot>();
const key = (agent: string, session: string): string => `${agent}/${session}`;

export const DEFAULT_QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_QUESTION_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export function pendingQuestion(agent: string, session: string): PendingQuestion | null {
  return pending.get(key(agent, session))?.q ?? null;
}

/**
 * Register a question and wait for its answer. A second question on a
 * session while one is open answers the first as unanswered (the model
 * moved on) and replaces it.
 */
export function askQuestion(
  args: Omit<PendingQuestion, 'id' | 'askedAt' | 'expiresAt'> & { timeoutMs?: number },
  onAsked?: (q: PendingQuestion) => void,
): Promise<QuestionAnswer> {
  const k = key(args.agent, args.session);
  const prior = pending.get(k);
  if (prior) {
    clearTimeout(prior.timer);
    pending.delete(k);
    prior.resolve({ answered: false, answers: [], text: 'superseded by a newer question' });
  }
  const timeoutMs = Math.min(MAX_QUESTION_TIMEOUT_MS, Math.max(10_000, args.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS));
  const q: PendingQuestion = {
    id: randomUUID(),
    agent: args.agent,
    session: args.session,
    question: args.question,
    ...(args.header ? { header: args.header } : {}),
    options: args.options,
    multiple: args.multiple,
    askedAt: Date.now(),
    expiresAt: Date.now() + timeoutMs,
  };
  return new Promise<QuestionAnswer>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.get(k)?.q.id !== q.id) return;
      pending.delete(k);
      logger.info({ msg: 'builder.question_timeout', agent: q.agent, session: q.session, questionId: q.id });
      resolve({ answered: false, answers: [] });
    }, timeoutMs);
    timer.unref?.();
    pending.set(k, { q, resolve, timer });
    logger.info({ msg: 'builder.question_asked', agent: q.agent, session: q.session, questionId: q.id, options: q.options.length });
    onAsked?.(q);
  });
}

/** The person answered. Returns false when no such question is open. */
export function answerQuestion(agent: string, session: string, questionId: string, answer: { answers?: string[]; text?: string }): boolean {
  const k = key(agent, session);
  const slot = pending.get(k);
  if (!slot || slot.q.id !== questionId) return false;
  clearTimeout(slot.timer);
  pending.delete(k);
  const answers = (answer.answers ?? []).filter((a) => typeof a === 'string' && a.trim().length > 0);
  const text = typeof answer.text === 'string' && answer.text.trim().length > 0 ? answer.text.trim() : undefined;
  logger.info({ msg: 'builder.question_answered', agent, session, questionId, answers: answers.length, text: Boolean(text) });
  slot.resolve({ answered: true, answers: answers.length > 0 ? answers : text ? [text] : [], ...(text ? { text } : {}) });
  return true;
}

/** The turn ended (or was stopped): nobody is waiting any more. */
export function dropQuestions(agent: string, session: string): void {
  const k = key(agent, session);
  const slot = pending.get(k);
  if (!slot) return;
  clearTimeout(slot.timer);
  pending.delete(k);
  slot.resolve({ answered: false, answers: [], text: 'the turn ended before an answer arrived' });
}
