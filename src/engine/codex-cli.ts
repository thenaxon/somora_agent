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
import { somoraMemoryCodexFlags } from '../mcp/config.ts';
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

// codex feature flags we explicitly disable for somora sessions (DECISION
// #23). These are codex's default-on built-in tools that would otherwise
// give the model filesystem read, file editing, web search, browser
// automation, JS execution, and image generation — all way outside what
// a somora agent should be able to do.
//
// The somora-memory MCP server is unaffected because MCP tool dispatch
// is infrastructure (`tool_call_mcp_elicitation`), not gated by these
// feature flags.
//
// Maintained as a list of feature names from `codex features list`. If
// the codex binary version changes and a feature gets renamed, the
// `--disable <feature>` flag for the missing name is silently ignored,
// so this list is forward-compatible (no hard break) but might miss
// newly-introduced tools — re-audit with `codex features list` when
// upgrading codex.
// Source: `codex features list`. Disabled = features.<name>=false.
// Strategy: somora is "all-own-tools", so we disable EVERY codex
// built-in feature that can expose a tool surface or pull host context.
// We keep only the meta-features that route MCP tools to/from the
// model — without those, our somora-memory tools wouldn't reach the
// model at all.
//
// Re-audit whenever codex is upgraded. `codex features list` shows the
// authoritative current set; `--disable <name>` is silently ignored if
// the feature was renamed/removed, so the list is forward-tolerant but
// may miss newly-introduced tools. CI would be ideal here later.
const CODEX_DISABLED_FEATURES = [
  // ── Direct system access ──
  'shell_tool', // direct shell command execution
  'unified_exec', // newer exec mechanism
  'shell_zsh_fork', // shell variant
  'shell_snapshot', // captures host shell env into prompt — context leak
  // ── File editing ──
  'apply_patch_freeform', // free-form file editing
  'apply_patch_streaming_events', // streaming patch events
  // ── External integrations ──
  'browser_use', // browser automation
  'in_app_browser', // in-app browser
  'computer_use', // desktop / screen control
  'image_generation', // image generation
  'js_repl', // arbitrary JS execution
  'js_repl_tools_only', // partial js_repl variant
  'apps', // codex "apps" tool
  // ── Web search variants (somora will provide its own via Brave API) ──
  'web_search_cached',
  'web_search_request',
  'search_tool',
  // ── Sub-agent / multi-agent ──
  'multi_agent', // sub-agent spawning
  'multi_agent_v2',
  'enable_fanout', // parallel sub-runs
  'collaboration_modes',
  // ── Context-leak vectors (pull host config into prompt) ──
  'personality', // <personality_spec> from ~/.codex migration files
  'memories', // auto-memory from ~/.codex/memories/
  'child_agents_md', // walk-up of nested AGENTS.md files
  // ── Codex-side hooks / plugins / skills ──
  'codex_hooks', // user-defined hooks; could exec arbitrary scripts
  'plugins', // codex plugin system
  'remote_plugin',
  'skill_env_var_dependency_prompt',
  // ── Code-mode / artifact / chronicle (codex internal workflows) ──
  'code_mode',
  'code_mode_only',
  'artifact',
  'chronicle',
  'codex_git_commit',
  // ── Realtime / remote ──
  'realtime_conversation',
  'remote_control',
  'remote_models',
  // ── Misc behavior toggles we don't want flipping under us ──
  'undo',
  'fast_mode', // codex's "fast mode" picks a different model — somora picks models
  'general_analytics', // privacy: don't ship usage events from somora-spawned codex
  'request_permissions_tool',
  'request_rule',
  'default_mode_request_user_input',
  'image_detail_original',
  'tool_search_always_defer_mcp_tools', // would re-route our mcp tools through codex meta-search
  'unavailable_dummy_tools',
  //
  // KEPT enabled (intentionally NOT in this list) because somora's
  // memory/dream MCP needs them:
  //   tool_search, tool_suggest                — codex routes MCP tool
  //     calls through these meta-tools for discovery/dispatch. Disabling
  //     them was a 2j.3 mistake: gpt-5.5 then "saw" our somora-memory
  //     tools but never actually called them, hallucinating fake tool-
  //     call results instead.
  //   tool_call_mcp_elicitation                — MCP-tool invocation flow
  //   skill_mcp_dependency_install             — MCP server startup path
  //   guardian_approval                        — security gate for our tools
  //   enable_request_compression               — pure network optimization
  //   workspace_dependencies                   — package detection metadata
] as const;

import type { Compaction } from '../compaction/index.ts';

