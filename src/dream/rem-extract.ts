// REM-phase extraction worker. LLM-driven analysis of session JSONL
// delta against existing memory + relevant wiki pages + referenced
// vault content, produces structured Findings ready for user review
// via the dream tools.
//
// Worker model is configured per-agent in agent.yaml under `rem.model`.
// For v1 the worker MUST be an openai-compatible provider (uses the
// chat.completions API directly). claude-cli / codex-cli as worker is
// future work — would require routing through their respective adapters
// with a synthetic JSON-output prompt.
//
// Wiki-awareness (v2.5): the LLM sees the wiki index plus top-N
// embedding-matched wiki pages so it can dedupe against canonical
// long-term knowledge. Wiki = source of truth. Memory = volatile inbox.

import OpenAI from 'openai';
import { createPatientOpenAIClient } from '../server/openai-client.ts';
import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';
import type { Config, ResolvedModel, ThinkingLevel } from '../config/types.ts';
import { resolveAnyRef } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { Finding, FindingAction } from './types.ts';
import { openAiReasoningState, withReasoningRetry } from '../engine/reasoning-retry.ts';

export interface ExtractContext {
  agent: string;
  /** Slice of session JSONL to analyze. */
  events: NormalizedEvent[];
  /** Memory inbox — un-consolidated notes. As of v2.2 there are no
   *  stub pointers here; every entry is full content (or empty if the
   *  agent has no current memory). Wiki is canonical for stable
   *  knowledge — dedupe against `relevantWikiPages` not against
   *  `existingMemory`. */
  existingMemory: Array<{ slug: string; markdown: string }>;
  /** Vault notes referenced during the session (filtered subset). */
  referencedVault: Array<{ slug: string; markdown: string }>;
  /** Wiki index.md content (topology header). Always-on snapshot of
   *  what subfolders + slugs exist in the shared wiki. Empty
   *  placeholder string when wiki is disabled or empty. */
  wikiIndex?: string;
  /** Top-N wiki pages relevant to this session (embedding-matched
   *  against user-text). Full bodies. The dedup target — if a fact is
   *  already in one of these, don't surface it as a finding. */
  relevantWikiPages?: Array<{ slug: string; markdown: string }>;
  /** The resolved dream worker model. */
  workerModel: ResolvedModel;
  /** Per-chunk LLM-call timeout. */
  chunkTimeoutMs: number;
  /** Roughly tokens per chunk; events are packed up to this size. */
  chunkTokens: number;
  /** Optional thinking-level for the REM extraction LLM. Per-agent via
   *  `rem.thinking` in AGENTS.md. Helper handles `model.capabilities`
   *  guarding — unset / non-reasoning models skip the param. */
  thinking?: ThinkingLevel;
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
  /** Chunks whose LLM call errored (backend reject, timeout, transport).
   *  The runner MUST NOT treat a run with failedChunks > 0 as a clean
   *  empty result — that would silently lose the session range (bug
   *  report 2026-07-24: 19 runs masked as "no findings" in 3 days). */
  failedChunks: number;
}

