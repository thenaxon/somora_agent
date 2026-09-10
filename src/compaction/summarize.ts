// Run a compaction: pick the range to summarize, pick a worker model
// whose context window can fit it, dispatch through the matching
// engine adapter, return a Compaction object. The caller is
// responsible for appending it to `meta.compactions[]`.
//
// Architecture (DECISION #21a):
//   - Trigger and worker model are separate concerns. Trigger is
//     based on the CURRENT turn's model window (so Opus' big window
//     is fully utilized). Worker is the smallest configured model
//     whose window can fit the to-be-summarized history.
//   - Worker is engine-agnostic — claude-cli, codex-cli, or
//     openai-compatible models are all valid candidates. Each engine
//     has its own summarizeVia* dispatcher below.
//   - If no model fits: hard-fail with a clear message. Map-Reduce
//     for histories larger than any single model is Phase 3.

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  query,
  type CanUseTool,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import OpenAI from 'openai';
import { createPatientOpenAIClient } from '../server/openai-client.ts';
import { userTagParam } from '../engine/user-tag.ts';
import type { ResolvedModel } from '../config/types.ts';
import type { ReplayPair } from '../engine/replay.ts';
import { CodexAppServerClient } from '../engine/codex-app-server-client.ts';
import { codexAppServerArgv, resolveCodexLaunch } from '../engine/codex-bin.ts';
import { codexChildEnv, somoraCodexHome, syncCodexAuth } from '../engine/codex-home.ts';
import { buildCodexThreadConfig } from '../engine/codex-thread-config.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { buildSummaryPrompt } from './template.ts';
import { pickLatest, type Compaction, type CompactionConfig } from './types.ts';
import { estimateTokens } from './policy.ts';

const HEADROOM_FACTOR = 1.3;

interface ExtractRangeResult {
  pairs: ReplayPair[];
  throughTs: number;
  priorSummary?: string;
}

/**
 * Determine which user/assistant pairs to compact:
 *   - skip pairs already covered by a previous compaction
 *   - keep the safetyCushionPairs newest pairs intact
 *   - everything in between is the compaction target
 */
export function extractCompactionRange(
  history: NormalizedEvent[],
  config: CompactionConfig,
  compactions: Compaction[] | undefined,
): ExtractRangeResult | null {
  const latestPrior = pickLatest(compactions);
  const sinceTs = latestPrior?.throughTs ?? 0;

  const pairs: { ts: number; user: string; assistant: string }[] = [];
  let pendingUser: { ts: number; text: string } | undefined;
  for (const ev of history) {
    if (ev.ts <= sinceTs) continue;
    if (ev.kind === 'user_message') {
      if (pendingUser !== undefined) {
        // The previous user turn never got an assistant reply (e.g. the
        // turn ended in an error before any text was produced). Without
        // this flush the pending message would be overwritten here and
        // vanish from the compacted context entirely. Preserve it as an
        // unanswered pair so its content survives the summary.
        pairs.push({
          ts: pendingUser.ts,
          user: pendingUser.text,
          assistant: '[no assistant reply — the turn ended without an answer]',
        });
      }
      pendingUser = { ts: ev.ts, text: ev.text };
    } else if (ev.kind === 'assistant_message' && pendingUser !== undefined) {
      pairs.push({ ts: ev.ts, user: pendingUser.text, assistant: ev.text });
      pendingUser = undefined;
    }
  }
  // A still-pending user at loop end is the newest (possibly in-flight)
  // turn: it stays in live history (ts > throughTs) and is deliberately
  // NOT flushed here, so it isn't double-counted into the compaction.

  const cushion = config.safetyCushionPairs;
  if (pairs.length <= cushion) {
    return null;
  }
  const compactPairs = pairs.slice(0, pairs.length - cushion);
  const lastPair = compactPairs[compactPairs.length - 1];
  if (!lastPair) return null;
  const throughTs = lastPair.ts;

  return {
    pairs: compactPairs.map((p) => ({ user: p.user, assistant: p.assistant })),
    throughTs,
    priorSummary: latestPrior?.summary,
  };
}

/**
 * Pick the worker model for compaction.
 *   - if `override` matches one of the candidates, use it (caller
 *     must check fit themselves — overrides are honored as-is)
 *   - otherwise: smallest candidate whose contextWindow >=
 *     estimatedTokens * HEADROOM_FACTOR
 *   - if no candidate fits, returns null — caller should hard-fail
 *     with a clear message (Map-Reduce is Phase 3, not implemented)
 */
