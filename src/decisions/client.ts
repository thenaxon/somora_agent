// Talking to a decision model over the System One API (docs/decisions.md).
//
// `POST <baseUrl>/v1/systemone` with {model, state, questions, images?}
// returns typed answers with probabilities. The wire calls a yes/no
// question `noul`; agents see `boolean` (a word every model knows), and
// this module translates both ways. Checked against Clef (Cloudflare's
// open decision model, self-hosted); Jev (TypeSafe, hosted) speaks the
// same API by its public description but was not tested live.
//
// Kept free of tool concerns (paths, agents) so other callers — Sentinel
// phase 2 — can use it as is.

import { Agent, fetch as undiciFetch } from 'undici';
import type { DecisionModel } from '../config/types.ts';
import { logger } from '../server/logger.ts';

export type QuestionType = 'boolean' | 'choice' | 'score';

export interface DecisionQuestion {
  type: QuestionType;
  instructions?: unknown;
  criteria?: unknown;
}

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  /** Base64 (no data: prefix), already scaled; PNG, JPEG or WebP. */
  images?: { base64: string; width: number; height: number }[];
}

export type DecisionAnswer =
  | { type: 'boolean'; probabilityTrue: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; max: number; confidence: number; probabilities: number[]; legend: unknown[] };

export type UnavailableReason =
  | 'not-configured'
  | 'images-unsupported'
  | 'authentication'
  | 'rate-limited'
  | 'not-ready'
  | 'transport'
  | 'too-long'
  | 'truncated'
  | 'unsupported-input'
  | 'invalid-response'
  | 'deadline';

export type DecisionOutcome =
  | {
      status: 'ok';
      model: string;
      answers: Record<string, DecisionAnswer>;
      usage: { inputTokens: number; outputTokens: number };
      inputLimit: number | null;
      ms: number;
    }
  | { status: 'unavailable'; reason: UnavailableReason; guidance: string; detail?: string };

/** What the agent should do next, per reason — after OpenClaw's table
 *  (src/agents/tools/decision-tool-contract.ts), adapted. */
export const GUIDANCE: Record<UnavailableReason, string> = {
  'not-configured': 'No decision model is configured. Ask the operator to set decisions.model in config.yaml.',
  'images-unsupported': 'The decision model in use reads text only. Describe the image in the state instead, or ask the operator for a model with the image capability.',
  authentication: 'The decision model rejected the credentials. Ask the operator to check decisions.models[].apiKey.',
  'rate-limited': 'The decision model is rate limited. Try again later, only if the decision is still needed.',
  'not-ready': 'The decision model is not ready on its server (for example not loaded right now). Try again later or carry on without it; do not treat this as a "no".',
  transport: 'The decision model could not be reached. Carry on without it or try again later; do not work around it with shell or HTTP calls, and do not treat this as a "no".',
  'too-long': 'The input exceeds the decision model\'s limit; nothing was evaluated. Shorten the state to what the questions need, send fewer or smaller images, or split it into several calls — do not resend it unchanged.',
  truncated: 'The server cut the input off at its limit, so the answers would not cover all of it; they were discarded. Shorten the state or split it.',
  'unsupported-input': 'The decision model rejected the request. Check the question types, criteria counts (choice 2–255, score 2–10) and the state, then try again.',
  'invalid-response': 'The decision model returned an answer that does not match the questions. No answers were accepted; ask the operator to check the server.',
  deadline: 'The evaluation took longer than the configured time limit. Shorten the input, or ask the operator to raise decisions.models[].timeoutMs.',
};

const dispatcher = new Agent({ keepAliveTimeout: 30_000, allowH2: false });

function root(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function headers(entry: DecisionModel): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {}),
  };
}

// ─── input limit ────────────────────────────────────────────────────

const LIMIT_TTL_MS = 10 * 60_000;
const limitCache = new Map<string, { value: number | null; at: number }>();

/** `max_input_tokens` the server reports for the model, or null. Read at
 *  most every ten minutes: the operator of the server may change it. */
