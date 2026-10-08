// Multi-engine one-shot LLM caller for Dream-B (Phase 4 / Stufe 4.5).
//
// Wraps a single Q&A turn — system prompt + user message → assistant text
// string — across all four somora engines. Used by the Dream-B dispatcher
// (and later Dream-C / Lint).
//
// Why not reuse the engine adapters in `src/engine/`? Those are designed
// for the chat lifecycle: persistent sessions, history replay, MCP tools,
// memory-recall ephemeralContext, NormalizedEvent streaming. Dream-B
// wants none of that — it's a stateless, tool-less, single-turn LLM call.
// A thin wrapper is simpler than wiring through the chat adapters.
//
// Auth and binary resolution match the chat adapters so the same setup
// works (claude-cli inherits the user's Claude subscription via the SDK;
// codex-cli inherits the user's openai-codex login via CODEX_HOME).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import OpenAI from 'openai';
import { createPatientOpenAIClient } from '../server/openai-client.ts';

import type { ResolvedModel, ThinkingLevel } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { claudeCliThinkingOptions, codexCliReasoningArgs } from '../engine/thinking-params.ts';
import { openAiReasoningState, withReasoningRetry } from '../engine/reasoning-retry.ts';
import { samplingBody } from '../engine/sampling.ts';
import { userTagParam } from '../engine/user-tag.ts';
import { isAvailabilityError } from '../engine/availability.ts';
import { markModelAvailable, markModelUnavailable, modelRef, modelUnavailable } from '../engine/model-availability.ts';
import { grokOneShot } from '../engine/grok-cli.ts';
import { resolveCodexLaunch } from '../engine/codex-bin.ts';
import { buildCodexThreadConfig, codexConfigArgs } from '../engine/codex-thread-config.ts';
import { codexChildEnv, syncCodexAuth } from '../engine/codex-home.ts';

export interface OneShotArgs {
  workerModel: ResolvedModel;
  systemPrompt: string;
  userMessage: string;
  /** Hard timeout in ms. */
  timeoutMs: number;
  /** Optional upstream cancellation. */
  signal?: AbortSignal;
  /** Logger context for diagnostic lines (agent, op, slug, …). */
  logCtx: Record<string, unknown>;
  /** Optional thinking-level. Caller (DEEP/LUCID runner) supplies the
   *  value from `wiki.deep.thinking` / `wiki.lucid.thinking`. Helper
   *  guards on the worker model's 'reasoning' capability. */
  thinking?: ThinkingLevel;
}

// ─── backup workers ─────────────────────────────────────────────────
//
// Deep and Lucid name ONE worker (`wiki.deep.model`), and a run used to
// fail for as long as that model was unreachable — on one installation
// Deep stood still for three weeks behind an expired login. A worker
// can now carry backups (`wiki.deep.fallback`, `wiki.lucid.fallback`):
// when the call fails because the model is not there (connection,
// timeout, 5xx/429 — availability.ts), the next one answers. A request
// the host refuses (4xx) stays an error: another model would hide it.
//
// The chain is attached to the resolved worker object once
// (resolveDreamWorker, worker-model.ts) instead of being threaded
// through every call site. Outages are shared with chat, REM and
// compaction (model-availability.ts): a model marked unavailable is
// skipped for `fallback.retryUnavailableMinutes`, a success clears it.

const fallbackChains = new WeakMap<ResolvedModel, ResolvedModel[]>();
const answeredBy = new WeakMap<ResolvedModel, Set<string>>();

export function setOneShotFallbacks(worker: ResolvedModel, fallbacks: ResolvedModel[]): void {
  if (fallbacks.length > 0) fallbackChains.set(worker, fallbacks);
}

/** `provider/model` of every model that answered for this worker since
 *  it was resolved — one entry normally, more after a switch. */
export function oneShotAnsweredBy(worker: ResolvedModel): string[] {
  return [...(answeredBy.get(worker) ?? [])].filter((m) => !m.startsWith('announced:'));
}

/** The worker and its backups in the order to try them: models marked
 *  unavailable go to the back rather than away — if everything is
 *  marked, the first try is still the configured worker. */
