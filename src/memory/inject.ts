// Auto-inject memory recall as ephemeral per-turn context (DECISION #26).
//
// The runtime, not the agent, drives recall. Query = current user message
// concatenated with the last (queryTurns - 1) text turns from history.
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

import type { NormalizedEvent } from '../types/events.ts';
import type { MemoryManager } from './manager.ts';
import type { Hit } from './retrieval.ts';

// Mirrors MemoryConfig.autoInject; we keep a local alias to avoid importing
// the inferred Zod type just for one struct.
type AutoInjectCfg = {
  queryTurns: number;
  maxResults: number;
  minScore: number;
  maxTokens: number;
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
  const query = buildRecallQuery(args.userMessage, args.history, args.cfg.queryTurns);
  if (!query.trim()) {
    return { ephemeralContext: undefined, injectedCount: 0, hits: [] };
  }
  const hits = await args.mgr.search(query, {
    limit: args.cfg.maxResults,
    minScore: args.cfg.minScore,
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
 * Pull plain text out of recent assistant + user events for the recall
 * query. Newest first, capped at queryTurns text-bearing items.
 */
function buildRecallQuery(
  userMessage: string,
  history: NormalizedEvent[],
  queryTurns: number,
): string {
  const parts: string[] = [userMessage];
  let collected = 1;
  for (let i = history.length - 1; i >= 0 && collected < queryTurns; i--) {
    const ev = history[i]!;
    if (ev.kind === 'assistant_message') {
      parts.push(ev.text);
      collected++;
    } else if (ev.kind === 'user_message') {
      parts.push(ev.text);
      collected++;
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
  const header =
    'The following notes from your memory may be relevant to this turn. ' +
    'They were retrieved automatically by the runtime (no tool call required). ' +
    'Source tags: [memory/...] = your own short-term notes; ' +
    '[wiki/...] = shared long-term wiki (consolidated, authoritative); ' +
    '[vault/...] = read-only vault content. ' +
    'If you need to look deeper, call `memory_search` or `memory_get`.';
  const lines: string[] = ['<memory-context>', header, ''];

  // Conservative budget: header + closing tag eats some chars
  let used = lines.join('\n').length + '\n</memory-context>'.length;
  let kept = 0;

  for (const h of hits) {
    const ref = `[${h.source}/${h.slug} · score=${h.score.toFixed(2)}]`;
    const snippet = h.text.length > 600 ? h.text.slice(0, 600).trimEnd() + '…' : h.text;
    const block = `## ${ref}\n${snippet}`;
    const cost = block.length + 2; // +"\n\n"
    if (used + cost > maxChars && kept > 0) break;
    lines.push(block);
    lines.push('');
    used += cost;
    kept++;
  }
  if (kept === 0) return '';
  lines.push('</memory-context>');
  return lines.join('\n');
}
