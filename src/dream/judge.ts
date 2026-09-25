// The judge — one model call that answers ONE question with a fixed set
// of options, a confidence and a one-sentence reason. No text is
// generated beyond that; the caller decides what the answer means.
//
// Why (private/dream-judge/2026-09-25_judge-design.md): the dream
// pipeline makes recurring decisions — "is this finding already in the
// wiki?" (REM), "does this note belong in the wiki, and where?" (Deep),
// "do these two passages agree?" (Lucid) — that today are either a
// cosine threshold (REM: found 5 of 100 duplicates) or a side effect of
// the call that also writes the page (Deep). Asked as a plain question
// to an ordinary model, the REM decision hit 93 of 100 at 91 %
// precision (private/rem-dedup-measure/). Only this module knows the
// model; the phases pass a question and read an answer, so a special
// decision model (Von, Laya, …) can sit behind the same call later.
//
// Every prompt here is English, like every model-facing text somora
// produces; the content under judgment stays in the user's language.

import type { Config, ResolvedModel, ThinkingLevel } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { callOneShotLLM } from './deep-llm.ts';
import { firstCompleteJson } from './json-salvage.ts';
import { resolveDreamModel } from './rem-extract.ts';

export interface JudgeQuestion {
  system: string;
  user: string;
  /** The answers the model may give; anything else is `unparsable`. */
  options: readonly string[];
}

export interface JudgeAnswer {
  /** One of the question's options, or null when the model's reply
   *  could not be read as one. */
  answer: string | null;
  /** 0–100 as the model stated it (0 when missing). */
  confidence: number;
  why: string;
  /** Optional 1-based index of the text the model points at (`by`). */
  by?: number;
  raw: string;
}

export interface AskJudgeArgs {
  model: ResolvedModel;
  question: JudgeQuestion;
  timeoutMs: number;
  logCtx: Record<string, unknown>;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
}

/** The function shape the phases call — injectable for tests. */
export type AskJudge = (args: AskJudgeArgs) => Promise<JudgeAnswer>;

/**
 * The judge's model: the phase's own worker unless the config names
 * one. A named ref is resolved the way every dream model is — a typo
 * fails the run at its start, not on the day it matters.
 */
export function resolveJudgeModel(config: Config, ref: string | undefined, phaseModel: ResolvedModel): ResolvedModel {
  if (!ref) return phaseModel;
  return resolveDreamModel(config, ref);
}

/** Parse the model's reply into an answer. Exported for tests. */
export function parseJudgeReply(raw: string, options: readonly string[]): JudgeAnswer {
  const json = firstCompleteJson(raw, '{') ?? raw;
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
  } catch {
    obj = null;
  }
  if (!obj) return { answer: null, confidence: 0, why: 'unparsable reply', raw };
  const answerRaw = typeof obj.answer === 'string' ? obj.answer.trim().toLowerCase() : '';
  const answer = options.find((o) => o.toLowerCase() === answerRaw) ?? null;
  const confNum = typeof obj.confidence === 'number' ? obj.confidence : Number(obj.confidence);
  const confidence = Number.isFinite(confNum) ? Math.max(0, Math.min(100, Math.round(confNum))) : 0;
  const why = typeof obj.why === 'string' ? obj.why.trim() : '';
  const byNum = typeof obj.by === 'number' ? obj.by : typeof obj.by === 'string' ? Number(obj.by.replace(/[^\d]/g, '')) : NaN;
  return {
    answer,
    confidence,
    why: answer ? why : why || 'answer not one of the options',
    ...(Number.isInteger(byNum) && byNum > 0 ? { by: byNum } : {}),
    raw,
  };
}

export const askJudge: AskJudge = async (args) => {
  const t0 = Date.now();
  const raw = await callOneShotLLM({
    workerModel: args.model,
    systemPrompt: args.question.system,
    userMessage: args.question.user,
    timeoutMs: args.timeoutMs,
    logCtx: args.logCtx,
    ...(args.thinking ? { thinking: args.thinking } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const parsed = parseJudgeReply(raw, args.question.options);
  logger.info({
    msg: 'dream.judge_answer',
    ...args.logCtx,
    model: `${args.model.providerName}/${args.model.modelId}`,
    answer: parsed.answer,
    confidence: parsed.confidence,
    ms: Date.now() - t0,
    // The one-shot helper returns text only; chars/4 is the estimate the
    // rest of the dream code uses.
    tokens_in_est: Math.ceil((args.question.system.length + args.question.user.length) / 4),
  });
  return parsed;
};

// ── The REM coverage question ─────────────────────────────────────────

export const COVERAGE_OPTIONS = ['covered', 'adds_new'] as const;

export interface CoverageText {
  /** `memory:<slug>` or `wiki:<slug>` — shown to the model as the id. */
  id: string;
  text: string;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)} …` : s);

/**
 * "Is the substance of this note already stated in one of these
 * texts?" The wording is the one the measurement validated (run 3,
 * private/rem-dedup-measure/: 93 of 100 duplicates, 91 % precision). A
 * stricter draft — "covered only when EVERY element is there" — kept
 * precision (97 %) but found only 45 of 100: the notes the reviewer
 * called duplicates rarely match their page element for element, they
 * match in substance. The reviewer sees the judge's reason next to the
 * mark, so a lenient call on a detail is visible, a missed duplicate
 * is not.
 */
export function buildCoverageQuestion(
  finding: { reason: string; content: string },
  texts: CoverageText[],
  limits: { maxPageChars: number } = { maxPageChars: 6000 },
): JudgeQuestion {
  const system =
    'You judge whether a note that a background process wants to save is ALREADY COVERED by existing texts. ' +
    'Read the note and every existing text in full.\n' +
    'Answer "covered" when the substantive facts and claims of the note are already stated in one of the existing texts ' +
    '(wording may differ; the texts may say more).\n' +
    'Answer "adds_new" when the note adds facts, decisions, numbers or conclusions that none of the existing texts state.\n' +
    'Reply with JSON only: {"answer": "covered" | "adds_new", "confidence": 0-100, "by": <number of the covering text, or null>, "why": "<one sentence naming the decisive fact>"}';
  const user =
    `NOTE TO SAVE\nWhy it was extracted: ${cut(finding.reason, 1500)}\nContent:\n${cut(finding.content || '(no content — only the reason above)', 4000)}\n\n` +
    `EXISTING TEXTS\n` +
    texts.map((t, i) => `[${i + 1}] ${t.id}\n${cut(t.text, limits.maxPageChars)}`).join('\n\n') +
    '\n\nJSON answer:';
  return { system, user, options: COVERAGE_OPTIONS };
}