export function oneShotOrder(worker: ResolvedModel, isDown: (ref: string) => boolean = (ref) => modelUnavailable(ref) !== null): ResolvedModel[] {
  const chain = [worker, ...(fallbackChains.get(worker) ?? [])];
  const up = chain.filter((m) => !isDown(modelRef(m)));
  const down = chain.filter((m) => isDown(modelRef(m)));
  return [...up, ...down];
}

/** One-shot LLM call: system prompt + user message → the assistant's
 *  text. Tries the worker, then its backups when the worker is not
 *  reachable. Throws the last error when nobody answered. */
export async function callOneShotLLM(args: OneShotArgs): Promise<string> {
  const order = oneShotOrder(args.workerModel);
  let lastErr: unknown;
  for (let i = 0; i < order.length; i++) {
    const model = order[i]!;
    const ref = modelRef(model);
    try {
      const text = await callOneShotOn({ ...args, workerModel: model });
      markModelAvailable(ref);
      let used = answeredBy.get(args.workerModel);
      if (!used) answeredBy.set(args.workerModel, (used = new Set()));
      used.add(ref);
      if (model !== args.workerModel && !used.has(`announced:${ref}`)) {
        // Once per run and backup — a Lucid run makes dozens of calls.
        used.add(`announced:${ref}`);
        logger.warn({ msg: 'dream.worker_switched', ...args.logCtx, configured: modelRef(args.workerModel), answeredBy: ref });
      }
      return text;
    } catch (err) {
      lastErr = err;
      const message = String((err as Error)?.message ?? err);
      const outage = isAvailabilityError(err) && !args.signal?.aborted;
      if (outage) markModelUnavailable(ref, message);
      const next = order[i + 1];
      if (!outage || !next) throw err;
      logger.warn({ msg: 'dream.worker_unavailable', ...args.logCtx, workerModel: ref, err: message.slice(0, 300), next: modelRef(next) });
    }
  }
  throw lastErr;
}

/** Which engines can answer a one-shot call at all. */
export function hasOneShotPath(engine: string): boolean {
  return engine === 'openai-compatible' || engine === 'claude-cli' || engine === 'codex-cli' || engine === 'grok-cli';
}

/** Dispatch to the engine adapter of ONE model — no backups, no outage
 *  bookkeeping. REM uses it for a worker on a CLI engine: it walks its
 *  own chain per chunk. */
export async function callOneShotOn(args: OneShotArgs): Promise<string> {
  const engine = args.workerModel.provider.engine;
  switch (engine) {
    case 'openai-compatible':
      return callOpenAICompat(args);
    case 'claude-cli':
      return callClaudeCli(args);
    case 'codex-cli':
      return callCodexCli(args);
    case 'grok-cli':
      return callGrokCli(args);
    default:
      // The dream/REM worker refs are explicit config, so a clear message
      // beats a silent fallback.
      throw new Error(
        `dream worker engine '${engine}' has no one-shot LLM path — configure the worker on claude-cli, codex-cli, grok-cli or openai-compatible`,
      );
  }
}

// ─── openai-compatible ──────────────────────────────────────────────

