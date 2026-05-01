// Dream-Mode extraction worker (Phase 2-Stufe-D). LLM-driven analysis of
// session JSONL delta against existing memory + referenced vault content,
// produces structured Findings ready for user review via the dream tools.
//
// Worker model is configured per-agent in agent.yaml under `dream.model`.
// For v1 the worker MUST be an openai-compatible provider (uses the
// chat.completions API directly). claude-cli / codex-cli as worker is
// future work — would require routing through their respective adapters
// with a synthetic JSON-output prompt.

import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import type { Config, ResolvedModel } from '../config/types.ts';
import { resolveAnyRef } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { Finding, FindingAction } from './types.ts';

export interface ExtractContext {
  agent: string;
  /** Slice of session JSONL to analyze. */
  events: NormalizedEvent[];
  /** Existing memory notes (slug + body) — what the agent currently believes. */
  existingMemory: Array<{ slug: string; markdown: string }>;
  /** Vault notes referenced during the session (filtered subset). */
  referencedVault: Array<{ slug: string; markdown: string }>;
  /** The resolved dream worker model. */
  workerModel: ResolvedModel;
  /** Per-chunk LLM-call timeout. */
  chunkTimeoutMs: number;
  /** Roughly tokens per chunk; events are packed up to this size. */
  chunkTokens: number;
  /** Optional cancellation signal — set by AutoDreamWorker on user activity. */
  signal?: AbortSignal;
  /** Skip the first N chunks (for resume after pause/crash). */
  startChunk?: number;
  /** Per-chunk progress callback so the driver can persist `chunks_done`. */
  onChunkComplete?: (info: { chunkIndex: number; totalChunks: number; chunkFindings: Finding[] }) => Promise<void>;
}

export interface ExtractResult {
  findings: Finding[];
  chunksProcessed: number;
  totalChunks: number;
  /** True if the run completed all chunks; false if cancelled mid-way. */
  completed: boolean;
}

const SYSTEM_PROMPT = `You are a memory consolidation worker for an AI agent.

You are given:
1. A transcript chunk of recent conversation between the user and the agent.
2. The agent's current memory notes (markdown files keyed by slug).
3. Vault notes that the user has and that were referenced during the session.

Your job: identify FACTS in the user's messages that the agent should remember
or that contradict existing memory. Return ONLY a JSON array of finding
objects. No commentary, no markdown fences, just the JSON.

Each finding has these fields:
- action: one of "memory_write" | "memory_edit" | "memory_delete" | "vault_hint"
- slug: short kebab-case identifier (lowercase, [a-z0-9_-]). For vault_hint
  use the vault-relative path with hyphens.
- proposed_content: full new markdown body (for memory_write / memory_edit)
- current_excerpt: short quoted snippet of the existing memory content that
  is being changed/removed (for memory_edit / memory_delete)
- reason: 1-2 sentences explaining the finding, quoting the user's statement

Rules — follow strictly:
- ONLY surface things the USER said about themselves, their projects, their
  preferences, their state. Statements made by the agent are NOT authoritative.
- DO NOT surface transient state ("working on X today", "feeling tired").
- DO NOT surface jokes, speculation, hypotheticals.
- DO NOT surface things already accurately captured in existing memory.
- DO surface contradictions: if memory says X and the user said not-X.
- DO surface concrete new facts: a new project, a new device, a new contact.
- For vault_hint: only when an existing vault note appears clearly outdated
  given user statements; do not propose creating new vault notes.

Output format example:
[
  {
    "action": "memory_edit",
    "slug": "auto",
    "current_excerpt": "Rene fährt einen Fiat 500.",
    "proposed_content": "Rene fährt einen Mercedes GT63 AMG.",
    "reason": "User said on 2026-04-30: 'ich habe mir einen Mercedes gekauft und den Fiat verkauft'."
  }
]

If there are no findings, return: []`;

const VALID_ACTIONS: ReadonlySet<FindingAction> = new Set([
  'memory_write',
  'memory_edit',
  'memory_delete',
  'vault_hint',
]);

/**
 * Build the OpenAI client for the worker model. v1 requires baseUrl+apiKey
 * (i.e. openai-compatible providers). claude-cli/codex-cli workers would
 * need different routing — explicit error keeps the failure visible.
 */
function buildClient(model: ResolvedModel): OpenAI {
  if (model.provider.engine !== 'openai-compatible') {
    throw new Error(
      `dream worker model '${model.providerName}/${model.modelId}' is on engine '${model.provider.engine}'; ` +
        `only openai-compatible engines are supported as dream workers in v1.`,
    );
  }
  return new OpenAI({
    baseURL: model.provider.baseUrl,
    apiKey: model.provider.apiKey,
  });
}

/**
 * Resolve a `dream.model` ref (alias or provider/id) against the loaded
 * Config. Throws if the ref doesn't resolve — fail-loud is intentional.
 */