interface CodexCliMeta {
  engine?: string;
  codexSessionId?: string;
  engineLastSeen?: EngineLastSeen;
  compactions?: Compaction[];
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
    } = input;
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
    const replayDelta = computeReplayDelta(history, lastSeenTs, meta.compactions);
    const replayPrefix = renderReplayPrefix(replayDelta);

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    // codex exec has no separate system-prompt option. On the first turn
    // of a session we inline the persona systemPrompt; on resume codex
    // remembers it internally so we skip it. The ephemeralContext (memory
    // recall, future dream findings) MUST go through on every turn —
    // including resume — because the content changes per turn and codex's
    // remembered systemPrompt is frozen at session-start. Same goes for
    // the cross-engine replay prefix.
    const ephemeralBlock = ephemeralContext ? `${ephemeralContext}\n\n---\n\n` : '';
    const promptPayload = resumeId
      ? `${ephemeralBlock}${replayPrefix}${userMessage}`
      : `${systemPrompt}\n\n---\n\n${ephemeralBlock}${replayPrefix}${userMessage}`;

    // Argument order matters: `exec` accepts --sandbox, but `exec resume`
    // inherits the sandbox policy from the original thread and rejects
    // re-passing it (codex 0.125.0). Common flags first, sandbox only on
    // fresh exec, then the resume positional + stdin marker.
    const args: string[] = ['exec'];
    if (resumeId) args.push('resume');
    // Register the somora-memory MCP server for this exec via `-c` overrides.
    // Must come BEFORE `--json` so codex's argument parser applies them
    // before evaluating the rest of the command (codex's CLI lib expects
    // global flags up front).
    args.push(...somoraMemoryCodexFlags(agent));
    // Disable all of codex's built-in tools (DECISION #23 — engine-agnostic
    // tool surface; only somora-defined tools should be available). codex's
    // default-on tools include shell, file-editing, browser, image-gen,
    // js-repl, etc., which would let the model touch the filesystem and
    // network well outside the somora memory scope. The somora-memory MCP
    // continues to work because MCP tool dispatch is infrastructure, not
    // gated by these feature flags.
    for (const feat of CODEX_DISABLED_FEATURES) args.push('--disable', feat);
    // Context-isolation flags — keep host-codex setup from leaking into
    // somora agents (analogous to claude-cli's settingSources:[] +
    // managedSettings.autoMemoryEnabled=false defenses):
    //   --ignore-user-config   skip ~/.codex/config.toml (other MCPs,
    //                          model overrides, trust lists). Auth still
    //                          uses CODEX_HOME — login state survives.
    //   --ignore-rules         skip user/project execpolicy .rules files
    //   project_root_markers=[] disable AGENTS.md walk-up. By default codex
    //                          walks from cwd upward to a .git marker and
    //                          concatenates every AGENTS.md it finds into
    //                          the user instructions — would import the
    //                          somora-repo's AGENTS.md (if any) into every
    //                          turn. Empty markers list keeps codex within
    //                          cwd only. AGENTS.md at cwd-root would still
    //                          load, but that's an explicit, known location.
    args.push('--ignore-user-config', '--ignore-rules');
    args.push('-c', 'project_root_markers=[]');
    // Cross-engine thinking knob → codex's TOML override. Only applied if
    // the model declares 'reasoning' capability; otherwise dormant. 'off'
    // maps to 'minimal' since codex doesn't expose a true off-switch for
    // reasoning models.
    if (
      thinking &&
      resolvedModel.model.capabilities.includes('reasoning')
    ) {
      const codexEffort = thinking === 'off' ? 'minimal' : thinking;
      args.push('-c', `model_reasoning_effort=${codexEffort}`);
    }
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
      replayPairs: replayDelta.pairs.length,
      replaySummary: Boolean(replayDelta.summary),
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
          } else if (ev.type === 'item.started') {
            // Surface MCP tool calls as soon as they start, not only at
            // completion — so the CLI can show "[tool call · …]" while
            // the model waits for the result. codex emits mcp_tool_call
            // items with both .started (in_progress) and .completed.
            const item = ev.item as { id?: unknown; type?: unknown; [k: string]: unknown } | undefined;
            if (!item || typeof item !== 'object') continue;
            const itemType = typeof item.type === 'string' ? item.type : '';
            if (itemType === 'mcp_tool_call') {
              const itemId = typeof item.id === 'string' ? item.id : `item-${Date.now()}`;
              const server = typeof item.server === 'string' ? item.server : 'unknown';
              const tool = typeof item.tool === 'string' ? item.tool : 'unknown';
              yield {
                kind: 'tool_call',
                ts: ts(),
                engine: ENGINE,
                callId: itemId,
                // Match claude-cli's mcp__<server>__<tool> tool-name shape so
                // the CLI's dim formatter (which strips that prefix) renders
                // both engines identically.
                tool: `mcp__${server}__${tool}`,
                input: item.arguments ?? {},
              };
            }
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
            } else if (itemType === 'mcp_tool_call') {
              // codex emits a single completion event for both success and
              // failure; status === "completed" → result, anything else
              // (failed, cancelled by safety monitor, …) → error path.
              const status = typeof item.status === 'string' ? item.status : 'completed';
              const errObj = item.error as { message?: unknown } | null | undefined;
              const errMsg =
                errObj && typeof errObj === 'object' && typeof errObj.message === 'string'
                  ? errObj.message
                  : status !== 'completed'
                    ? `tool ${status}`
                    : undefined;
              yield {
                kind: 'tool_result',
                ts: ts(),
                engine: ENGINE,
                callId: itemId,
                output: item.result ?? null,
                ...(errMsg ? { error: errMsg } : {}),
              };
            } else if (itemType === 'tool_use') {
              // codex's built-in tools (shell, exec, …) — disabled per
              // DECISION #23, but preserve the parser branch so any future
              // re-enable doesn't silently drop events.
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
        ...(usage
          ? {
              usage: {
                ...usage,
                ...(usageRaw?.cached_input_tokens !== undefined
                  ? { tokens_in_cached: usageRaw.cached_input_tokens }
                  : {}),
                ...(usageRaw?.reasoning_output_tokens !== undefined
                  ? { tokens_out_reasoning: usageRaw.reasoning_output_tokens }
                  : {}),
              },
            }
          : {}),
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
