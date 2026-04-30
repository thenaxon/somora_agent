// codex-cli engine: OpenAI via the local Codex Code binary.
// Auth path is handled by the binary itself (`~/.codex/auth.json`):
// either ChatGPT subscription (preferred, set via `codex login`) or
// `OPENAI_API_KEY`. somora doesn't pass keys directly.
//
// Session continuity: codex assigns a UUID `thread_id` on the first
// `exec` invocation; we persist it as `codexSessionId` in the session
// meta-file and resume via `codex exec resume <id>` on follow-up turns.
//
// History continuity across engine switches is not transferred — when
// the user switches from claude-cli to codex-cli mid-session, codex
// starts fresh with our system prompt. somora's JSONL still has
// everything; cross-engine continuity is a memory-layer concern.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import {
  computeReplayDelta,
  getLastSeenTs,
  renderReplayPrefix,
  withLastSeenTs,
  type EngineLastSeen,
} from './replay.ts';
import type { AgentEngine, TurnInput } from './types.ts';

const ENGINE = 'codex-cli';

interface CodexCliMeta {
  engine?: string;
  codexSessionId?: string;
  engineLastSeen?: EngineLastSeen;
}

function resolveCodexBin(): string {
  if (process.env.SOMORA_CODEX_BIN) return process.env.SOMORA_CODEX_BIN;
  const npmGlobal = join(homedir(), '.npm-global', 'bin', 'codex');
  if (existsSync(npmGlobal)) return npmGlobal;
  return 'codex';
}