export function resolveDreamModel(config: Config, ref: string): ResolvedModel {
  const resolved = resolveAnyRef(config, ref);
  if (!resolved) {
    throw new Error(`dream.model '${ref}' is not a configured model — fix agent.yaml or config.yaml`);
  }
  return resolved;
}

/**
 * Token-count estimator. Same 4-chars-per-token heuristic the rest of the
 * codebase uses. Good enough for chunk-budget decisions.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface EventChunk {
  events: NormalizedEvent[];
  /** ISO range bounds for diagnostics + finding-attribution. */
  fromTs: number;
  throughTs: number;
}

/**
 * Pack events into chunks of ~chunkTokens each. Chunk boundaries fall
 * between turn pairs (we never split a single event across chunks).
 */
function chunkEvents(events: NormalizedEvent[], chunkTokens: number): EventChunk[] {
  const out: EventChunk[] = [];
  let current: NormalizedEvent[] = [];
  let acc = 0;
  for (const ev of events) {
    const text = (ev as { text?: unknown }).text;
    const evTokens = typeof text === 'string' ? estimateTokens(text) : 50; // rough cost for non-text events
    if (acc + evTokens > chunkTokens && current.length > 0) {
      out.push({
        events: current,
        fromTs: current[0]!.ts,
        throughTs: current[current.length - 1]!.ts,
      });
      current = [];
      acc = 0;
    }
    current.push(ev);
    acc += evTokens;
  }
  if (current.length > 0) {
    out.push({
      events: current,
      fromTs: current[0]!.ts,
      throughTs: current[current.length - 1]!.ts,
    });
  }
  return out;
}

function formatTranscript(events: NormalizedEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    const ts = new Date(ev.ts).toISOString();
    if (ev.kind === 'user_message') {
      lines.push(`[${ts}] USER: ${ev.text}`);
    } else if (ev.kind === 'assistant_message') {
      lines.push(`[${ts}] AGENT: ${ev.text}`);
    } else if (ev.kind === 'tool_call') {
      const args = JSON.stringify(ev.input).slice(0, 200);
      lines.push(`[${ts}] AGENT-tool-call: ${ev.tool}(${args})`);
    }
    // Skip deltas, turn boundaries, errors — not informative for extraction.
  }
  return lines.join('\n');
}

function formatMemory(notes: Array<{ slug: string; markdown: string }>): string {
  if (notes.length === 0) return '(empty — agent has no current memory notes)';
  return notes
    .map((n) => {
      // Strip frontmatter for the extractor; only body matters semantically.
      const parsed = matter(n.markdown);
      return `### ${n.slug}\n${parsed.content.trim()}`;
    })
    .join('\n\n');
}

function formatVault(notes: Array<{ slug: string; markdown: string }>): string {
  if (notes.length === 0) return '(no vault notes were referenced in this transcript window)';
  return notes
    .map((n) => {
      const parsed = matter(n.markdown);
      return `### ${n.slug}\n${parsed.content.trim().slice(0, 1500)}`; // cap per-vault-note length
    })
    .join('\n\n');
}

function buildUserMessage(args: {
  agentName: string;
  chunk: EventChunk;
  existingMemory: Array<{ slug: string; markdown: string }>;
  referencedVault: Array<{ slug: string; markdown: string }>;
}): string {
  return [
    `Agent name: ${args.agentName}`,
    '',
    '<transcript>',
    formatTranscript(args.chunk.events),
    '</transcript>',
    '',
    '<existing_memory>',
    formatMemory(args.existingMemory),
    '</existing_memory>',
    '',
    '<vault_referenced>',
    formatVault(args.referencedVault),
    '</vault_referenced>',
  ].join('\n');
}

/**
 * Validate + coerce a raw LLM output into a sanitized Finding[].
 * Findings with bad/missing fields are dropped (with a warn log) — we
 * never throw on a single bad finding because that would lose all good
 * findings in the same chunk.
 */