export function pickCompactionModel(
  estimatedTokens: number,
  candidates: ResolvedModel[],
  override?: ResolvedModel,
): ResolvedModel | null {
  return rankCompactionModels(estimatedTokens, candidates, { override })[0] ?? null;
}

/** How many workers one compaction may ask before it gives up. Each
 *  attempt is a real request the user waits on, so the cascade is short. */
export const MAX_WORKER_ATTEMPTS = 3;

function matchesRef(m: ResolvedModel, ref: string): boolean {
  return m.model.alias === ref || m.modelId === ref || `${m.providerName}/${m.modelId}` === ref;
}

/**
 * The worker cascade: every model this compaction may try, in order.
 *
 * With `workers` configured the list IS the cascade — configured order,
 * nothing else appended, because a model the operator left out must
 * never summarize (their reasons: cost, a subscription they don't want
 * spent on summaries, a route that is slow). Entries are honored as
 * written, without a window check: an operator naming a model means it,
 * and the model itself is the better judge of what it can take.
 *
 * Without it, auto-pick as before: every candidate whose window fits the
 * summary prompt with headroom, smallest window first, so a summary does
 * not burn the biggest model in the house.
 */
export function rankCompactionModels(
  estimatedTokens: number,
  candidates: ResolvedModel[],
  opts: { override?: ResolvedModel; workers?: readonly string[] } = {},
): ResolvedModel[] {
  const ordered: ResolvedModel[] = [];
  const push = (m: ResolvedModel | undefined): void => {
    if (m && !ordered.includes(m)) ordered.push(m);
  };
  push(opts.override);
  if (opts.workers && opts.workers.length > 0) {
    for (const ref of opts.workers) push(candidates.find((c) => matchesRef(c, ref)));
    return ordered;
  }
  const required = Math.ceil(estimatedTokens * HEADROOM_FACTOR);
  for (const c of candidates
    .filter((c) => c.model.contextWindow >= required)
    .sort((a, b) => a.model.contextWindow - b.model.contextWindow)) {
    push(c);
  }
  return ordered;
}

// ──── per-engine summarize dispatchers ────

interface SummarizeViaInput {
  systemPrompt: string;
  userPrompt: string;
  resolvedModel: ResolvedModel;
  /** Whose history is being compacted — for the `user` request tag. */
  agent?: string;
}

interface SummarizeViaResult {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
}

async function summarizeViaOpenAiCompatible(
  input: SummarizeViaInput,
): Promise<SummarizeViaResult> {
  const { systemPrompt, userPrompt, resolvedModel } = input;
  if (resolvedModel.provider.engine !== 'openai-compatible') {
    throw new Error(
      `summarizeViaOpenAiCompatible called with non-openai-compatible provider: ${resolvedModel.provider.engine}`,
    );
  }
  const client = createPatientOpenAIClient({
    baseURL: resolvedModel.provider.baseUrl,
    apiKey: resolvedModel.provider.apiKey,
  });
  const completion = await client.chat.completions.create({
    model: resolvedModel.modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    ...(resolvedModel.model.maxTokens ? { max_tokens: resolvedModel.model.maxTokens } : {}),
    ...userTagParam(resolvedModel, input.agent ?? 'somora', 'compaction'),
  });
  return {
    text: completion.choices[0]?.message?.content?.trim() ?? '',
    tokensIn: completion.usage?.prompt_tokens,
    tokensOut: completion.usage?.completion_tokens,
  };
}

const KNOWN_ACCOUNT_TOOLS_FOR_SUMMARY = [
  'mcp__claude_ai_Gmail__authenticate',
  'mcp__claude_ai_Gmail__complete_authentication',
  'mcp__claude_ai_Google_Calendar__authenticate',
  'mcp__claude_ai_Google_Calendar__complete_authentication',
  'mcp__claude_ai_Google_Drive__authenticate',
  'mcp__claude_ai_Google_Drive__complete_authentication',
];

const denyAllToolsForSummary: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message: `Tool '${toolName}' is not allowed during summary generation.`,
});

async function* summaryUserInputStream(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  };
}

function resolveClaudeBin(): string | undefined {
  if (process.env.SOMORA_CLAUDE_BIN) return process.env.SOMORA_CLAUDE_BIN;
  const localBin = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(localBin)) return localBin;
  return undefined;
}