async function callOpenAICompat(args: OneShotArgs): Promise<string> {
  const provider = args.workerModel.provider as { baseUrl?: string; apiKey?: string };
  const client = createPatientOpenAIClient({
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey ?? 'dummy',
  });
  const reqStart = Date.now();
  logger.info({
    msg: 'dream.deep.llm_request',
    ...args.logCtx,
    engine: 'openai-compatible',
    model: args.workerModel.modelId,
  });

  // Same reasoning mapping + one retry on rejection as chat turns
  // (src/engine/reasoning-retry.ts); `max_tokens` from the model's
  // `maxTokens` bounds a runaway thinking phase on reasoning workers.
  const reasoning = openAiReasoningState(args.thinking, args.workerModel.model);
  const completion = await Promise.race([
    withReasoningRetry(
      reasoning,
      (reasoningBody) =>
        client.chat.completions.create(
          {
            model: args.workerModel.modelId,
            messages: [
              { role: 'system', content: args.systemPrompt },
              { role: 'user', content: args.userMessage },
            ],
            stream: false,
            ...(args.workerModel.model.maxTokens
              ? { max_tokens: args.workerModel.model.maxTokens }
              : {}),
            ...samplingBody(args.workerModel.model.sampling),
            // `user: "<agent>/<op>"` — Deep tags the memory's owner
            // agent, Lucid tags `lucid/<pass>`; see engine/user-tag.ts.
            ...userTagParam(
              args.workerModel,
              typeof args.logCtx.agent === 'string' ? args.logCtx.agent : 'somora',
              typeof args.logCtx.op === 'string' ? args.logCtx.op.split(':')[0]! : 'dream',
            ),
            ...reasoningBody,
          },
          args.signal ? { signal: args.signal } : undefined,
        ),
      {
        engine: 'openai-compatible',
        ...args.logCtx,
        provider: args.workerModel.providerName,
        model: args.workerModel.modelId,
      },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Dream-B openai-compatible call timed out after ${args.timeoutMs}ms`)),
        args.timeoutMs,
      ),
    ),
  ]);

  const text = completion.choices[0]?.message?.content ?? '';
  logger.info({
    msg: 'dream.deep.llm_response',
    ...args.logCtx,
    engine: 'openai-compatible',
    durationMs: Date.now() - reqStart,
    chars: text.length,
    preview: previewSafe(text),
    usage: completion.usage,
  });
  return text;
}

// ─── claude-cli ─────────────────────────────────────────────────────
//
// Uses claude-agent-sdk's query() directly. Single-turn — no resume,
// no MCP servers, no tools. The SDK still inherits the user's Claude
// subscription so this works without an explicit ANTHROPIC_API_KEY.

async function callClaudeCli(args: OneShotArgs): Promise<string> {
  const claudeBin = resolveClaudeBin();
  const sdkAbort = new AbortController();
  const onUpstreamAbort = () => sdkAbort.abort();
  const timer = setTimeout(() => sdkAbort.abort(), args.timeoutMs);
  if (args.signal) {
    if (args.signal.aborted) sdkAbort.abort();
    else args.signal.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  const reqStart = Date.now();
  logger.info({
    msg: 'dream.deep.llm_request',
    ...args.logCtx,
    engine: 'claude-cli',
    model: args.workerModel.modelId,
  });

  const thinkingOpts = claudeCliThinkingOptions(args.thinking, args.workerModel.model);
  let result = '';
  try {
    const stream = query({
      prompt: userInputStream(args.userMessage),
      options: {
        model: args.workerModel.modelId,
        systemPrompt: args.systemPrompt,
        // Strip everything that could leak in account-level config or
        // tool surface — Dream-B is a stateless one-shot. No tools, no
        // user-config, no auto-memory, no MCP servers.
        settingSources: [],
        tools: [],
        mcpServers: {},
        managedSettings: { autoMemoryEnabled: false },
        abortController: sdkAbort,
        ...thinkingOpts,
        ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      },
    });
    for await (const msg of stream) {
      if (msg.type === 'assistant') {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            // text blocks come as { type: 'text', text: '...' }
            if (
              block &&
              typeof block === 'object' &&
              (block as { type?: unknown }).type === 'text'
            ) {
              const t = (block as { text?: unknown }).text;
              if (typeof t === 'string') result += t;
            }
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (args.signal) args.signal.removeEventListener('abort', onUpstreamAbort);
  }

  if (sdkAbort.signal.aborted) {
    throw new Error('Dream-B claude-cli call aborted');
  }
  logger.info({
    msg: 'dream.deep.llm_response',
    ...args.logCtx,
    engine: 'claude-cli',
    durationMs: Date.now() - reqStart,
    chars: result.length,
    preview: previewSafe(result),
  });
  return result;
}

async function* userInputStream(text: string): AsyncIterable<SDKUserMessage> {
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

// ─── codex-cli ──────────────────────────────────────────────────────
//
// Spawns `codex exec --json -m <model>` with combined system+user on
// stdin. Parses JSONL stdout for the agent_message item.completed
// event — that's the assistant's reply text. No resume, sandbox=read-
// only, all built-in tools disabled.

async function callCodexCli(args: OneShotArgs): Promise<string> {
  // The bundled Codex in somora's own Codex home, like the chat engine.
  // Before 2026-10-08 this ran a global `codex` with the person's own
  // ~/.codex: without a global install Deep and Lucid on Codex failed.
  const launch = resolveCodexLaunch();
  syncCodexAuth();
  const codexBin = launch.command;
  const reasoningArgs = codexCliReasoningArgs(args.thinking, args.workerModel.model);
  const cliArgs: string[] = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    // The chat engine's lock-down (no shell, no web search, no plugins,
    // no MCP servers …): a dream worker answers from the prompt alone.
    // Before 2026-10-08 only the read-only sandbox applied, and a worker
    // asked to run `ls /` did.
    ...codexConfigArgs(buildCodexThreadConfig()),
    ...reasoningArgs,
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-m',
    args.workerModel.modelId,
    '-',
  ];
  // codex exec has no separate system-prompt option — combine inline.
  // The "---" separator matches the chat-engine pattern.
  const promptPayload = `${args.systemPrompt}\n\n---\n\n${args.userMessage}`;

  const reqStart = Date.now();
  logger.info({
    msg: 'dream.deep.llm_request',
    ...args.logCtx,
    engine: 'codex-cli',
    model: args.workerModel.modelId,
    bin: codexBin,
  });

  const child = spawn(codexBin, [...launch.args, ...cliArgs], { stdio: ['pipe', 'pipe', 'pipe'], env: codexChildEnv() });

  let abortReason: string | null = null;
  const onUpstreamAbort = () => {
    abortReason = 'aborted-by-upstream';
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(() => {
    abortReason = `timeout-${args.timeoutMs}ms`;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }, args.timeoutMs);
  if (args.signal) {
    if (args.signal.aborted) onUpstreamAbort();
    else args.signal.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  child.stdin.end(promptPayload);
  child.stdout.setEncoding('utf8');

  let stderrBuf = '';
  child.stderr.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });

  let buffer = '';
  let finalText = '';
  let receivedAnyEvent = false;

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  try {
    for await (const chunk of child.stdout) {
      buffer += chunk as string;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev: { type?: string; item?: { type?: unknown; text?: unknown } };
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        receivedAnyEvent = true;
        if (
          ev.type === 'item.completed' &&
          ev.item &&
          typeof ev.item === 'object' &&
          ev.item.type === 'agent_message' &&
          typeof ev.item.text === 'string'
        ) {
          finalText = ev.item.text;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (args.signal) args.signal.removeEventListener('abort', onUpstreamAbort);
  }

  const exitCode = await exitPromise;
  if (abortReason) {
    throw new Error(`Dream-B codex-cli call ${abortReason}`);
  }
  if (!finalText) {
    if (!receivedAnyEvent) {
      throw new Error(
        `Dream-B codex-cli produced no events (exit ${exitCode}): ${stderrBuf.slice(0, 500).trim()}`,
      );
    }
    throw new Error(
      `Dream-B codex-cli produced events but no agent_message (exit ${exitCode}): ${stderrBuf.slice(0, 500).trim()}`,
    );
  }
  logger.info({
    msg: 'dream.deep.llm_response',
    ...args.logCtx,
    engine: 'codex-cli',
    durationMs: Date.now() - reqStart,
    chars: finalText.length,
    preview: previewSafe(finalText),
    exitCode,
  });
  return finalText;
}


// ─── grok-cli ───────────────────────────────────────────────────────
//
// A fresh Grok session without tools in a private process; the helper
// lives with the engine (src/engine/grok-cli.ts) so login, binary and
// home are the chat engine's.

async function callGrokCli(args: OneShotArgs): Promise<string> {
  logger.info({ msg: 'dream.deep.llm_request', ...args.logCtx, engine: 'grok-cli', model: args.workerModel.modelId });
  const reqStart = Date.now();
  const r = await grokOneShot({
    model: args.workerModel,
    systemPrompt: args.systemPrompt,
    userMessage: args.userMessage,
    timeoutMs: args.timeoutMs,
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.thinking ? { thinking: args.thinking } : {}),
    logCtx: args.logCtx,
  });
  logger.info({
    msg: 'dream.deep.llm_response',
    ...args.logCtx,
    engine: 'grok-cli',
    durationMs: Date.now() - reqStart,
    chars: r.text.length,
    preview: previewSafe(r.text),
    usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut },
  });
  return r.text;
}

// ─── helpers ────────────────────────────────────────────────────────

function previewSafe(text: string): string {
  return text.slice(0, 200).replace(/\s+/g, ' ').trim();
}