const CODEX_BIN = resolveCodexBin();

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export const codexCliEngine: AgentEngine = {
  name: ENGINE,

  async *runTurn(input: TurnInput): AsyncIterable<NormalizedEvent> {
    const { agent, session, systemPrompt, userMessage, history, metaStore, resolvedModel } =
      input;
    if (resolvedModel.provider.engine !== ENGINE) {
      throw new Error(
        `codex-cli engine called with non-matching provider engine: ${resolvedModel.provider.engine}`,
      );
    }
    const meta = (await metaStore.get(agent, session)) as CodexCliMeta;

    // Always resume our own codex thread if one exists, regardless of
    // whether another engine ran in between. The thread internally knows
    // the codex-side turns; the gap is bridged via delta-replay below.
    const resumeId = meta.codexSessionId;
    const lastSeenTs = getLastSeenTs(meta, ENGINE);
    const replayPairs = computeReplayDelta(history, lastSeenTs);
    const replayPrefix = renderReplayPrefix(replayPairs);

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    // codex exec has no separate system-prompt option. On the first turn
    // of a session we inline the persona system prompt into the user
    // message; on resume codex remembers it internally. The replay-prefix
    // (delta of turns made by other engines since codex was last active)
    // is always prepended when non-empty.
    const promptPayload = resumeId
      ? `${replayPrefix}${userMessage}`
      : `${systemPrompt}\n\n---\n\n${replayPrefix}${userMessage}`;

    // Argument order matters: `exec` accepts --sandbox, but `exec resume`
    // inherits the sandbox policy from the original thread and rejects
    // re-passing it (codex 0.125.0). Common flags first, sandbox only on
    // fresh exec, then the resume positional + stdin marker.
    const args: string[] = ['exec'];
    if (resumeId) args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    if (!resumeId) args.push('--sandbox', 'read-only');
    args.push('-m', resolvedModel.modelId);
    if (resumeId) args.push(resumeId);
    args.push('-');

    logger.info({
      msg: 'engine.init',
      engine: ENGINE,
      provider: resolvedModel.providerName,
      model: resolvedModel.modelId,
      bin: CODEX_BIN,
      resumed: Boolean(resumeId),
      threadId: resumeId,
      lastSeenTs,
      replayPairs: replayPairs.length,
    });

    const child = spawn(CODEX_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let spawnError: Error | undefined;
    child.on('error', (err) => {
      spawnError = err;
    });

    let stderrBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    child.stdin.end(promptPayload);
    child.stdout.setEncoding('utf8');

    let cumulative = '';
    let finalText = '';
    let lastThreadId: string | undefined = resumeId;
    let usage: { tokens_in: number; tokens_out: number } | undefined;
    let usageRaw: CodexUsage | undefined;
    let receivedAnyEvent = false;
    let buffer = '';

    try {
      for await (const chunk of child.stdout) {
        buffer += chunk as string;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let ev: { type?: string; [k: string]: unknown };
          try {
            ev = JSON.parse(line) as { type?: string; [k: string]: unknown };
          } catch (err) {
            logger.warn({
              msg: 'engine.parse_fail',
              engine: ENGINE,
              line: line.slice(0, 200),
              err: String(err),
            });
            continue;
          }
          receivedAnyEvent = true;

          if (ev.type === 'thread.started') {
            const id = ev.thread_id;
            if (typeof id === 'string') lastThreadId = id;
          } else if (ev.type === 'turn.started') {
            // we already emitted turn_start at the top
          } else if (ev.type === 'item.completed') {
            const item = ev.item as { id?: unknown; type?: unknown; [k: string]: unknown } | undefined;
            if (!item || typeof item !== 'object') continue;
            const itemId = typeof item.id === 'string' ? item.id : `item-${Date.now()}`;
            const itemType = typeof item.type === 'string' ? item.type : 'unknown';
            if (itemType === 'agent_message') {
              const text = item.text;
              if (typeof text === 'string') {
                cumulative = text;
                finalText = text;
                yield { kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: cumulative };
              }
            } else if (itemType === 'tool_use') {
              const name = typeof item.name === 'string' ? item.name : 'unknown';
              yield {
                kind: 'tool_call',
                ts: ts(),
                engine: ENGINE,
                callId: itemId,
                tool: name,
                input: item.input ?? {},
              };
            } else if (itemType === 'tool_result') {
              const callId = typeof item.tool_use_id === 'string' ? item.tool_use_id : itemId;
              const isErr = item.is_error === true;
              yield {
                kind: 'tool_result',
                ts: ts(),
                engine: ENGINE,
                callId,
                output: item.output ?? null,
                ...(isErr ? { error: 'tool error' } : {}),
              };
            } else {
              logger.debug({
                msg: 'engine.unknown_item',
                engine: ENGINE,
                itemType,
              });
            }
          } else if (ev.type === 'turn.completed') {
            // codex `input_tokens` is the TOTAL prompt size for this turn
            // (cached + uncached). `cached_input_tokens` is a subset, kept
            // around for diagnostics. Already comparable across engines.
            const u = ev.usage as CodexUsage | undefined;
            if (u) {
              usageRaw = u;
              usage = {
                tokens_in: u.input_tokens ?? 0,
                tokens_out: u.output_tokens ?? 0,
              };
            }
          } else {
            logger.debug({
              msg: 'engine.unknown_event',
              engine: ENGINE,
              eventType: ev.type,
            });
          }
        }
      }

      const code = await exitPromise;

      if (spawnError) {
        const message = `codex spawn failed: ${spawnError.message}`;
        logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: spawnError.message });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
        return;
      }

      if (code !== 0 && !receivedAnyEvent) {
        const message = `codex exec failed (exit ${code}): ${stderrBuf.slice(0, 500).trim()}`;
        logger.error({
          msg: 'engine.fail',
          engine: ENGINE,
          agent,
          session,
          exitCode: code,
          stderr: stderrBuf.slice(0, 1000),
        });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
        return;
      }

      if (finalText) {
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: finalText };
      }

      logger.info({
        msg: 'engine.turn',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        agent,
        session,
        tokens_in: usage?.tokens_in,
        tokens_in_cached: usageRaw?.cached_input_tokens,
        tokens_out: usage?.tokens_out,
        tokens_out_reasoning: usageRaw?.reasoning_output_tokens,
        threadId: lastThreadId,
        exitCode: code,
      });

      yield {
        kind: 'turn_end',
        ts: ts(),
        engine: ENGINE,
        turnId,
        ...(usage ? { usage } : {}),
      };

      if (lastThreadId) {
        await metaStore.set(agent, session, {
          ...meta,
          engine: ENGINE,
          codexSessionId: lastThreadId,
          engineLastSeen: withLastSeenTs(meta, ENGINE, ts()),
        });
      }
    } catch (err) {
      logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: String(err) });
      yield { kind: 'error', ts: ts(), engine: ENGINE, message: (err as Error).message };
      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
    }
  },
};