async function summarizeViaClaudeCli(
  input: SummarizeViaInput,
): Promise<SummarizeViaResult> {
  const { systemPrompt, userPrompt, resolvedModel } = input;
  const claudeBin = resolveClaudeBin();

  let result = '';
  let inputTokens = 0;
  let cacheRead = 0;
  let cacheCreate = 0;
  let outputTokens = 0;

  const stream = query({
    prompt: summaryUserInputStream(userPrompt),
    options: {
      model: resolvedModel.modelId,
      systemPrompt,
      settingSources: [],
      tools: [],
      disallowedTools: KNOWN_ACCOUNT_TOOLS_FOR_SUMMARY,
      mcpServers: {},
      canUseTool: denyAllToolsForSummary,
      includePartialMessages: false,
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    },
  });

  for await (const msg of stream) {
    if (msg.type !== 'result') continue;
    if (msg.subtype === 'success') {
      result = msg.result;
      const u = msg.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      inputTokens = u?.input_tokens ?? 0;
      cacheRead = u?.cache_read_input_tokens ?? 0;
      cacheCreate = u?.cache_creation_input_tokens ?? 0;
      outputTokens = u?.output_tokens ?? 0;
    } else {
      throw new Error(
        `claude-cli summary failed: ${msg.subtype}: ${msg.errors?.join(', ') ?? 'unknown'}`,
      );
    }
  }

  return {
    text: result.trim(),
    tokensIn: inputTokens + cacheRead + cacheCreate,
    tokensOut: outputTokens,
  };
}

/**
 * codex-cli worker: an ephemeral Codex app-server thread without dynamic
 * tools — the same client the engine adapter uses (design
 * private/codex-app-server-design.md §3.10). No rollout is written
 * (`ephemeral: true`); the final agentMessage is the summary.
 */
async function summarizeViaCodexCli(
  input: SummarizeViaInput,
): Promise<SummarizeViaResult> {
  const { systemPrompt, userPrompt, resolvedModel } = input;
  const launch = resolveCodexLaunch();
  syncCodexAuth();
  const workspace = join(somoraCodexHome(), 'workspace');
  mkdirSync(workspace, { recursive: true });
  const segments = new Map<string, string>();
  const order: string[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let usageSeen = false;
  let outcome: { status: string; error?: string } | undefined;
  const errors: string[] = [];
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const client = await CodexAppServerClient.start({
    command: launch.command,
    args: codexAppServerArgv(launch),
    env: codexChildEnv(),
    cwd: workspace,
    logCtx: { role: 'compaction-worker', model: resolvedModel.modelId },
    onServerRequest: async () => ({ contentItems: [], success: false }),
    onNotification: (method, rawParams) => {
      const p = (rawParams ?? {}) as Record<string, unknown>;
      if (method === 'item/agentMessage/delta' && typeof p.itemId === 'string' && typeof p.delta === 'string') {
        if (!segments.has(p.itemId)) order.push(p.itemId);
        segments.set(p.itemId, `${segments.get(p.itemId) ?? ''}${p.delta}`);
      } else if (method === 'item/completed') {
        const item = p.item as { id?: unknown; type?: unknown; text?: unknown } | undefined;
        if (item?.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string') {
          if (!segments.has(item.id)) order.push(item.id);
          segments.set(item.id, item.text);
        }
      } else if (method === 'thread/tokenUsage/updated') {
        const last = (p.tokenUsage as { last?: Record<string, unknown> } | undefined)?.last;
        if (last) {
          tokensIn += typeof last.inputTokens === 'number' ? last.inputTokens : 0;
          tokensOut += typeof last.outputTokens === 'number' ? last.outputTokens : 0;
          usageSeen = true;
        }
      } else if (method === 'error') {
        errors.push(typeof p.message === 'string' ? p.message : JSON.stringify(p).slice(0, 300));
      } else if (method === 'turn/completed') {
        const turn = p.turn as { status?: unknown; error?: { message?: unknown } | null } | undefined;
        outcome = {
          status: typeof turn?.status === 'string' ? turn.status : 'unknown',
          ...(turn?.error && typeof turn.error.message === 'string' ? { error: turn.error.message } : {}),
        };
        resolveDone?.();
      }
    },
  });
  void client.exited().then(() => resolveDone?.());
  try {
    const started = (await client.request(
      'thread/start',
      {
        model: resolvedModel.modelId,
        cwd: workspace,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: 'somora',
        personality: 'none',
        config: buildCodexThreadConfig({
          shellEnvironmentPolicy: process.env.SOMORA_CODEX_SHELL_ENV_POLICY,
        }),
        developerInstructions: systemPrompt,
        dynamicTools: [],
      },
      { timeoutMs: 60_000 },
    )) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (!threadId) throw new Error('thread/start returned no thread id');
    await client.request(
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text: userPrompt, text_elements: [] }],
        summary: 'none',
      },
      { timeoutMs: 60_000 },
    );
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 15 * 60_000).unref())]);
  } finally {
    client.close();
  }
  const text = order
    .map((id) => (segments.get(id) ?? '').trim())
    .filter((t) => t.length > 0)
    .join('\n\n');
  if (outcome?.status !== 'completed' || !text) {
    const detail = outcome?.error ?? (errors.length ? errors.join('; ') : `status ${outcome?.status ?? 'none (timeout or exit)'}`);
    logger.error({
      msg: 'compaction.worker_fail',
      engine: 'codex-cli',
      model: resolvedModel.modelId,
      status: outcome?.status,
      promptChars: systemPrompt.length + userPrompt.length,
      streamErrors: errors,
      stderr: client.stderrTail.slice(-600),
      hadResult: Boolean(text),
    });
    throw new Error(`codex-cli summary failed (model ${resolvedModel.modelId}): ${detail}`);
  }
  return {
    text: text.trim(),
    ...(usageSeen ? { tokensIn, tokensOut } : {}),
  };
}

