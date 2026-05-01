// claude-cli engine: Anthropic via the local Claude Code binary
// (Subscription auth path). The provider config has no baseUrl/apiKey —
// the binary at ~/.local/bin/claude already holds the user's session.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, somoraMemoryServerSpawn } from '../mcp/config.ts';
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

async function* userInputStream(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  };
}

const ENGINE = 'claude-cli';
// Legacy sessions tagged with `engine: 'anthropic'` still resume cleanly:
// we now resume on `sdkSessionId` presence alone, regardless of the
// `engine` field, so no special-case is needed.

const KNOWN_ACCOUNT_TOOLS = [
  'mcp__claude_ai_Gmail__authenticate',
  'mcp__claude_ai_Gmail__complete_authentication',
  'mcp__claude_ai_Google_Calendar__authenticate',
  'mcp__claude_ai_Google_Calendar__complete_authentication',
  'mcp__claude_ai_Google_Drive__authenticate',
  'mcp__claude_ai_Google_Drive__complete_authentication',
];

// Allow somora-memory's own MCP tools through; deny everything else.
// Account-MCPs and built-ins (Bash/Edit/etc.) should never be invoked
// by a somora session — that's DECISION #23.
const somoraToolGate: CanUseTool = async (toolName, input) => {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    return { behavior: 'allow', updatedInput: input };
  }
  return {
    behavior: 'deny',
    message: `Tool '${toolName}' ist in dieser somora-Session nicht freigegeben.`,
  };
};

let toolsLeakWarned = false;
let mcpLeakWarned = false;

function resolveClaudeBin(): string | undefined {
  if (process.env.SOMORA_CLAUDE_BIN) return process.env.SOMORA_CLAUDE_BIN;
  const localBin = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(localBin)) return localBin;
  return undefined;
}

const CLAUDE_BIN = resolveClaudeBin();

import type { Compaction } from '../compaction/index.ts';

interface ClaudeCliMeta {
  engine?: string;
  sdkSessionId?: string;
  engineLastSeen?: EngineLastSeen;
  compactions?: Compaction[];
}