const SYSTEM_PROMPT = `You are REM, the session→memory extraction worker for an AI agent in the somora system.

Layered knowledge model:
- WIKI = long-term, consolidated, shared across all agents. Source of truth
  for stable facts. You cannot edit it directly — Deep (a different worker)
  promotes facts there from agent memory.
- MEMORY = short-term, per-agent inbox. Holds atomic facts that are not yet
  in the wiki. Deep moves them to the wiki on its next run, then deletes
  them from memory.
- VAULT = user-maintained Obsidian content outside the wiki subfolder.
  Read-only for agents.

You are given:
1. A transcript chunk of recent conversation between the user and the agent.
2. The agent's current memory inbox (markdown bodies keyed by slug).
3. The wiki index (topology of subfolders + slugs).
4. Top-N wiki pages most relevant to the session content (full bodies).
5. Vault notes referenced during the session.

Your job: identify FACTS in the user's messages that should land in the
agent's memory inbox. Return ONLY a JSON array of finding objects. No
commentary, no markdown fences.

Each finding has these fields:
- action: one of "memory_write" | "memory_edit" | "memory_delete" | "vault_hint"
- slug: short kebab-case identifier (lowercase, [a-z0-9_-]).
- proposed_content: full new markdown body (for memory_write / memory_edit)
- current_excerpt: short quoted snippet of the existing memory content that
  is being changed/removed (for memory_edit / memory_delete)
- reason: 1-2 sentences explaining the finding, quoting the user's statement

DEDUP RULES (critical — wiki is canonical):
- If the WIKI already covers the fact accurately → DO NOT surface. Dedupe
  against the wiki pages provided, not against memory. Memory is volatile
  inbox; just because something is missing from memory does NOT mean it's
  unknown to the system.
- If a USER-STATEMENT CONTRADICTS the wiki → DO surface as memory_write
  with a fresh slug. Deep will see it next run, decide MERGE into the
  existing wiki page (updating the contradicted fact).
- If a fact is in the wiki AND the user just confirms or repeats it → SKIP.
- If a fact is in agent memory already (un-consolidated) → SKIP, unless
  this is a contradiction or correction.
- The vault is user-managed and may already cover the fact → SKIP if so.

WHAT TO SURFACE:
- New stable facts the wiki doesn't have yet (a project, a device, a contact,
  a place, a person, a preference).
- Contradictions: wiki/memory says X, user said not-X.
- Concrete corrections to specific data (Luca turned 9, moved house, etc.).

WHAT NOT TO SURFACE:
- Transient state ("working on X today", "feeling tired", "right now I'm…").
- Jokes, speculation, hypotheticals.
- Statements made by the AGENT — only USER statements are authoritative.
- Tool-result content the agent quoted back (memory_search, somora_docs_read,
  file_read output) — those are not user assertions.
- "Consolidated overviews" ("Alles über X", thematic summaries) — memory is
  atomic, consolidation is Deep's job.
- For vault_hint: only when an existing vault note is clearly outdated given
  user statements; do not propose creating new vault notes.

Output format example:
[
  {
    "action": "memory_write",
    "slug": "neuer-wagen",
    "proposed_content": "User confirmed a new family car arrived in 2026-05.",
    "reason": "User said on 2026-05-09: 'der neue Familienwagen ist eingetroffen'. Wiki personen/familie-klein mentions verschiedene Fahrzeuge, but not this specific model — this is a new fact."
  },
  {
    "action": "memory_write",
    "slug": "luca-alter",
    "proposed_content": "Luca ist jetzt 9 (Wiki-Page personen/luca sagt 8).",
    "reason": "User said on 2026-05-08 that Luca turned 9 last week. Wiki personen/luca says 8 — contradicts; Deep will merge this into the page next run."
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
  return createPatientOpenAIClient({
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

function formatWikiPages(notes: Array<{ slug: string; markdown: string }>): string {
  if (notes.length === 0) {
    return '(no wiki pages matched this session by recall — wiki may be empty or topic outside its scope)';
  }
  return notes
    .map((n) => {
      const parsed = matter(n.markdown);
      return `### wiki/${n.slug}\n${parsed.content.trim().slice(0, 2000)}`;
    })
    .join('\n\n');
}