function parseFindings(raw: string): Omit<Finding, 'id' | 'status' | 'resolved_at'>[] {
  // Strip common fence patterns the model might emit despite the prompt.
  let text = raw.trim();
  if (text.startsWith('```')) {
    const fenceEnd = text.lastIndexOf('```');
    if (fenceEnd > 0) {
      text = text.slice(text.indexOf('\n') + 1, fenceEnd).trim();
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn({ msg: 'dream.extract_parse_failed', err: (err as Error).message, sample: text.slice(0, 200) });
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn({ msg: 'dream.extract_not_array', got: typeof parsed });
    return [];
  }
  const out: Omit<Finding, 'id' | 'status' | 'resolved_at'>[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const action = obj.action;
    if (typeof action !== 'string' || !VALID_ACTIONS.has(action as FindingAction)) continue;
    const slug = obj.slug;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    const reason = obj.reason;
    if (typeof reason !== 'string' || reason.length === 0) continue;
    out.push({
      action: action as FindingAction,
      slug,
      reason,
      ...(typeof obj.current_excerpt === 'string' ? { current_excerpt: obj.current_excerpt } : {}),
      ...(typeof obj.proposed_content === 'string' ? { proposed_content: obj.proposed_content } : {}),
      ...(Array.isArray(obj.frontmatter_tags)
        ? { frontmatter_tags: obj.frontmatter_tags.filter((t): t is string => typeof t === 'string') }
        : {}),
    });
  }
  return out;
}

/**
 * Dedupe findings across chunks: if two findings target the same slug
 * with the same action, keep the one with the longest reason (proxy for
 * "more context"). Then assign sequential ids and default `pending` status.
 */
function dedupeAndAssignIds(
  raw: Omit<Finding, 'id' | 'status' | 'resolved_at'>[],
): Finding[] {
  const seen = new Map<string, (typeof raw)[number]>();
  for (const f of raw) {
    const key = `${f.action}::${f.slug}`;
    const existing = seen.get(key);
    if (!existing || (f.reason.length > existing.reason.length)) {
      seen.set(key, f);
    }
  }
  return [...seen.values()].map((f, i) => ({
    ...f,
    id: i + 1,
    status: 'pending' as const,
  }));
}

/**
 * Run extraction across the full event range with chunking + cancellation.
 * Returns partial results on cancel — `completed: false` then.
 */
export async function extractFromSession(ctx: ExtractContext): Promise<ExtractResult> {
  const chunks = chunkEvents(ctx.events, ctx.chunkTokens);
  const totalChunks = chunks.length;
  if (totalChunks === 0) {
    return { findings: [], chunksProcessed: 0, totalChunks: 0, completed: true };
  }

  const client = buildClient(ctx.workerModel);
  const accumulated: Omit<Finding, 'id' | 'status' | 'resolved_at'>[] = [];
  const startAt = ctx.startChunk ?? 0;

  for (let i = startAt; i < totalChunks; i++) {
    if (ctx.signal?.aborted) {
      logger.info({
        msg: 'dream.extract_cancelled',
        agent: ctx.agent,
        chunkIndex: i,
        totalChunks,
      });
      return {
        findings: dedupeAndAssignIds(accumulated),
        chunksProcessed: i,
        totalChunks,
        completed: false,
      };
    }
    const chunk = chunks[i]!;
    try {
      const userMsg = buildUserMessage({
        agentName: ctx.agent,
        chunk,
        existingMemory: ctx.existingMemory,
        referencedVault: ctx.referencedVault,
      });
      const reqTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(userMsg);
      const reqStart = Date.now();
      logger.info({
        msg: 'dream.llm_request',
        agent: ctx.agent,
        chunkIndex: i + 1,
        totalChunks,
        workerModel: `${ctx.workerModel.providerName}/${ctx.workerModel.modelId}`,
        baseUrl: ctx.workerModel.provider.engine === 'openai-compatible'
          ? (ctx.workerModel.provider as { baseUrl?: string }).baseUrl
          : undefined,
        eventsInChunk: chunk.events.length,
        estimatedTokensIn: reqTokens,
      });
      const completion = await Promise.race([
        client.chat.completions.create({
          model: ctx.workerModel.modelId,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          stream: false,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`chunk ${i + 1}/${totalChunks} timed out after ${ctx.chunkTimeoutMs}ms`)),
            ctx.chunkTimeoutMs,
          ),
        ),
      ]);
      const text = completion.choices[0]?.message?.content ?? '';
      const chunkFindings = parseFindings(text);
      accumulated.push(...chunkFindings);
      logger.info({
        msg: 'dream.chunk_done',
        agent: ctx.agent,
        chunkIndex: i + 1,
        totalChunks,
        rawFindings: chunkFindings.length,
        responseChars: text.length,
        responsePreview: text.slice(0, 300).replace(/\s+/g, ' ').trim(),
        durationMs: Date.now() - reqStart,
        usage: completion.usage,
      });
      if (ctx.onChunkComplete) {
        await ctx.onChunkComplete({
          chunkIndex: i + 1,
          totalChunks,
          chunkFindings: dedupeAndAssignIds(chunkFindings),
        });
      }
    } catch (err) {
      logger.warn({
        msg: 'dream.chunk_failed',
        agent: ctx.agent,
        chunkIndex: i + 1,
        totalChunks,
        err: (err as Error).message,
      });
      // continue to next chunk — single-chunk failure shouldn't sink the whole dream
    }
  }

  return {
    findings: dedupeAndAssignIds(accumulated),
    chunksProcessed: totalChunks,
    totalChunks,
    completed: true,
  };
}
