// Multi-engine one-shot LLM caller for Dream-B (Phase 4 / Stufe 4.5).
//
// Wraps a single Q&A turn — system prompt + user message → assistant text
// string — across all three somora engines. Used by the Dream-B dispatcher
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

/** Dispatch a one-shot LLM call to the right engine adapter. Returns
 *  the assistant's text content as a single string. Throws on engine
 *  errors (timeout, subprocess crash, SDK error). */
export async function callOneShotLLM(args: OneShotArgs): Promise<string> {
  const engine = args.workerModel.provider.engine;
  switch (engine) {
    case 'openai-compatible':
      return callOpenAICompat(args);
    case 'claude-cli':
      return callClaudeCli(args);
    case 'codex-cli':
      return callCodexCli(args);
    default:
      // grok-cli lands here until it grows a one-shot ACP path: the
      // dream/REM worker refs are explicit config, so a clear message
      // beats a silent fallback.
      throw new Error(
        `dream worker engine '${engine}' has no one-shot LLM path yet — configure the worker on claude-cli, codex-cli or openai-compatible`,
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
  const codexBin = resolveCodexBin();
  const reasoningArgs = codexCliReasoningArgs(args.thinking, args.workerModel.model);
  const cliArgs: string[] = [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '-c',
    'project_root_markers=[]',
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

  const child = spawn(codexBin, cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

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

function resolveCodexBin(): string {
  if (process.env.SOMORA_CODEX_BIN) return process.env.SOMORA_CODEX_BIN;
  const npmGlobal = join(homedir(), '.npm-global', 'bin', 'codex');
  if (existsSync(npmGlobal)) return npmGlobal;
  return 'codex';
}

// ─── helpers ────────────────────────────────────────────────────────

function previewSafe(text: string): string {
  return text.slice(0, 200).replace(/\s+/g, ' ').trim();
}