export const claudeCliEngine: AgentEngine = {
  name: ENGINE,

  async *runTurn(input: TurnInput): AsyncIterable<NormalizedEvent> {
    const {
      agent,
      session,
      systemPrompt,
      ephemeralContext,
      userMessage,
      history,
      metaStore,
      resolvedModel,
    } = input;
    if (resolvedModel.provider.engine !== ENGINE) {
      throw new Error(`claude-cli engine called with non-matching provider engine: ${resolvedModel.provider.engine}`);
    }
    const meta = (await metaStore.get(agent, session)) as ClaudeCliMeta;

    // Always resume our own SDK session if one exists — even if another
    // engine was last active. The internal session knows every turn that
    // _claude-cli_ ever made on this somora-session; the gap (turns made
    // by other engines) is bridged via delta-replay below.
    const resume = meta.sdkSessionId;
    const lastSeenTs = getLastSeenTs(meta, ENGINE);
    const replayDelta = computeReplayDelta(history, lastSeenTs, meta.compactions);
    const replayPrefix = renderReplayPrefix(replayDelta);
    const effectiveUserMessage = replayPrefix + userMessage;

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    let cumulative = '';
    let finalText = '';
    let lastSdkSessionId: string | undefined;
    let usage: { tokens_in: number; tokens_out: number } | undefined;

    try {
      logger.info({
        msg: 'engine.replay',
        engine: ENGINE,
        agent,
        session,
        lastSeenTs,
        replayPairs: replayDelta.pairs.length,
        replaySummary: Boolean(replayDelta.summary),
        resumeSdkSessionId: Boolean(resume),
      });
      // claude-agent-sdk takes one systemPrompt string per query() — we
      // concat the persona + ephemeral block. The SDK re-sends this on
      // every query() call, so per-turn memory-context updates land
      // even though the underlying provider session is resumed.
      const systemPromptForTurn = ephemeralContext
        ? `${systemPrompt}\n\n---\n\n${ephemeralContext}`
        : systemPrompt;

      const stream = query({
        prompt: userInputStream(effectiveUserMessage),
        options: {
          model: resolvedModel.modelId,
          systemPrompt: systemPromptForTurn,
          settingSources: [],
          tools: [],
          disallowedTools: KNOWN_ACCOUNT_TOOLS,
          mcpServers: {
            [MCP_SERVER_NAME]: somoraMemoryServerSpawn(agent),
          },
          canUseTool: somoraToolGate,
          // Policy-layer settings: turn off Claude Code's auto-memory so the
          // CLI doesn't inject ~/.claude/projects/<cwd>/memory/* into the
          // system prompt. Without this, somora agents inherit Claude Code's
          // own auto-memory for the cwd of the somora-server process — a
          // privacy leak (e.g. another somora agent like `lisa` could read
          // notes that belong to a Claude Code session in the same project
          // dir). settingSources:[] alone does NOT cover this — auto-memory
          // is loaded independently of settings.json files.
          managedSettings: { autoMemoryEnabled: false },
          includePartialMessages: true,
          ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
          ...(resume ? { resume } : {}),
        },
      });

      // When includePartialMessages is on, text arrives via stream_event /
      // content_block_delta tokens. The trailing 'assistant' message then
      // contains the same text again — we skip its text blocks to avoid
      // double-emitting. Tool-use blocks still come from the assistant
      // message because they're not streamed as deltas.
      let receivedTextViaStream = false;

      for await (const msg of stream) {
        if ('session_id' in msg && typeof msg.session_id === 'string') {
          lastSdkSessionId = msg.session_id;
        }

        if (msg.type === 'system' && msg.subtype === 'init') {
          logger.info({
            msg: 'engine.init',
            engine: ENGINE,
            provider: resolvedModel.providerName,
            model: resolvedModel.modelId,
            apiKeySource: msg.apiKeySource,
            sessionId: msg.session_id,
            resumed: Boolean(resume),
            tools: msg.tools,
            mcpServers: msg.mcp_servers,
          });
          // Strip our own somora-memory tools/server before checking for
          // leaks — they're expected and add intentional surface.
          const unexpectedTools = msg.tools.filter(
            (t: string) => !t.startsWith(MCP_TOOL_PREFIX),
          );
          if (unexpectedTools.length > 0 && !toolsLeakWarned) {
            logger.warn({
              msg: 'engine.tools_leaked',
              engine: ENGINE,
              tools: unexpectedTools,
              hint: 'Tools reached Claude despite disallowedTools/mcpServers/canUseTool. Update KNOWN_ACCOUNT_TOOLS in claude-cli.ts. (Logged once per server lifetime.)',
            });
            toolsLeakWarned = true;
          }
          const unexpectedServers = msg.mcp_servers.filter(
            (s) => s.name !== MCP_SERVER_NAME,
          );
          if (unexpectedServers.length > 0 && !mcpLeakWarned) {
            const summary = unexpectedServers.map((s) => `${s.name}(${s.status})`).join(', ');
            logger.warn({
              msg: 'engine.mcp_servers_leaked',
              engine: ENGINE,
              servers: summary,
              count: unexpectedServers.length,
              hint: 'Account-MCPs sichtbar im Init-Header, aber inert (tools=[]). Einmal pro Server-Lifetime.',
            });
            mcpLeakWarned = true;
          }
        } else if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            cumulative += ev.delta.text;
            receivedTextViaStream = true;
            yield { kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: cumulative };
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text' && !receivedTextViaStream) {
              cumulative += block.text;
              yield { kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: cumulative };
            } else if (block.type === 'tool_use') {
              yield {
                kind: 'tool_call',
                ts: ts(),
                engine: ENGINE,
                callId: block.id,
                tool: block.name,
                input: block.input,
              };
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message.content) {
            if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
              yield {
                kind: 'tool_result',
                ts: ts(),
                engine: ENGINE,
                callId: String(block.tool_use_id),
                output: block.content,
                ...(block.is_error ? { error: 'tool error' } : {}),
              };
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            finalText = msg.result;
            // Anthropic returns input_tokens (uncached new) separate from
            // cache_read_input_tokens and cache_creation_input_tokens.
            // For somora's display we want TOTAL context size used this
            // turn so the X/contextWindow ratio is honest and comparable
            // across engines (codex-cli/openai-compatible already report
            // totals in their `input_tokens`/`prompt_tokens`).
            const u = msg.usage as
              | {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                }
              | undefined;
            const newIn = u?.input_tokens ?? 0;
            const cacheRead = u?.cache_read_input_tokens ?? 0;
            const cacheCreate = u?.cache_creation_input_tokens ?? 0;
            usage = {
              tokens_in: newIn + cacheRead + cacheCreate,
              tokens_out: u?.output_tokens ?? 0,
            };
            logger.info({
              msg: 'engine.turn',
              engine: ENGINE,
              provider: resolvedModel.providerName,
              model: resolvedModel.modelId,
              agent,
              session,
              tokens_in: usage.tokens_in,
              tokens_in_new: newIn,
              tokens_in_cache_read: cacheRead,
              tokens_in_cache_create: cacheCreate,
              tokens_out: usage.tokens_out,
              cost_usd: msg.total_cost_usd,
              duration_ms: msg.duration_ms,
            });
          } else {
            yield {
              kind: 'error',
              ts: ts(),
              engine: ENGINE,
              message: `${msg.subtype}: ${msg.errors?.join(', ') ?? 'unknown'}`,
            };
          }
        }
      }

      if (finalText) {
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: finalText };
      }
      yield {
        kind: 'turn_end',
        ts: ts(),
        engine: ENGINE,
        turnId,
        ...(usage ? { usage } : {}),
      };

      if (lastSdkSessionId) {
        await metaStore.set(agent, session, {
          ...meta,
          engine: ENGINE,
          sdkSessionId: lastSdkSessionId,
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
