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

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  query,
  type CanUseTool,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import OpenAI from 'openai';
import { createPatientOpenAIClient } from '../server/openai-client.ts';
import type { ResolvedModel } from '../config/types.ts';
import type { ReplayPair } from '../engine/replay.ts';
import { CodexFailureDetail } from '../engine/codex-events.ts';
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
          assistant: '[kein Assistant-Reply — Turn ohne Antwort beendet]',
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
  if (override) return override;
  const required = Math.ceil(estimatedTokens * HEADROOM_FACTOR);
  const fitting = candidates
    .filter((c) => c.model.contextWindow >= required)
    .sort((a, b) => a.model.contextWindow - b.model.contextWindow);
  return fitting[0] ?? null;
}

// ──── per-engine summarize dispatchers ────

interface SummarizeViaInput {
  systemPrompt: string;
  userPrompt: string;
  resolvedModel: ResolvedModel;
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

function resolveCodexBin(): string {
  if (process.env.SOMORA_CODEX_BIN) return process.env.SOMORA_CODEX_BIN;
  const npmGlobal = join(homedir(), '.npm-global', 'bin', 'codex');
  if (existsSync(npmGlobal)) return npmGlobal;
  return 'codex';
}

async function summarizeViaCodexCli(
  input: SummarizeViaInput,
): Promise<SummarizeViaResult> {
  const { systemPrompt, userPrompt, resolvedModel } = input;
  const codexBin = resolveCodexBin();
  // codex exec has no separate system-prompt option — inline it.
  const promptPayload = `${systemPrompt}\n\n---\n\n${userPrompt}`;
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-m',
    resolvedModel.modelId,
    '-',
  ];
  return new Promise<SummarizeViaResult>((resolve, reject) => {
    const child = spawn(codexBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrBuf = '';
    let stdoutBuf = '';
    let resultText = '';
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    // codex puts the failure reason on stdout as JSON events; stderr is
    // empty on e.g. an unsupported model (HTTP 400). Keep them, or the
    // worker crash is "exit 1" and nothing else (2026-08-29 report).
    const failure = new CodexFailureDetail();
    let lastStdoutLine = '';

    child.on('error', (err) => reject(err));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderrBuf += c;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdoutBuf += c;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        lastStdoutLine = line;
        try {
          const ev = JSON.parse(line) as { type?: string; [k: string]: unknown };
          failure.observe(ev);
          if (ev.type === 'item.completed') {
            const item = ev.item as { type?: string; text?: string } | undefined;
            if (item?.type === 'agent_message' && typeof item.text === 'string') {
              resultText = item.text;
            }
          } else if (ev.type === 'turn.completed') {
            const u = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            tokensIn = u?.input_tokens;
            tokensOut = u?.output_tokens;
          }
        } catch {
          // ignore — non-JSON line
        }
      }
    });
    child.on('exit', (code) => {
      if (code !== 0 || !resultText) {
        const detail = failure.render(stderrBuf);
        logger.error({
          msg: 'compaction.worker_fail',
          engine: 'codex-cli',
          model: resolvedModel.modelId,
          exitCode: code,
          promptChars: promptPayload.length,
          streamErrors: failure.errors,
          stderr: stderrBuf.slice(0, 1000),
          lastStdoutLine: lastStdoutLine.slice(0, 300),
          hadResult: Boolean(resultText),
        });
        reject(
          new Error(
            `codex-cli summary failed (exit ${code}, model ${resolvedModel.modelId}): ${detail}`,
          ),
        );
        return;
      }
      resolve({ text: resultText.trim(), tokensIn, tokensOut });
    });
    child.stdin.end(promptPayload);
  });
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

  // Worker model selection (DECISION #21a). The override (typically
  // SOMORA_COMPACTION_MODEL env) wins if it resolves to a configured
  // model. If the override string doesn't match any alias/ref, we
  // warn and fall through to auto-pick — silent typo-fall-through
  // would be a debugging nightmare.
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
        hint: 'SOMORA_COMPACTION_MODEL did not match any configured alias or provider/modelId; falling back to auto-pick.',
      });
    }
  }
  const worker = pickCompactionModel(tokensBefore, availableModels, override);
  if (!worker) {
    logger.warn({
      msg: 'compaction.no_model_fits',
      estimatedTokens: tokensBefore,
      requiredWindow: Math.ceil(tokensBefore * HEADROOM_FACTOR),
      candidates: availableModels.map((m) => ({
        ref: `${m.providerName}/${m.modelId}`,
        contextWindow: m.model.contextWindow,
      })),
      hint: 'Configure a larger-window model or implement Map-Reduce (Phase 3).',
    });
    throw new Error(
      `no configured model has a context window >= ${Math.ceil(
        tokensBefore * HEADROOM_FACTOR,
      )} tokens; cannot compact ${tokensBefore} estimated tokens. Add a bigger model or implement Map-Reduce.`,
    );
  }

  logger.info({
    msg: 'compaction.worker_chosen',
    triggerEngine: resolvedModel.provider.engine,
    triggerModel: `${resolvedModel.providerName}/${resolvedModel.modelId}`,
    workerEngine: worker.provider.engine,
    workerModel: `${worker.providerName}/${worker.modelId}`,
    workerContextWindow: worker.model.contextWindow,
    estimatedTokens: tokensBefore,
    pairsCount: range.pairs.length,
  });

  const summaryResult = await summarizeViaEngine(worker.provider.engine, {
    systemPrompt: system,
    userPrompt: user,
    resolvedModel: worker,
  });
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
