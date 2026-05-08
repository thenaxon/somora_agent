// Default LLM dispatcher for Dream-B. Calls the configured worker model
// via the openai-compatible SDK (same v1 constraint as Dream-A).
//
// Robust JSON parsing: strips markdown fences if the model emits them
// despite the prompt, and validates required fields. On parse failure
// or invalid shape, returns a `skip`/`no_change` outcome with the
// failure reason — never throws on a single bad LLM response.

import OpenAI from 'openai';

import { logger } from '../server/logger.ts';
import type {
  MergeDecision,
  PromotionCandidate,
  PromotionDecision,
  PromotionDispatcher,
} from './types.ts';
import { MERGE_SYSTEM_PROMPT, PROMOTE_SYSTEM_PROMPT } from './dream-b-prompts.ts';

export class DefaultPromotionDispatcher implements PromotionDispatcher {
  async decidePromotion(args: {
    candidate: PromotionCandidate;
    existingWikiSummary: string;
    workerModel: import('../config/types.ts').ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<PromotionDecision> {
    const provider = args.workerModel.provider;
    if (provider.engine !== 'openai-compatible') {
      return {
        kind: 'skip',
        reason: `worker model engine ${provider.engine} not supported by Dream-B in v1`,
      };
    }
    const userMsg = buildPromoteUserMessage(args.candidate, args.existingWikiSummary);
    const text = await callWorker({
      provider,
      modelId: args.workerModel.modelId,
      systemPrompt: PROMOTE_SYSTEM_PROMPT,
      userMessage: userMsg,
      timeoutMs: args.timeoutMs,
      signal: args.signal,
      logCtx: { agent: args.candidate.agent, op: 'promote', slug: args.candidate.slug },
    });
    return parsePromotionDecision(text, args.candidate.slug);
  }

  async decideMerge(args: {
    candidate: PromotionCandidate;
    existingWikiPage: string;
    workerModel: import('../config/types.ts').ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<MergeDecision> {
    const provider = args.workerModel.provider;
    if (provider.engine !== 'openai-compatible') {
      return {
        kind: 'no_change',
        reason: `worker model engine ${provider.engine} not supported by Dream-B in v1`,
      };
    }
    const userMsg = buildMergeUserMessage(args.candidate, args.existingWikiPage);
    const text = await callWorker({
      provider,
      modelId: args.workerModel.modelId,
      systemPrompt: MERGE_SYSTEM_PROMPT,
      userMessage: userMsg,
      timeoutMs: args.timeoutMs,
      signal: args.signal,
      logCtx: { agent: args.candidate.agent, op: 'merge', slug: args.candidate.slug },
    });
    return parseMergeDecision(text, args.candidate.slug);
  }
}

// ─── User-message builders ──────────────────────────────────────────

function buildPromoteUserMessage(
  c: PromotionCandidate,
  wikiSummary: string,
): string {
  return [
    `Agent: ${c.agent}`,
    `Memory slug: ${c.slug}`,
    '',
    '<existing_wiki_summary>',
    wikiSummary || '(empty wiki — no pages yet)',
    '</existing_wiki_summary>',
    '',
    '<memory_file>',
    c.body.trim(),
    '</memory_file>',
  ].join('\n');
}

function buildMergeUserMessage(
  c: PromotionCandidate,
  existingWikiPage: string,
): string {
  const observations = c.stub?.observations ?? [];
  return [
    `Agent: ${c.agent}`,
    `Memory stub slug: ${c.slug}`,
    `Wiki page being merged into: ${c.stub?.promotedTo ?? '(unknown)'}`,
    '',
    '<existing_wiki_page>',
    existingWikiPage,
    '</existing_wiki_page>',
    '',
    '<new_observations>',
    observations.length === 0
      ? '(none — caller should have skipped this candidate)'
      : observations.join('\n'),
    '</new_observations>',
  ].join('\n');
}

// ─── LLM call + timeout race ────────────────────────────────────────

async function callWorker(args: {
  provider: { baseUrl?: string; apiKey?: string };
  modelId: string;
  systemPrompt: string;
  userMessage: string;
  timeoutMs: number;
  signal?: AbortSignal;
  logCtx: Record<string, unknown>;
}): Promise<string> {
  const client = new OpenAI({
    baseURL: args.provider.baseUrl,
    apiKey: args.provider.apiKey ?? 'dummy',
  });
  const reqStart = Date.now();
  logger.info({ msg: 'wiki.dream_b.llm_request', ...args.logCtx, model: args.modelId });
  const completion = await Promise.race([
    client.chat.completions.create(
      {
        model: args.modelId,
        messages: [
          { role: 'system', content: args.systemPrompt },
          { role: 'user', content: args.userMessage },
        ],
        stream: false,
      },
      args.signal ? { signal: args.signal } : undefined,
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Dream-B ${args.logCtx.op} timed out after ${args.timeoutMs}ms`)),
        args.timeoutMs,
      ),
    ),
  ]);
  const text = completion.choices[0]?.message?.content ?? '';
  logger.info({
    msg: 'wiki.dream_b.llm_response',
    ...args.logCtx,
    durationMs: Date.now() - reqStart,
    chars: text.length,
    preview: text.slice(0, 200).replace(/\s+/g, ' ').trim(),
    usage: completion.usage,
  });
  return text;
}

// ─── Parsers ────────────────────────────────────────────────────────

function stripFences(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const fenceEnd = text.lastIndexOf('```');
    if (fenceEnd > 0) {
      text = text.slice(text.indexOf('\n') + 1, fenceEnd).trim();
    }
  }
  return text;
}

function parsePromotionDecision(raw: string, slug: string): PromotionDecision {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({
      msg: 'wiki.dream_b.parse_failed',
      op: 'promote',
      slug,
      err: (err as Error).message,
      sample: text.slice(0, 200),
    });
    return { kind: 'skip', reason: `LLM output unparseable as JSON` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'skip', reason: 'LLM output not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'skip') {
    return {
      kind: 'skip',
      reason: typeof obj.reason === 'string' ? obj.reason : 'LLM declined without reason',
    };
  }
  if (obj.kind !== 'promote') {
    return { kind: 'skip', reason: `unknown decision kind: ${String(obj.kind)}` };
  }
  // Validate required fields for promote.
  const subfolder = typeof obj.subfolder === 'string' ? obj.subfolder.trim() : '';
  const slugOut = typeof obj.slug === 'string' ? obj.slug.trim() : '';
  const type = typeof obj.type === 'string' ? obj.type.trim() : '';
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body : '';
  if (!subfolder || !slugOut || !type || !title || !body) {
    logger.warn({
      msg: 'wiki.dream_b.promote_missing_fields',
      slug,
      have: { subfolder, slugOut, type, title, body: body.length },
    });
    return { kind: 'skip', reason: 'LLM promote response missing required fields' };
  }
  // Sanity: slug should start with subfolder/.
  const finalSlug = slugOut.startsWith(subfolder + '/') ? slugOut : `${subfolder}/${slugOut}`;
  const related = Array.isArray(obj.related)
    ? (obj.related.filter((r): r is string => typeof r === 'string'))
    : undefined;
  return {
    kind: 'promote',
    subfolder,
    slug: finalSlug,
    type,
    title,
    body,
    ...(related && related.length > 0 ? { related } : {}),
  };
}

function parseMergeDecision(raw: string, slug: string): MergeDecision {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({
      msg: 'wiki.dream_b.parse_failed',
      op: 'merge',
      slug,
      err: (err as Error).message,
      sample: text.slice(0, 200),
    });
    return { kind: 'no_change', reason: 'LLM output unparseable as JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'no_change', reason: 'LLM output not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'no_change') {
    return {
      kind: 'no_change',
      reason: typeof obj.reason === 'string' ? obj.reason : 'LLM declined to update without reason',
    };
  }
  if (obj.kind !== 'update') {
    return { kind: 'no_change', reason: `unknown decision kind: ${String(obj.kind)}` };
  }
  const body = typeof obj.body === 'string' ? obj.body : '';
  const logSummary = typeof obj.logSummary === 'string' ? obj.logSummary : '';
  if (!body || !logSummary) {
    logger.warn({
      msg: 'wiki.dream_b.merge_missing_fields',
      slug,
      have: { body: body.length, logSummary },
    });
    return { kind: 'no_change', reason: 'LLM update response missing required fields' };
  }
  const related = Array.isArray(obj.related)
    ? (obj.related.filter((r): r is string => typeof r === 'string'))
    : undefined;
  return {
    kind: 'update',
    body,
    logSummary,
    ...(related && related.length > 0 ? { related } : {}),
  };
}
