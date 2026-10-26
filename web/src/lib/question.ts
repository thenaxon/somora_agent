// A question that does not wait (docs/agents.md "Asking the person"),
// kept free of React so the web and the phone card share it and it can
// be tested: its parts, whether one click answers it, and the answer
// body the server turns into the person's next message.

import type { SessionQuestion, SessionQuestionAnswer, SessionQuestionPart } from './api';

/** The questions of a card: the parts, or the question itself. */
export function questionParts(q: SessionQuestion): SessionQuestionPart[] {
  if (q.parts && q.parts.length > 0) return q.parts;
  return [{ question: q.question, ...(q.header ? { header: q.header } : {}), options: q.options, multiple: q.multiple }];
}

/** One question with options, one answer each: a click sends it. */
export function answersOnClick(q: SessionQuestion): boolean {
  const parts = questionParts(q);
  return parts.length === 1 && parts[0]!.options.length > 0 && !parts[0]!.multiple;
}

/** The answer body from the options picked and the words typed per
 *  part; null while nothing is chosen or typed. */
export function buildAnswer(q: SessionQuestion, picks: string[][], texts: string[]): SessionQuestionAnswer | null {
  const parts = questionParts(q);
  const one = (i: number): { answers?: string[]; text?: string } => {
    const answers = (picks[i] ?? []).filter((x) => x.trim());
    const text = (texts[i] ?? '').trim();
    return { ...(answers.length > 0 ? { answers } : {}), ...(text ? { text } : {}) };
  };
  const all = parts.map((_, i) => one(i));
  if (all.every((a) => !a.answers && !a.text)) return null;
  return parts.length === 1 ? all[0]! : { parts: all };
}
