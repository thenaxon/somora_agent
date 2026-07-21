// claude-cli engine: Anthropic via the local Claude Code binary
// (Subscription auth path). The provider config has no baseUrl/apiKey —
// the binary at ~/.local/bin/claude already holds the user's session.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type CanUseTool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, somoraMemoryServerSpawn } from '../mcp/config.ts';
import { reconcileClaudeCredentials } from '../server/claude-config-dir.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import {
  computeReplayDelta,
  getLastSeenTs,
  renderReplayPrefix,
  withLastSeenTs,
  type EngineLastSeen,
} from './replay.ts';
import { withFromAgentHeader } from './a2a.ts';
import type { AgentEngine, TurnInput } from './types.ts';
import { claudeCliThinkingOptions } from './thinking-params.ts';
import { buildAnthropicUserContent } from '../multimodal/user-content.ts';

async function* userInputStream(
  content: SDKUserMessage['message']['content'],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
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
      thinking,
      fromAgent,
      signal,
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
    // Memory recall (ephemeralContext, already wrapped in
    // <memory-context>...</memory-context>) goes BEFORE the actual user
    // text so the persistent system prompt can stay stable across
    // turns — Anthropic's prompt-cache cache_control breakpoint on the
    // system block then holds, instead of being invalidated every turn
    // by a per-turn-changing system string. The replayPrefix sits
    // ahead of memory because it's an even more "outer" frame
    // (cross-engine catch-up summary).
    //
    // Order in the user-message string:
    //   [replay-prefix? ][memory-recall? ][from_agent header? ][actual user text]
    //
    // claude-agent-sdk has no multi-system-message escape so we can't
    // do "second system message late" like openai-compatible — inline
    // is the structurally correct choice for this engine.
    const memoryBlock = ephemeralContext ? `${ephemeralContext}\n\n` : '';
    const effectiveUserMessage =
      replayPrefix + memoryBlock + withFromAgentHeader(userMessage, fromAgent);
    // Phase Y.B — when the user attached files to this turn, build the
    // multimodal content array. Image/PDF blocks come first, the
    // composed text block last (replay + memory + user text). Anthropic's
    // MessageParam.content is polymorphic (string | ContentBlockParam[])
    // so we just hand the SDK either form.
    const userContent =
      input.attachments && input.attachments.length > 0
        ? buildAnthropicUserContent(effectiveUserMessage, input.attachments)
        : effectiveUserMessage;

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    let cumulative = '';
    let finalText = '';
    let lastSdkSessionId: string | undefined;
    let usage: { tokens_in: number; tokens_out: number } | undefined;
    let tokensInCachedClaude: number | undefined;

    // Bridge somora's AbortSignal into the SDK's abortController option.
    // The SDK exposes only AbortController (not AbortSignal), so mirror
    // the upstream signal into a fresh controller. Hoisted out of the
    // try-block so the finally can remove the listener regardless of
    // where the throw came from.
    const sdkAbortController = new AbortController();
    const onUpstreamAbort = () => sdkAbortController.abort();
    if (signal) {
      if (signal.aborted) sdkAbortController.abort();
      else signal.addEventListener('abort', onUpstreamAbort, { once: true });
    }

    // Idle watchdog. Catches the "SDK iterator hangs forever because the
    // underlying claude-cli child died" failure mode — the SDK's stdio
    // peer sometimes doesn't propagate child exit, so `for await` just
    // suspends, no error is thrown, no turn_end is ever yielded, and the
    // session ends up with an orphan tool_call in JSONL (jarvis 2026-05-13).
    // The watchdog is reset on every received event; if N seconds pass
    // without any event, we abort the SDK to surface the failure loudly.
    //
    // Threshold comes from config.engineWatchdog.claudeCliIdleMs (default
    // 300s). Subscription-hosted claude-cli is fast; any 5min silence is
    // a dead child, not slow thinking. Operator can raise via config.yaml.
    const IDLE_TIMEOUT_MS = input.idleTimeoutMs ?? 300_000;
    // While a tool_use is outstanding the SDK stream legitimately goes
    // quiet for the tool's whole duration (it runs in the MCP child), so
    // relax the watchdog to the MCP tool timeout — a healthy long tool
    // (agent_ask, subagent_result wait_until_done) isn't cut off, while a
    // truly dead child is still caught at the tool-timeout horizon
    // (Juni-Audit 2026-06). Falls back to the normal idle threshold when
    // unset, or whichever is larger so it never shortens the window.
    const TOOL_IDLE_TIMEOUT_MS = Math.max(input.toolIdleTimeoutMs ?? 0, IDLE_TIMEOUT_MS);
    let pendingToolCalls = 0;
    let watchdogFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const threshold = pendingToolCalls > 0 ? TOOL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
      idleTimer = setTimeout(() => {
        watchdogFired = true;
        logger.error({
          msg: 'engine.watchdog_idle_timeout',
          engine: ENGINE,
          agent,
          session,
          idleMs: threshold,
          pendingToolCalls,
          hint: 'no SDK events received — likely underlying claude-cli child died silently after tool_use; aborting to surface as error',
        });
        sdkAbortController.abort();
      }, threshold);
    };
    const disarmIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

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
      // systemPrompt stays STABLE across turns now — memory landed in
      // the user-message above. Anthropic's prompt-cache marks the
      // system block with cache_control by default; keeping the string
      // identical across turns means we hit the cache for system+tools
      // every turn after the first, saving real tokens (cache reads
      // are ~10% of fresh-input cost).
      const systemPromptForTurn = systemPrompt;

      // Map somora's cross-engine thinking knob to the Claude Agent SDK's
      // thinking/effort surface via shared helper. Helper guards on the
      // model's 'reasoning' capability — otherwise the user's setting is
      // dormant and the header reflects that.
      const thinkingOptions = claudeCliThinkingOptions(
        thinking,
        resolvedModel.model,
      );

      const stream = query({
        prompt: userInputStream(userContent),
        options: {
          model: resolvedModel.modelId,
          systemPrompt: systemPromptForTurn,
          settingSources: [],
          // claude-code 2.1.142+ surfaces MCP tools to the model only
          // when the meta-tool `ToolSearch` is among the enabled
          // built-ins — the SDK uses ToolSearch as the discovery
          // mechanism for any MCP server with > a few tools. With
          // `tools: []` (which we used pre-2026-05-16) MCP tools
          // register inside the SDK but never reach the API request,
          // so the model sees nothing. Whitelisting just `ToolSearch`
          // restores tool visibility without re-enabling the
          // Bash/Edit/Read/etc built-ins that DECISION #23 keeps off.
          // See https://github.com/anthropics/claude-code/issues/38245
          tools: ['ToolSearch'],
          disallowedTools: KNOWN_ACCOUNT_TOOLS,
          mcpServers: {
            [MCP_SERVER_NAME]: somoraMemoryServerSpawn({
              agent,
              session,
              subagentDepth: input.subagentDepth,
              activeModelRef: `${resolvedModel.providerName}/${resolvedModel.modelId}`,
            }),
          },
          canUseTool: somoraToolGate,
          abortController: sdkAbortController,
          // Policy-layer settings: turn off Claude Code's auto-memory so the
          // CLI doesn't inject ~/.claude/projects/<cwd>/memory/* into the
          // system prompt. Without this, somora agents inherit Claude Code's
          // own auto-memory for the cwd of the somora-server process — a
          // privacy leak (e.g. another somora agent like another agent could read
          // notes that belong to a Claude Code session in the same project
          // dir). settingSources:[] alone does NOT cover this — auto-memory
          // is loaded independently of settings.json files.
          managedSettings: { autoMemoryEnabled: false },
          includePartialMessages: true,
          ...thinkingOptions,
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

      // Manual iteration with abort-race instead of `for await (... of
      // stream)`. The SDK's iterator sits on top of an stdio pipe to
      // the claude-cli child; if the child dies silently the pipe
      // stays half-open and the SDK's internal `read()` await never
      // resolves. Calling `sdkAbortController.abort()` from the
      // watchdog does NOT unblock that read on every Node/SDK version
      // — observed on subscription-hosted claude-cli on linux: watchdog
      // fires, logs "aborting", but the for-await loop sits there
      // forever, the catch never runs, no error/turn_end is yielded,
      // lock+queue stay held until server restart. Reproduced on
      // 2026-05-16 morning (naxon/lisa).
      //
      // Fix: race each iter.next() against the abort signal ourselves.
      // When the watchdog (or upstream user-abort) fires, the race
      // rejects synchronously and the catch below sees `watchdogFired`
      // or `signal.aborted` and emits proper terminal events.
      //
      // Verified independently on 2026-05-16 afternoon: when MCP-tools
      // registration broke (Anthropic regression in 2.1.142+), we
      // suspected this race was the cause. Reverted to plain for-await,
      // bug remained. Re-added — confirmed innocent of the MCP issue
      // (which was about `tools: []` missing ToolSearch).
      const iter = stream[Symbol.asyncIterator]();
      armIdleTimer();
      while (true) {
        let next: IteratorResult<SDKMessage>;
        try {
          next = await new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
            if (sdkAbortController.signal.aborted) {
              reject(new Error('claude-cli iterator aborted (watchdog or upstream)'));
              return;
            }
            const onAbort = (): void => {
              reject(new Error('claude-cli iterator aborted (watchdog or upstream)'));
            };
            sdkAbortController.signal.addEventListener('abort', onAbort, { once: true });
            iter.next().then(
              (r: IteratorResult<SDKMessage>) => {
                sdkAbortController.signal.removeEventListener('abort', onAbort);
                resolve(r);
              },
              (err: unknown) => {
                sdkAbortController.signal.removeEventListener('abort', onAbort);
                reject(err instanceof Error ? err : new Error(String(err)));
              },
            );
          });
        } catch (err) {
          // Best-effort cleanup — fire-and-forget, do NOT await. On a
          // wedged native async generator, return() queues behind the
          // never-settling next() and never resolves, so awaiting it
          // re-hangs the turn in exactly the stuck-pipe case this race
          // exists to escape (Juni-Audit 2026-06). Detach it and surface
          // the error immediately.
          void Promise.resolve(iter.return?.(undefined)).catch(() => {});
          throw err;
        }
        if (next.done) break;
        const msg = next.value;
        armIdleTimer();
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
              // A tool is now running in the MCP child — relax the
              // watchdog (re-arm with the tool threshold) so a legit
              // long tool isn't killed mid-run (Juni-Audit 2026-06).
              pendingToolCalls++;
              armIdleTimer();
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
              // Tool finished — drop back toward the normal idle threshold
              // once no tools are outstanding (re-armed below at loop top).
              if (pendingToolCalls > 0) pendingToolCalls--;
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
            // `msg.result` from claude-agent-sdk only carries the final
            // assistant text block — for multi-block turns that
            // intersperse `[text A, tool_use, tool_result, text B]`,
            // it equals just "B" and drops "A" on the floor. Sourcing
            // finalText from there made the chat:final event clobber
            // the streaming bubble to the post-tool text only, so the
            // web client locked in with text-A erased (luca 2026-05-12
            // bug report). `cumulative` is the running total of every
            // text_delta we saw across the whole turn, so it always
            // contains every text block in order — use it as the source
            // of truth, and fall back to `msg.result` only when no
            // streaming happened (defensive — shouldn't trigger in
            // practice since claude-agent-sdk always streams).
            finalText = cumulative || msg.result;
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
            // For the cached-token display: cache_read is "served from
            // cache this turn" — that's what we want to surface as
            // tokens_in_cached. cache_creation is uncached (new content
            // added to cache); we lump it into the "uncached / new"
            // portion implicit in tokens_in - tokens_in_cached.
            usage = {
              tokens_in: newIn + cacheRead + cacheCreate,
              tokens_out: u?.output_tokens ?? 0,
            };
            tokensInCachedClaude = cacheRead;
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

      // Auth failures surface as a NORMAL result text from the SDK
      // ("Failed to authenticate: OAuth session expired…"), not as a
      // thrown error. Detect them, run the credential reconcile (heals
      // the symlink-drift where a token refresh materialized
      // .credentials.json into a stale copy — 2026-07-21 incident), and
      // surface a proper error event with an actionable hint instead of
      // a fake assistant message.
      if (finalText && /^Failed to authenticate/i.test(finalText.trim())) {
        const healed = reconcileClaudeCredentials();
        logger.warn({ msg: 'engine.auth_failure', engine: ENGINE, agent, session, healed });
        const hint =
          healed === 'relinked' || healed === 'pushed'
            ? 'Credential-Drift erkannt und automatisch repariert — bitte die Nachricht einfach erneut senden.'
            : 'Bitte `claude login` im Terminal prüfen/ausführen und erneut senden.';
        yield { kind: 'error', ts: ts(), engine: ENGINE, message: `${finalText.trim()} — ${hint}` };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
        return;
      }

      if (finalText) {
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: finalText };
      }
      yield {
        kind: 'turn_end',
        ts: ts(),
        engine: ENGINE,
        turnId,
        ...(usage
          ? {
              usage: {
                ...usage,
                ...(typeof tokensInCachedClaude === 'number' && tokensInCachedClaude > 0
                  ? { tokens_in_cached: tokensInCachedClaude }
                  : {}),
              },
            }
          : {}),
      };

      if (lastSdkSessionId) {
        // Re-read meta from disk before merging — tools running in the
        // MCP child during this turn may have mutated session-scoped
        // fields (project_focus writes projectSlug + projectLinkedAt;
        // future tools may write others). The `meta` snapshot above is
        // from turn START and would clobber those mid-turn writes if
        // we spread it directly. Refs: naxon 2026-05-13 — project_focus
        // pin survived inside the turn, then vanished at turn end.
        // Atomic read-merge-write — re-reads under the per-session lock
        // so a concurrent /sessions stats-cache write (or activity mark)
        // can't revert sdkSessionId, and our write can't revert theirs
        // (Juni-Audit 2026-06).
        await metaStore.update(agent, session, (freshMeta) => ({
          ...freshMeta,
          engine: ENGINE,
          sdkSessionId: lastSdkSessionId,
          engineLastSeen: withLastSeenTs(freshMeta, ENGINE, ts()),
        }));
      }
    } catch (err) {
      // User pressed ESC mid-turn — emit whatever we streamed so far +
      // a marker, no error event. Anything else is a real failure.
      if (signal?.aborted) {
        logger.info({ msg: 'engine.aborted', engine: ENGINE, agent, session });
        const partial = cumulative
          ? `${cumulative}\n\n[somora] aborted by user`
          : '[somora] aborted by user';
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: partial };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      } else if (watchdogFired) {
        // Idle watchdog tripped — SDK iterator was stuck. Loud surface
        // beats silent stuck-session. Next user turn will hit
        // healOrphanToolCalls() if a tool_use was outstanding.
        logger.error({
          msg: 'engine.fail',
          engine: ENGINE,
          agent,
          session,
          err: 'idle watchdog timeout',
        });
        yield {
          kind: 'error',
          ts: ts(),
          engine: ENGINE,
          message: `engine timed out: no SDK events for ${IDLE_TIMEOUT_MS / 1000}s (claude-cli child likely died silently)`,
        };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      } else {
        const errMsg = (err as Error).message;

        // claude-cli reports "No conversation found with session ID: <uuid>"
        // when its local conversation store no longer has the session we
        // tried to resume (cleaned up, expired, fresh install, account
        // switch, etc.). Without clearing, the fallback path on the same
        // engine — and every subsequent user turn — keeps retrying the
        // dead ID and forces the user to do a manual `/reset`. Drop
        // the stale id from meta so the next attempt starts fresh.
        if (resume && /No conversation found/i.test(errMsg)) {
          try {
            // Same atomic merge as the success branch — preserve any
            // mid-turn meta writes from tools (project_focus, ...) while
            // dropping only the stale sdkSessionId. Also drop this
            // engine's lastSeen: the fresh SDK session knows nothing, so
            // the next turn must replay the FULL compaction-aware
            // history — keeping lastSeen would shrink the replay to the
            // recent delta and silently lose the older context
            // (2026-07-21, found while building the codex twin of this
            // recovery).
            await metaStore.update(agent, session, (freshMeta) => {
              const { sdkSessionId: _drop, ...rest } = freshMeta;
              const lastSeen = { ...((rest as { engineLastSeen?: Record<string, number> }).engineLastSeen ?? {}) };
              delete lastSeen[ENGINE];
              return { ...rest, engineLastSeen: lastSeen };
            });
            logger.info({
              msg: 'engine.session_resume_cleared',
              engine: ENGINE,
              agent,
              session,
              stale_id: resume,
            });
          } catch (clearErr) {
            logger.warn({
              msg: 'engine.session_resume_clear_failed',
              engine: ENGINE,
              agent,
              session,
              err: String(clearErr),
            });
          }
        }

        logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: errMsg });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message: errMsg };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      }
    } finally {
      disarmIdleTimer();
      if (signal) signal.removeEventListener('abort', onUpstreamAbort);
    }
  },
};