export async function serverInputLimit(entry: DecisionModel, now = Date.now()): Promise<number | null> {
  const key = `${root(entry.baseUrl)}|${entry.model}`;
  const hit = limitCache.get(key);
  if (hit && now - hit.at < LIMIT_TTL_MS) return hit.value;
  let value: number | null = null;
  try {
    const r = await undiciFetch(`${root(entry.baseUrl)}/v1/models`, {
      headers: headers(entry),
      dispatcher,
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      const j = (await r.json()) as { data?: { id?: string; max_input_tokens?: unknown }[] };
      const models = j.data ?? [];
      const m = models.find((x) => x.id === entry.model) ?? (models.length === 1 ? models[0] : undefined);
      if (typeof m?.max_input_tokens === 'number' && m.max_input_tokens > 0) value = m.max_input_tokens;
    }
  } catch {
    /* no limit from the server: the server's own 413 still guards */
  }
  limitCache.set(key, { value, at: now });
  return value;
}

/** The server limit last read, without asking (for tool descriptions). */
export function cachedServerInputLimit(entry: DecisionModel): number | null {
  return limitCache.get(`${root(entry.baseUrl)}|${entry.model}`)?.value ?? null;
}

/** Ours when configured, the server's when not; the lower when both. */
export function effectiveInputLimit(configured: number | undefined, server: number | null): number | null {
  if (configured && server) return Math.min(configured, server);
  return configured ?? server ?? null;
}

/** Rough token count for the pre-check: ~4 characters per token for the
 *  text (Clef counted German prose at 4–5), ~1 token per 1 024 pixels per
 *  image (measured on Clef: 2048×1536 ≈ 3 070). Errs low on purpose —
 *  only a clearly too long input is refused here; the server's 413 and
 *  the truncation check after the call catch the rest. */
export function estimateInputTokens(req: DecisionRequest): number {
  const text = JSON.stringify({ state: req.state, questions: req.questions }).length;
  const images = (req.images ?? []).reduce((sum, i) => sum + Math.ceil((i.width * i.height) / 1024) + 64, 0);
  return Math.ceil(text / 4) + images;
}

// ─── translation ────────────────────────────────────────────────────

function toWireQuestions(questions: Record<string, DecisionQuestion>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [
      id,
      {
        type: q.type === 'boolean' ? 'noul' : q.type,
        ...(q.instructions !== undefined ? { instructions: q.instructions } : {}),
        ...(q.criteria !== undefined ? { criteria: q.criteria } : {}),
      },
    ]),
  );
}

const isProb = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** Server answers → agent answers; null when they do not match the questions. */
export function fromWireAnswers(
  wire: unknown,
  questions: Record<string, DecisionQuestion>,
): Record<string, DecisionAnswer> | null {
  if (!wire || typeof wire !== 'object') return null;
  const answers = wire as Record<string, Record<string, unknown>>;
  const out: Record<string, DecisionAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a || typeof a !== 'object') return null;
    if (q.type === 'boolean') {
      if (a.type !== 'noul' || !isProb(a.noul)) return null;
      out[id] = { type: 'boolean', probabilityTrue: a.noul };
    } else if (q.type === 'choice') {
      const labels = Object.keys((q.criteria ?? {}) as Record<string, unknown>);
      const probs = a.probabilities as Record<string, unknown> | undefined;
      if (a.type !== 'choice' || typeof a.choice !== 'string' || !labels.includes(a.choice) || !isProb(a.confidence)) return null;
      if (!probs || labels.some((l) => !isProb(probs[l]))) return null;
      out[id] = { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries(labels.map((l) => [l, probs[l] as number])) };
    } else {
      const levels = Array.isArray(q.criteria) ? q.criteria : [];
      const probs = a.probabilities as Record<string, unknown> | undefined;
      const max = levels.length - 1;
      if (a.type !== 'score' || typeof a.score !== 'number' || a.score < 0 || a.score > max || !isProb(a.confidence)) return null;
      if (!probs || levels.some((_, i) => !isProb(probs[String(i)]))) return null;
      out[id] = {
        type: 'score',
        score: a.score,
        max,
        confidence: a.confidence,
        probabilities: levels.map((_, i) => probs[String(i)] as number),
        legend: levels,
      };
    }
  }
  return out;
}

// ─── the call ───────────────────────────────────────────────────────

function unavailable(reason: UnavailableReason, detail?: string): DecisionOutcome {
  return { status: 'unavailable', reason, guidance: GUIDANCE[reason], ...(detail ? { detail: detail.slice(0, 400) } : {}) };
}

/** The server's own error message, when it sends one as JSON
 *  (`{"error":{"message"}}`); never the raw body, which may echo input. */
