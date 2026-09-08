// Auto-inject memory recall as ephemeral per-turn context (DECISION #26).
//
// The runtime, not the agent, drives recall. The current user message
// is the query; the last (queryTurns - 1) text turns are CONTEXT that
// nudges the vector side at `historyWeight` (each turn capped at
// `historyTurnChars`) and never reaches the BM25 side. Until 2026-09-08
// everything was one concatenated text: a 46-character question after
// two long answers about something else recalled that something else.
// Top-N hits are formatted as a `<memory-context>` block.
//
// We return the block as a SEPARATE field from systemPrompt so engines can
// treat it as ephemeral (re-send every turn even when resuming an underlying
// provider session, where the persona systemPrompt is already remembered).
// See TurnInput.ephemeralContext.
//
// Token cap is enforced by truncating chunks (best-effort) when the
// joined block exceeds maxTokens. We approximate tokens via the project's
// 4-chars/token heuristic.
//
// ONLY query-dependent content belongs here. The wiki-overview block used
// to ride along in this block; being byte-identical every turn, it was
// pure repetition — and on openai-compatible, where buildMessages replays
// every past turn's block, it was repeated once per turn of history.
// It now lives in the system prompt, snapshotted per session by run-turn
// (buildWikiOverviewBlock). Rule of thumb: changes with the question →
// here; stable for the session → system prompt.

import type { NormalizedEvent } from '../types/events.ts';
import type { MemoryManager } from './manager.ts';
import { contentTerms, type Hit } from './retrieval.ts';

// Mirrors MemoryConfig.autoInject; we keep a local alias to avoid importing
// the inferred Zod type just for one struct.
type AutoInjectCfg = {
  queryTurns: number;
  maxResults: number;
  minScore: number;
  maxTokens: number;
  historyWeight: number;
  historyWeightShort: number;
  historyWeightEmpty: number;
  historyTurnChars: number;
};

export interface InjectResult {
  /**
   * `<memory-context>` block ready to be inlined as ephemeral per-turn
   * context. `undefined` when nothing was injected (no hits or zero-budget).
   */
  ephemeralContext: string | undefined;
  /** Number of memory hits actually included in the block. */
  injectedCount: number;
  /** The original recall hits (for telemetry / debug logging). */
  hits: Hit[];
}

export async function injectMemoryContext(args: {
  mgr: MemoryManager;
  history: NormalizedEvent[];
  userMessage: string;
  cfg: AutoInjectCfg;
}): Promise<InjectResult> {
  const query = args.userMessage;
  if (!query.trim()) {
    return { ephemeralContext: undefined, injectedCount: 0, hits: [] };
  }
  const context = buildRecallContext(args.history, args.cfg.queryTurns, args.cfg.historyTurnChars);
  const contextWeight = historyWeightFor(query, args.cfg);
  // A message with a content word also runs on its own, so a page it
  // names outright keeps its score against whatever the history says.
  const alsoQueryAlone = contentTerms(query).length > 0;
  const hits = await args.mgr.search(query, {
    limit: args.cfg.maxResults,
    minScore: args.cfg.minScore,
    ...(context ? { context, contextWeight, alsoQueryAlone } : {}),
  });

  if (hits.length === 0) {
    return { ephemeralContext: undefined, injectedCount: 0, hits: [] };
  }
  const block = formatMemoryBlock(hits, args.cfg.maxTokens);
  if (!block) {
    return { ephemeralContext: undefined, injectedCount: 0, hits };
  }
  return {
    ephemeralContext: block,
    injectedCount: hits.length,
    hits,
  };
}

/**
 * How much the history may steer this message's recall. A message with
 * three or more content words ("was weißt du über walter") decides for
 * itself; with one or two ("und seine frau?") the conversation must add
 * the topic; with none ("das solltest du aber wissen oder?") it IS the
 * topic. Exported for tests.
 */