/** Engines with a one-shot summarization path. grok-cli is missing on
 *  purpose: ACP has no non-interactive one-shot mode wired up yet, so a
 *  grok model must never be picked as compaction worker (its 500k
 *  window would otherwise win the auto-pick and every compaction would
 *  throw). Drop the guard once summarizeViaGrokCli exists. */
export const SUMMARIZE_ENGINES: ReadonlySet<string> = new Set([
  'openai-compatible',
  'claude-cli',
  'codex-cli',
]);

async function summarizeViaEngine(
  engineName: string,
  input: SummarizeViaInput,
): Promise<SummarizeViaResult> {
  switch (engineName) {
    case 'openai-compatible':
      return summarizeViaOpenAiCompatible(input);
    case 'claude-cli':
      return summarizeViaClaudeCli(input);
    case 'codex-cli':
      return summarizeViaCodexCli(input);
    default:
      throw new Error(
        `engine '${engineName}' has no one-shot summarization path yet — pick a compaction worker on another engine`,
      );
  }
}

// ──── orchestration ────

export interface RunCompactionInput {
  systemPrompt: string;
  history: NormalizedEvent[];
  /** Caller's current turn model — the worker MAY differ. */
  resolvedModel: ResolvedModel;
  /** All configured models (provider/model pairs) — used to pick a worker. */
  availableModels: ResolvedModel[];
  compactions: Compaction[] | undefined;
  config: CompactionConfig;
  /** Test seam: run the summary through this instead of the real engine
   *  dispatcher, so the cascade can be exercised without a provider. */
  summarize?: (worker: ResolvedModel) => Promise<SummarizeViaResult>;
}

