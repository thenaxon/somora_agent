// Default LLM dispatcher for Dream-B. Multi-engine since Stufe 4.5 —
// supports openai-compatible, claude-cli (subscription via SDK), and
// codex-cli (subprocess) as worker. The actual LLM call lives in
// `dream-b-llm.ts`; this module owns prompt-shaping and response-parsing.
//
// Robust JSON parsing: strips markdown fences if the model emits them
// despite the prompt, and validates required fields. On parse failure
// or invalid shape, returns a `skip`/`no_change` outcome with the
// failure reason — never throws on a single bad LLM response.

import { logger } from '../server/logger.ts';
import type {
  MergeDecision,
  PromotionCandidate,
  PromotionDecision,
  PromotionDispatcher,
} from './types.ts';
import { MERGE_SYSTEM_PROMPT, PROMOTE_SYSTEM_PROMPT } from './dream-b-prompts.ts';
import { callOneShotLLM } from './dream-b-llm.ts';

export class DefaultPromotionDispatcher implements PromotionDispatcher {
  async decidePromotion(args: {
    candidate: PromotionCandidate;
    existingWikiSummary: string;
    workerModel: import('../config/types.ts').ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<PromotionDecision> {
    const userMsg = buildPromoteUserMessage(args.candidate, args.existingWikiSummary);
    let text: string;
    try {
      text = await callOneShotLLM({
        workerModel: args.workerModel,
        systemPrompt: PROMOTE_SYSTEM_PROMPT,
        userMessage: userMsg,
        timeoutMs: args.timeoutMs,
        ...(args.signal ? { signal: args.signal } : {}),
        logCtx: { agent: args.candidate.agent, op: 'promote', slug: args.candidate.slug },
      });
    } catch (err) {
      logger.warn({
        msg: 'wiki.dream_b.llm_call_failed',
        op: 'promote',
        agent: args.candidate.agent,
        slug: args.candidate.slug,
        err: (err as Error).message,
      });
      return { kind: 'skip', reason: `LLM call failed: ${(err as Error).message}` };
    }
    return parsePromotionDecision(text, args.candidate.slug);
  }

  async decideMerge(args: {
    candidate: PromotionCandidate;
    existingWikiPage: string;
    workerModel: import('../config/types.ts').ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<MergeDecision> {
    const userMsg = buildMergeUserMessage(args.candidate, args.existingWikiPage);
    let text: string;
    try {
      text = await callOneShotLLM({
        workerModel: args.workerModel,
        systemPrompt: MERGE_SYSTEM_PROMPT,
        userMessage: userMsg,
        timeoutMs: args.timeoutMs,
        ...(args.signal ? { signal: args.signal } : {}),
        logCtx: { agent: args.candidate.agent, op: 'merge', slug: args.candidate.slug },
      });
    } catch (err) {
      logger.warn({
        msg: 'wiki.dream_b.llm_call_failed',
        op: 'merge',
        agent: args.candidate.agent,
        slug: args.candidate.slug,
        err: (err as Error).message,
      });
      return { kind: 'no_change', reason: `LLM call failed: ${(err as Error).message}` };
    }
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

// ─── (LLM dispatch moved to src/wiki/dream-b-llm.ts in Stufe 4.5) ────

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
