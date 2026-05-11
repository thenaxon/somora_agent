// Default LLM dispatcher for Deep. Multi-engine since Stufe 4.5 —
// supports openai-compatible, claude-cli (subscription via SDK), and
// codex-cli (subprocess) as worker. The actual LLM call lives in
// `deep-llm.ts`; this module owns prompt-shaping and response-parsing.
//
// As of v2.3 there's a single `decideMemoryFate` per candidate — one
// LLM call returns Skip/Promote/Merge in one shot.
//
// Robust JSON parsing: strips markdown fences if the model emits them
// despite the prompt, and validates required fields per kind. On
// parse failure or invalid shape, returns a `skip` outcome with the
// failure reason — never throws on a single bad LLM response.

import { logger } from '../server/logger.ts';
import type {
  MemoryFateDecision,
  PromotionCandidate,
  PromotionDispatcher,
} from '../wiki/types.ts';
import type { ThinkingLevel } from '../config/types.ts';
import { DEEP_SYSTEM_PROMPT } from './deep-prompts.ts';
import { callOneShotLLM } from './deep-llm.ts';

export class DefaultPromotionDispatcher implements PromotionDispatcher {
  async decideMemoryFate(args: {
    candidate: PromotionCandidate;
    wikiIndex: string;
    relevantPages: Array<{ slug: string; markdown: string }>;
    workerModel: import('../config/types.ts').ResolvedModel;
    timeoutMs: number;
    signal?: AbortSignal;
    thinking?: ThinkingLevel;
  }): Promise<MemoryFateDecision> {
    const userMsg = buildDeepUserMessage(
      args.candidate,
      args.wikiIndex,
      args.relevantPages,
    );
    let text: string;
    try {
      text = await callOneShotLLM({
        workerModel: args.workerModel,
        systemPrompt: DEEP_SYSTEM_PROMPT,
        userMessage: userMsg,
        timeoutMs: args.timeoutMs,
        ...(args.signal ? { signal: args.signal } : {}),
        ...(args.thinking ? { thinking: args.thinking } : {}),
        logCtx: { agent: args.candidate.agent, op: 'deep', slug: args.candidate.slug },
      });
    } catch (err) {
      logger.warn({
        msg: 'dream.deep.llm_call_failed',
        agent: args.candidate.agent,
        slug: args.candidate.slug,
        err: (err as Error).message,
      });
      return { kind: 'skip', reason: `LLM call failed: ${(err as Error).message}`, transient: true };
    }
    return parseDeepDecision(text, args.candidate.slug);
  }
}

// ─── User-message builder ───────────────────────────────────────────

function buildDeepUserMessage(
  c: PromotionCandidate,
  wikiIndex: string,
  relevantPages: Array<{ slug: string; markdown: string }>,
): string {
  const pageBlocks = relevantPages.length === 0
    ? '(no closely-matching wiki pages found by recall)'
    : relevantPages
        .map((p) => `<wiki_page slug="${p.slug}">\n${p.markdown.trim()}\n</wiki_page>`)
        .join('\n\n');
  return [
    `Agent: ${c.agent}`,
    `Memory slug: ${c.slug}`,
    '',
    '<wiki_index>',
    wikiIndex.trim() || '(empty)',
    '</wiki_index>',
    '',
    '<relevant_wiki_pages>',
    pageBlocks,
    '</relevant_wiki_pages>',
    '',
    '<memory_file>',
    c.body.trim(),
    '</memory_file>',
  ].join('\n');
}

// ─── Parser ─────────────────────────────────────────────────────────

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

function parseDeepDecision(raw: string, slug: string): MemoryFateDecision {
  const text = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({
      msg: 'dream.deep.parse_failed',
      slug,
      err: (err as Error).message,
      sample: text.slice(0, 200),
    });
    return { kind: 'skip', reason: 'LLM output unparseable as JSON', transient: true };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'skip', reason: 'LLM output not an object', transient: true };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.kind === 'skip') {
    return {
      kind: 'skip',
      reason: typeof obj.reason === 'string' ? obj.reason : 'LLM declined without reason',
    };
  }

  if (obj.kind === 'promote') {
    const subfolder = typeof obj.subfolder === 'string' ? obj.subfolder.trim() : '';
    const slugOut = typeof obj.slug === 'string' ? obj.slug.trim() : '';
    const type = typeof obj.type === 'string' ? obj.type.trim() : '';
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const body = typeof obj.body === 'string' ? obj.body : '';
    if (!subfolder || !slugOut || !type || !title || !body) {
      logger.warn({
        msg: 'dream.deep.promote_missing_fields',
        slug,
        have: { subfolder, slugOut, type, title, body: body.length },
      });
      return { kind: 'skip', reason: 'LLM promote response missing required fields', transient: true };
    }
    const finalSlug = slugOut.startsWith(subfolder + '/') ? slugOut : `${subfolder}/${slugOut}`;
    const related = Array.isArray(obj.related)
      ? obj.related.filter((r): r is string => typeof r === 'string')
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

  if (obj.kind === 'merge') {
    const wikiPath = typeof obj.wikiPath === 'string' ? obj.wikiPath.trim() : '';
    const body = typeof obj.body === 'string' ? obj.body : '';
    const logSummary = typeof obj.logSummary === 'string' ? obj.logSummary : '';
    if (!wikiPath || !body || !logSummary) {
      logger.warn({
        msg: 'dream.deep.merge_missing_fields',
        slug,
        have: { wikiPath, body: body.length, logSummary },
      });
      return { kind: 'skip', reason: 'LLM merge response missing required fields', transient: true };
    }
    const related = Array.isArray(obj.related)
      ? obj.related.filter((r): r is string => typeof r === 'string')
      : undefined;
    return {
      kind: 'merge',
      wikiPath,
      body,
      logSummary,
      ...(related && related.length > 0 ? { related } : {}),
    };
  }

  return { kind: 'skip', reason: `unknown decision kind: ${String(obj.kind)}`, transient: true };
}