export async function runCompaction(
  input: RunCompactionInput,
): Promise<Compaction | null> {
  const { systemPrompt, history, resolvedModel, compactions, config } = input;
  const availableModels = input.availableModels.filter((m) =>
    SUMMARIZE_ENGINES.has(m.provider.engine),
  );
  if (availableModels.length < input.availableModels.length) {
    logger.debug({
      msg: 'compaction.worker_candidates_filtered',
      dropped: input.availableModels
        .filter((m) => !SUMMARIZE_ENGINES.has(m.provider.engine))
        .map((m) => `${m.providerName}/${m.modelId}`),
      reason: 'engine has no one-shot summarization path',
    });
  }
  const range = extractCompactionRange(history, config, compactions);
  if (!range) return null;

  const { system, user } = buildSummaryPrompt({
    systemPrompt,
    pairs: range.pairs,
    priorSummary: range.priorSummary,
  });

  const tokensBefore = estimateTokens(system + user);

  // Worker model selection (DECISION #21a), now a cascade.
  //
  // `modelOverride` (typically the SOMORA_COMPACTION_MODEL env) is tried
  // first if it resolves. A typo warns loudly instead of silently
  // picking something else — silent typo-fall-through would be a
  // debugging nightmare.
  let override: ResolvedModel | undefined;
  if (config.modelOverride) {
    override = availableModels.find(
      (m) => m.model.alias === config.modelOverride || m.modelId === config.modelOverride,
    );
    if (!override) {
      logger.warn({
        msg: 'compaction.override_unresolved',
        requested: config.modelOverride,
        availableAliases: availableModels.flatMap((m) => (m.model.alias ? [m.model.alias] : [])),
        availableRefs: availableModels.map((m) => `${m.providerName}/${m.modelId}`),
        hint: 'SOMORA_COMPACTION_MODEL did not match any configured alias or provider/modelId; falling back to the rest of the cascade.',
      });
    }
  }
  if (config.workers) {
    const unresolved = config.workers.filter(
      (ref) => !availableModels.some((m) => matchesRef(m, ref)),
    );
    if (unresolved.length > 0) {
      logger.warn({
        msg: 'compaction.workers_unresolved',
        requested: unresolved,
        availableAliases: availableModels.flatMap((m) => (m.model.alias ? [m.model.alias] : [])),
        availableRefs: availableModels.map((m) => `${m.providerName}/${m.modelId}`),
        hint: 'compaction.workers entries that match no configured alias or provider/modelId are skipped.',
      });
    }
  }
  const ranked = rankCompactionModels(tokensBefore, availableModels, {
    override,
    workers: config.workers,
  });
  if (ranked.length === 0) {
    logger.warn({
      msg: 'compaction.no_model_fits',
      estimatedTokens: tokensBefore,
      requiredWindow: Math.ceil(tokensBefore * HEADROOM_FACTOR),
      configuredWorkers: config.workers,
      candidates: availableModels.map((m) => ({
        ref: `${m.providerName}/${m.modelId}`,
        contextWindow: m.model.contextWindow,
      })),
      hint: config.workers
        ? 'No compaction.workers entry resolved to a configured model.'
        : 'Configure a larger-window model or implement Map-Reduce (Phase 3).',
    });
    throw new Error(
      config.workers
        ? `no compaction.workers entry (${config.workers.join(', ')}) resolves to a configured model that can summarize`
        : `no configured model has a context window >= ${Math.ceil(
            tokensBefore * HEADROOM_FACTOR,
          )} tokens; cannot compact ${tokensBefore} estimated tokens. Add a bigger model or implement Map-Reduce.`,
    );
  }

  // The cascade. One worker refusing is not the compaction failing: on
  // 2026-09-10 the single chosen worker was rejected by its host's
  // memory guard, the compaction gave up, the prompt still did not fit,
  // and the whole turn fell through to another chat model. somora cannot
  // know which machine sits behind which route — so it does not guess,
  // it just asks the next one.
  const cascade = ranked.slice(0, MAX_WORKER_ATTEMPTS);
  const summarize = input.summarize ?? ((worker: ResolvedModel) =>
    summarizeViaEngine(worker.provider.engine, {
      systemPrompt: system,
      userPrompt: user,
      resolvedModel: worker,
    }));
  const failures: string[] = [];
  let worker: ResolvedModel | undefined;
  let summaryResult: SummarizeViaResult | undefined;
  for (const [i, candidate] of cascade.entries()) {
    logger.info({
      msg: 'compaction.worker_chosen',
      attempt: i + 1,
      attemptsAllowed: cascade.length,
      triggerEngine: resolvedModel.provider.engine,
      triggerModel: `${resolvedModel.providerName}/${resolvedModel.modelId}`,
      workerEngine: candidate.provider.engine,
      workerModel: `${candidate.providerName}/${candidate.modelId}`,
      workerContextWindow: candidate.model.contextWindow,
      estimatedTokens: tokensBefore,
      pairsCount: range.pairs.length,
    });
    try {
      summaryResult = await summarize(candidate);
      worker = candidate;
      break;
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      failures.push(`${candidate.providerName}/${candidate.modelId}: ${message}`);
      logger.warn({
        msg: 'compaction.worker_failed',
        attempt: i + 1,
        attemptsAllowed: cascade.length,
        workerModel: `${candidate.providerName}/${candidate.modelId}`,
        err: message,
        next: cascade[i + 1]
          ? `${cascade[i + 1]!.providerName}/${cascade[i + 1]!.modelId}`
          : null,
      });
    }
  }
  if (!worker || !summaryResult) {
    logger.error({
      msg: 'compaction.all_workers_failed',
      attempts: failures.length,
      remainingCandidates: ranked.length - cascade.length,
      failures,
    });
    throw new Error(
      `all ${failures.length} compaction worker(s) refused the summary — ${failures.join(' | ')}`,
    );
  }
  if (!summaryResult.text) return null;

  return {
    ts: Date.now(),
    throughTs: range.throughTs,
    summary: summaryResult.text,
    byEngine: worker.provider.engine,
    byModel: `${worker.providerName}/${worker.modelId}`,
    tokensBefore,
    tokensAfter: summaryResult.tokensOut ?? estimateTokens(summaryResult.text),
  };
}
