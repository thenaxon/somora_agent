// Art 2 of check triggers: the decision model reads what the script
// fetched and a wake rule turns its answer into wake / no wake
// (private/sentinel-phase2/KONZEPT.md §4). The script's `data` is the
// state, the trigger's questions are the questions — the same core as
// the decision_evaluate tool and POST /decisions/evaluate.
//
// A decision model that cannot answer never wakes anyone: an outage
// must not turn into a flood of wake-ups. It is a check error instead.

import { activeDecisionModel, type Config } from '../config/types.ts';
import { evaluateDecision, type DecisionAnswer, type DecisionQuestion } from '../decisions/client.ts';
import { DecisionQuestionsSchema } from '../decisions/input.ts';
import type { DecisionWakeRule, Trigger } from './types.ts';

export type JudgeOutcome =
  | { ok: true; wake: boolean; question: string; value: number | string; detail?: string }
  | { ok: false; error: string; permanent?: boolean };

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The answer to the rule's question → wake or not, and what to show. */
export function applyWakeRule(rule: DecisionWakeRule, answers: Record<string, DecisionAnswer>): JudgeOutcome {
  const a = answers[rule.question];
  if (!a) return { ok: false, error: `the decision model gave no answer to "${rule.question}"` };
  if ('minProbability' in rule) {
    if (a.type !== 'boolean') return { ok: false, error: `"${rule.question}" is not a yes/no question` };
    return { ok: true, wake: a.probabilityTrue >= rule.minProbability, question: rule.question, value: round(a.probabilityTrue), detail: `probability of yes, wakes from ${rule.minProbability}` };
  }
  if ('choice' in rule) {
    if (a.type !== 'choice') return { ok: false, error: `"${rule.question}" is not a choice question` };
    const p = a.probabilities[rule.choice] ?? 0;
    const wake = rule.minConfidence !== undefined ? p >= rule.minConfidence : a.choice === rule.choice;
    return { ok: true, wake, question: rule.question, value: a.choice, detail: `${rule.choice}: ${round(p)}${rule.minConfidence !== undefined ? `, wakes from ${rule.minConfidence}` : ', wakes when chosen'}` };
  }
  if (a.type !== 'score') return { ok: false, error: `"${rule.question}" is not a score question` };
  return { ok: true, wake: a.score >= rule.minScore, question: rule.question, value: a.score, detail: `score ${a.score} of ${a.max}, wakes from ${rule.minScore}` };
}

/** At creation: questions valid, the rule points at a question of the
 *  right kind with a threshold that can be reached. Null when fine. */
export function validateDecisionEvaluator(questions: unknown, wake: unknown, config: Config): string | null {
  if (!activeDecisionModel(config)) {
    return 'judging data needs a decision model, and none is configured (decisions.model in config.yaml) — use a check whose script decides itself (ready: true/false)';
  }
  const q = DecisionQuestionsSchema.safeParse(questions);
  if (!q.success) {
    const issue = q.error.issues[0];
    return `questions: ${issue?.path.join('.') ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'invalid'}`;
  }
  if (!wake || typeof wake !== 'object') return 'wake rule missing: {question, minProbability} or {question, choice, minConfidence?} or {question, minScore}';
  const r = wake as Record<string, unknown>;
  if (typeof r.question !== 'string' || !q.data[r.question]) {
    return `wake.question must name one of the questions (${Object.keys(q.data).join(', ')})`;
  }
  const question = q.data[r.question]!;
  const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
  if ('minProbability' in r) {
    if (question.type !== 'boolean') return `wake.minProbability needs a boolean question; "${r.question}" is ${question.type}`;
    if (!unit(r.minProbability)) return 'wake.minProbability must be between 0 and 1';
    return null;
  }
  if ('choice' in r) {
    if (question.type !== 'choice') return `wake.choice needs a choice question; "${r.question}" is ${question.type}`;
    const labels = Object.keys(question.criteria);
    if (typeof r.choice !== 'string' || !labels.includes(r.choice)) return `wake.choice must be one of ${labels.join(', ')}`;
    if (r.minConfidence !== undefined && !unit(r.minConfidence)) return 'wake.minConfidence must be between 0 and 1';
    return null;
  }
  if ('minScore' in r) {
    if (question.type !== 'score') return `wake.minScore needs a score question; "${r.question}" is ${question.type}`;
    const max = question.criteria.length - 1;
    if (typeof r.minScore !== 'number' || !Number.isInteger(r.minScore) || r.minScore < 1 || r.minScore > max) return `wake.minScore must be a whole number from 1 to ${max} (the levels are 0–${max})`;
    return null;
  }
  return 'wake rule needs minProbability (yes/no question), choice (choice question) or minScore (score question)';
}

/** Ask the decision model about one check's data. */
export async function judgeCheckData(trigger: Trigger, data: unknown, config: Config): Promise<JudgeOutcome> {
  const ev = trigger.evaluator;
  if (ev?.type !== 'decision') return { ok: false, error: 'not an Art 2 trigger', permanent: true };
  const model = activeDecisionModel(config);
  if (!model) return { ok: false, error: 'no decision model is configured any more (decisions.model) — this check cannot judge its data', permanent: true };
  const outcome = await evaluateDecision(model, { state: data ?? null, questions: ev.questions as Record<string, DecisionQuestion> }, { logCtx: { via: 'sentinel', triggerId: trigger.id } });
  if (outcome.status === 'unavailable') {
    const hint = outcome.reason === 'too-long' || outcome.reason === 'truncated'
      ? ' — the script should print less: only new items, shorter fields'
      : '';
    return { ok: false, error: `${outcome.reason}${outcome.detail ? ` (${outcome.detail.slice(0, 200)})` : ''}${hint}` };
  }
  return applyWakeRule(ev.wake, outcome.answers);
}

/** perItem: ask about each item on its own, `parallel` at a time. The
 *  answers come back in the items' order. */
export async function judgeItems(
  trigger: Trigger,
  items: ReadonlyArray<{ key: string; item: unknown }>,
  config: Config,
  parallel: number,
): Promise<Array<{ key: string; item: unknown; outcome: JudgeOutcome }>> {
  const out: Array<{ key: string; item: unknown; outcome: JudgeOutcome }> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const { key, item } = items[i]!;
      let outcome: JudgeOutcome;
      try {
        outcome = await judgeCheckData(trigger, item, config);
      } catch (err) {
        outcome = { ok: false, error: (err as Error).message };
      }
      out[i] = { key, item, outcome };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, worker));
  return out;
}