export function historyWeightFor(
  message: string,
  cfg: Pick<AutoInjectCfg, 'historyWeight' | 'historyWeightShort' | 'historyWeightEmpty'>,
): number {
  const n = contentTerms(message).length;
  if (n === 0) return cfg.historyWeightEmpty;
  if (n <= 2) return cfg.historyWeightShort;
  return cfg.historyWeight;
}

/**
 * Recent conversation as context for the vector query: the last
 * (queryTurns - 1) text-bearing turns, newest first, each cut to the
 * head of `turnChars` characters (where a turn's topic usually is).
 * Returns '' when there is no history. Exported for tests.
 */
export function buildRecallContext(
  history: NormalizedEvent[],
  queryTurns: number,
  turnChars: number,
): string {
  const parts: string[] = [];
  for (let i = history.length - 1; i >= 0 && parts.length < queryTurns - 1; i--) {
    const ev = history[i]!;
    if (ev.kind === 'assistant_message' || ev.kind === 'user_message') {
      const text = ev.text.trim();
      if (!text) continue;
      parts.push(text.length > turnChars ? text.slice(0, turnChars) : text);
    }
  }
  return parts.reverse().join('\n');
}

function formatMemoryBlock(hits: Hit[], maxTokens: number): string {
  // Heuristic: 4 chars per token (project-wide).
  const maxChars = maxTokens * 4;
  // English meta-instruction — the actual note content (German for this user)
  // sits inside. English routing instructions are more reliable across
  // model sizes than mixing locales for the meta layer.
  //
  // Source-tag legend (Phase 4 wiki-aware):
  //   [memory/<slug>] — this agent's own short-term memory file
  //   [wiki/<path>]   — server-global consolidated wiki page (shared across agents)
  //   [vault/<path>]  — read-only Obsidian vault content outside the wiki
  // Wording matters more than it looks. The original header said the
  // notes were retrieved "(no tool call required)" and called the wiki
  // "authoritative" — measured 2026-07-22, that phrasing cut kimi-k3's
  // tool-call rate from 85% to 55% (one run: 10%) on an identical
  // request, because it reads as a general "you don't need tools here"
  // and elevates recall above the actual state of the system. Rewording
  // to "recollection, not observation" plus an explicit "recall never
  // replaces a tool" restored it to 95%.
  //
  // Full numbers and method: private/toolcall-investigation.md.
  const header =
    'Background notes recalled from your memory for this turn. ' +
    'Source tags: [memory/...] = your own short-term notes; ' +
    '[wiki/...] = shared long-term wiki; ' +
    '[vault/...] = read-only vault content. ' +
    'These notes are recollection, not observation: they can be outdated and ' +
    'say nothing about the current state of the system. ' +
    'Call `memory_search` or `memory_get` to recall more. ' +
    'Having these notes never replaces using a tool: if the user asks you to ' +
    'check, run, read or change something, do it with the appropriate tool ' +
    'rather than answering from these notes.';
  const lines: string[] = ['<memory-context>', header, ''];

  // Conservative budget: header + closing tag eats some chars
  let used = lines.join('\n').length + '\n</memory-context>'.length;

  let kept = 0;
  if (hits.length > 0) {
    lines.push('## Relevant hits for this turn');
    lines.push('');
    used += '## Relevant hits for this turn\n\n'.length;
    for (const h of hits) {
      const ref = `[${h.source}/${h.slug} · score=${h.score.toFixed(2)}]`;
      const snippet = h.text.length > 600 ? h.text.slice(0, 600).trimEnd() + '…' : h.text;
      const block = `### ${ref}\n${snippet}`;
      const cost = block.length + 2;
      if (used + cost > maxChars && kept > 0) break;
      lines.push(block);
      lines.push('');
      used += cost;
      kept++;
    }
  }
  // Nothing survived the budget — emit nothing rather than an empty shell.
  if (kept === 0) return '';
  lines.push('</memory-context>');
  return lines.join('\n');
}