function buildUserMessage(args: {
  agentName: string;
  chunk: EventChunk;
  existingMemory: Array<{ slug: string; markdown: string }>;
  referencedVault: Array<{ slug: string; markdown: string }>;
  wikiIndex: string;
  relevantWikiPages: Array<{ slug: string; markdown: string }>;
}): string {
  // Order matters for prefix-cache hit-rate across chunks of the same
  // REM extraction:
  //   - existingMemory + wiki + referencedVault are computed ONCE per
  //     run (in runDream) and are byte-identical across every chunk
  //   - chunk.events is the only piece that varies per chunk
  // → stable blocks BEFORE the variable transcript so the prefix tokens
  //   up to the transcript-content match across chunks. Backends with
  //   prefix-cache (mlx-omx, OpenAI, Anthropic-via-openai-shim) cache
  //   the memory + wiki + vault prefix on chunk 1 and reuse it on
  //   chunks 2..N.
  return [
    `Agent name: ${args.agentName}`,
    '',
    '<existing_memory>',
    formatMemory(args.existingMemory),
    '</existing_memory>',
    '',
    '<wiki_index>',
    args.wikiIndex.trim() || '(empty — no index.md or wiki disabled)',
    '</wiki_index>',
    '',
    '<wiki_relevant_pages>',
    formatWikiPages(args.relevantWikiPages),
    '</wiki_relevant_pages>',
    '',
    '<vault_referenced>',
    formatVault(args.referencedVault),
    '</vault_referenced>',
    '',
    '<transcript>',
    formatTranscript(args.chunk.events),
    '</transcript>',
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
    return { findings: [], chunksProcessed: 0, totalChunks: 0, completed: true, failedChunks: 0 };
  }

  const systemPrompt = SYSTEM_PROMPT;

  const client = buildClient(ctx.workerModel);
  const reasoning = openAiReasoningState(ctx.thinking, ctx.workerModel.model);
  const accumulated: Omit<Finding, 'id' | 'status' | 'resolved_at'>[] = [];
  const startAt = ctx.startChunk ?? 0;
  let failedChunks = 0;

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
        failedChunks,
      };
    }
    const chunk = chunks[i]!;
    try {
      const userMsg = buildUserMessage({
        agentName: ctx.agent,
        chunk,
        existingMemory: ctx.existingMemory,
        referencedVault: ctx.referencedVault,
        wikiIndex: ctx.wikiIndex ?? '',
        relevantWikiPages: ctx.relevantWikiPages ?? [],
      });
      const reqTokens = estimateTokens(systemPrompt) + estimateTokens(userMsg);
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
        // Same reasoning mapping + one retry on rejection as chat turns
        // (src/engine/reasoning-retry.ts); the adjusted value sticks for
        // the remaining chunks of this run. `max_tokens` from the model's
        // `maxTokens` bounds a runaway thinking phase on reasoning workers.
        withReasoningRetry(
          reasoning,
          (reasoningBody) =>
            client.chat.completions.create(
              {
                model: ctx.workerModel.modelId,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userMsg },
                ],
                stream: false,
                ...(ctx.workerModel.model.maxTokens
                  ? { max_tokens: ctx.workerModel.model.maxTokens }
                  : {}),
                ...reasoningBody,
              },
              // Pass the abort signal through to the HTTP layer so shutdown /
              // user-activity aborts cancel the in-flight request cleanly
              // instead of dying later with an opaque transport error
              // ("terminated") when the process tears down its sockets.
              ctx.signal ? { signal: ctx.signal } : undefined,
            ),
          {
            engine: 'openai-compatible',
            phase: 'rem',
            agent: ctx.agent,
            provider: ctx.workerModel.providerName,
            model: ctx.workerModel.modelId,
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`chunk ${i + 1}/${totalChunks} timed out after ${ctx.chunkTimeoutMs}ms`)),
            ctx.chunkTimeoutMs,
          ),
        ),
      ]);
      // Defensive: backends can answer 200 with an error body that has no
      // `choices` (omlx prefill-memory-guard rejections, 2026-07-24). A
      // bare `completion.choices[0]` access would throw the useless
      // "Cannot read properties of undefined (reading '0')" — surface the
      // actual backend payload instead.
      const choice = completion.choices?.[0];
      if (!choice?.message) {
        const bodyPreview = JSON.stringify(completion)?.slice(0, 500) ?? '(unserializable)';
        throw new Error(`backend response has no choices — raw body: ${bodyPreview}`);
      }
      const text = choice.message.content ?? '';
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
      // An abort (shutdown or user activity) surfaces here as an SDK
      // abort error once the signal is wired into the request. That is a
      // cancellation, not a chunk failure — return the paused-shape
      // result so the runner parks the dream for resume.
      if (ctx.signal?.aborted) {
        logger.info({
          msg: 'dream.extract_cancelled',
          agent: ctx.agent,
          chunkIndex: i,
          totalChunks,
          during: 'in-flight chunk request',
        });
        return {
          findings: dedupeAndAssignIds(accumulated),
          chunksProcessed: i,
          totalChunks,
          completed: false,
          failedChunks,
        };
      }
      failedChunks++;
      logger.warn({
        msg: 'dream.chunk_failed',
        agent: ctx.agent,
        chunkIndex: i + 1,
        totalChunks,
        err: (err as Error).message,
      });
      // continue to next chunk — single-chunk failure shouldn't sink the
      // whole dream; the runner decides what a non-zero failedChunks means
    }
  }

  return {
    findings: dedupeAndAssignIds(accumulated),
    chunksProcessed: totalChunks,
    totalChunks,
    completed: true,
    failedChunks,
  };
}
