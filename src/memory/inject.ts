// Auto-inject memory recall into a turn's systemPrompt (DECISION #26).
//
// The runtime, not the agent, drives recall. Query = current user message
// concatenated with the last (queryTurns - 1) text turns from history.
// Top-N hits are formatted as a `<memory-context>` block appended to
// the systemPrompt for THIS turn only — never persisted to JSONL.
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
  /** systemPrompt with `<memory-context>` block appended. */
  systemPrompt: string;
  /** Number of memory hits actually injected. */
  injectedCount: number;
  /** The original recall hits (for telemetry / debug logging). */
  hits: Hit[];
}

export async function injectMemoryContext(args: {
  mgr: MemoryManager;
  systemPrompt: string;
  history: NormalizedEvent[];
  userMessage: string;
  cfg: AutoInjectCfg;
}): Promise<InjectResult> {
  const query = buildRecallQuery(args.userMessage, args.history, args.cfg.queryTurns);
  if (!query.trim()) {
    return { systemPrompt: args.systemPrompt, injectedCount: 0, hits: [] };
  }
  const hits = await args.mgr.search(query, {
    limit: args.cfg.maxResults,
    minScore: args.cfg.minScore,
  });
  if (hits.length === 0) {
    return { systemPrompt: args.systemPrompt, injectedCount: 0, hits: [] };
  }
  const block = formatMemoryBlock(hits, args.cfg.maxTokens);
  if (!block) {
    return { systemPrompt: args.systemPrompt, injectedCount: 0, hits };
  }
  return {
    systemPrompt: `${args.systemPrompt}\n\n---\n\n${block}`,
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
  // Heuristik: 4 Zeichen pro Token (project-wide).
  const maxChars = maxTokens * 4;
  const header =
    'Folgende Notizen aus deinem Memory könnten für diesen Turn relevant sein. ' +
    'Sie wurden automatisch von der Runtime herausgesucht (kein Tool-Call erforderlich). ' +
    'Wenn Du tiefer nachsehen willst, ruf `memory_search` oder `memory_get` auf.';
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