function serverMessage(body: string): string | undefined {
  try {
    const m = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof m === 'string' ? m : undefined;
  } catch {
    return undefined;
  }
}

export async function evaluateDecision(
  entry: DecisionModel,
  req: DecisionRequest,
  opts: { signal?: AbortSignal; logCtx?: Record<string, unknown> } = {},
): Promise<DecisionOutcome> {
  const t0 = Date.now();
  const logCtx = { model: entry.name, questions: Object.keys(req.questions).length, images: req.images?.length ?? 0, ...opts.logCtx };
  const done = (outcome: DecisionOutcome, extra: Record<string, unknown> = {}): DecisionOutcome => {
    logger.info({
      msg: 'decision.evaluate',
      ...logCtx,
      ms: Date.now() - t0,
      status: outcome.status,
      ...(outcome.status === 'unavailable' ? { reason: outcome.reason } : { inputTokens: outcome.usage.inputTokens }),
      ...extra,
    });
    return outcome;
  };

  if ((req.images?.length ?? 0) > 0 && !entry.capabilities.includes('image')) return done(unavailable('images-unsupported'));

  const serverLimit = await serverInputLimit(entry);
  const limit = effectiveInputLimit(entry.maxInputTokens, serverLimit);
  const estimate = estimateInputTokens(req);
  if (limit && estimate > limit) {
    return done(unavailable('too-long', `estimated ${estimate} tokens, limit is ${limit}; nothing was sent`), { estimate, limit });
  }

  const body = JSON.stringify({
    model: entry.model,
    state: req.state,
    questions: toWireQuestions(req.questions),
    ...(req.images && req.images.length > 0 ? { images: req.images.map((i) => i.base64) } : {}),
  });
  const timeout = AbortSignal.timeout(entry.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let status: number;
  let text: string;
  try {
    const r = await undiciFetch(`${root(entry.baseUrl)}/v1/systemone`, { method: 'POST', headers: headers(entry), body, dispatcher, signal });
    status = r.status;
    text = await r.text();
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (timeout.aborted) return done(unavailable('deadline', `no answer within ${entry.timeoutMs} ms`));
    return done(unavailable('transport', String((err as Error)?.message ?? err)));
  }

  if (status !== 200) {
    const msg = serverMessage(text);
    if (status === 401 || status === 403) return done(unavailable('authentication'), { http: status });
    if (status === 429) return done(unavailable('rate-limited'), { http: status });
    if (status === 413) return done(unavailable('too-long', msg ?? `the server reported HTTP 413 (limit ${limit ?? 'unknown'})`), { http: status });
    if (status === 400 || status === 422) return done(unavailable('unsupported-input', msg), { http: status });
    if (status === 502 || status === 503 || status === 504 || status === 529) return done(unavailable('not-ready', msg ?? `HTTP ${status}`), { http: status });
    return done(unavailable('transport', msg ?? `HTTP ${status}`), { http: status });
  }

  let parsed: { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return done(unavailable('invalid-response', 'not JSON'));
  }
  const inputTokens = typeof parsed.usage?.input_tokens === 'number' ? parsed.usage.input_tokens : 0;
  // A server that cuts the input off silently reports exactly ITS limit
  // (Clef before 2610.5): answers about a text it did not fully read.
  if (serverLimit && inputTokens >= serverLimit) return done(unavailable('truncated', `the server read ${inputTokens} tokens, its limit`), { inputTokens });
  // Over OUR limit (decisions.models[].maxInputTokens) yet accepted by a
  // server that allows more: the operator's limit still applies, now with
  // the server's exact count.
  if (entry.maxInputTokens && inputTokens > entry.maxInputTokens) {
    return done(unavailable('too-long', `input was ${inputTokens} tokens, the configured limit is ${entry.maxInputTokens}`), { inputTokens });
  }
  const answers = fromWireAnswers(parsed.answers, req.questions);
  if (!answers) return done(unavailable('invalid-response', 'the answers do not match the questions'));
  return done({
    status: 'ok',
    model: typeof parsed.model === 'string' ? parsed.model : entry.model,
    answers,
    usage: { inputTokens, outputTokens: typeof parsed.usage?.output_tokens === 'number' ? parsed.usage.output_tokens : 0 },
    inputLimit: limit,
    ms: Date.now() - t0,
  });
}
