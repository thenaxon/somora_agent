import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type CanUseTool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { AgentEngine, TurnInput } from './types.ts';

async function* userInputStream(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  };
}

const ENGINE = 'anthropic';
const MODEL = 'claude-opus-4-7';

// Known account-level MCP tools that leak in via the Claude Code binary's
// user profile (claude.ai web connectors). settingSources: [] doesn't keep
// these out — we have to disallow them explicitly. Plus canUseTool denies
// anything else that might appear later.
const KNOWN_ACCOUNT_TOOLS = [
  'mcp__claude_ai_Gmail__authenticate',
  'mcp__claude_ai_Gmail__complete_authentication',
  'mcp__claude_ai_Google_Calendar__authenticate',
  'mcp__claude_ai_Google_Calendar__complete_authentication',
  'mcp__claude_ai_Google_Drive__authenticate',
  'mcp__claude_ai_Google_Drive__complete_authentication',
];

const denyAllTools: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message: `Tool '${toolName}' ist in dieser somora-Session nicht freigegeben.`,
});

function resolveClaudeBin(): string | undefined {
  if (process.env.SOMORA_CLAUDE_BIN) return process.env.SOMORA_CLAUDE_BIN;
  const localBin = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(localBin)) return localBin;
  return undefined;
}

const CLAUDE_BIN = resolveClaudeBin();

interface AnthropicMeta {
  engine?: string;
  sdkSessionId?: string;
}

export const anthropicEngine: AgentEngine = {
  name: ENGINE,

  async *runTurn(input: TurnInput): AsyncIterable<NormalizedEvent> {
    const { agent, session, systemPrompt, userMessage, metaStore } = input;
    const meta = (await metaStore.get(agent, session)) as AnthropicMeta;
    const resume = meta.engine === ENGINE ? meta.sdkSessionId : undefined;

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    let cumulative = '';
    let finalText = '';
    let lastSdkSessionId: string | undefined;
    let usage: { tokens_in: number; tokens_out: number } | undefined;

    try {
      const stream = query({
        prompt: userInputStream(userMessage),
        options: {
          model: MODEL,
          systemPrompt,
          settingSources: [],
          tools: [],
          disallowedTools: KNOWN_ACCOUNT_TOOLS,
          mcpServers: {},
          canUseTool: denyAllTools,
          ...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
          ...(resume ? { resume } : {}),
        },
      });

      for await (const msg of stream) {
        if ('session_id' in msg && typeof msg.session_id === 'string') {
          lastSdkSessionId = msg.session_id;
        }

        if (msg.type === 'system' && msg.subtype === 'init') {
          logger.info({
            msg: 'engine.init',
            engine: ENGINE,
            apiKeySource: msg.apiKeySource,
            model: msg.model,
            sessionId: msg.session_id,
            resumed: Boolean(resume),
            tools: msg.tools,
            mcpServers: msg.mcp_servers,
          });
          if (msg.tools.length > 0) {
            logger.warn({
              msg: 'engine.tools_leaked',
              engine: ENGINE,
              tools: msg.tools,
              hint: 'Tools reached Claude despite disallowedTools/mcpServers/canUseTool. Update KNOWN_ACCOUNT_TOOLS in anthropic.ts.',
            });
          }
          if (msg.mcp_servers.length > 0) {
            logger.warn({
              msg: 'engine.mcp_servers_leaked',
              engine: ENGINE,
              mcpServers: msg.mcp_servers,
              hint: 'Account-level MCP servers leaked into the session despite mcpServers: {}.',
            });
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
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
            usage = {
              tokens_in: msg.usage?.input_tokens ?? 0,
              tokens_out: msg.usage?.output_tokens ?? 0,
            };
            logger.info({
              msg: 'engine.turn',
              engine: ENGINE,
              agent,
              session,
              tokens_in: usage.tokens_in,
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
        });
      }
    } catch (err) {
      logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: String(err) });
      yield { kind: 'error', ts: ts(), engine: ENGINE, message: (err as Error).message };
      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
    }
  },
};
