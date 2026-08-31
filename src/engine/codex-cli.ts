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
import { somoraMcpProxyCodexFlags, somoraMemoryCodexFlags } from '../mcp/config.ts';
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
import { buildCodexAttachments } from '../multimodal/user-content.ts';
import { codexCliReasoningArgs } from './thinking-params.ts';
import { CodexFailureDetail } from './codex-events.ts';

const ENGINE = 'codex-cli';

// codex feature flags we explicitly disable for somora sessions (DECISION
// #23). These are codex's stable, default-on built-in tools that would
// otherwise give the model filesystem read, file editing, web search,
// browser automation, image generation, and host-config exfiltration —
// all way outside what a somora agent should be able to do.
//
// Scope of this list: codex-CLI-LOCAL surface only. The OpenAI Responses
// API additionally injects a server-side built-in tool set based on the
// model preset (codex-* family → `web.run`, `functions.apply_patch`,
// `functions.update_plan`, `functions.view_image`, `multi_tool_use.*`,
// etc.). Those live in OpenAI's `RESERVED_RESPONSES_NAMESPACES` and are
// NOT controllable via codex feature flags — they require config-level
// overrides (see -c web_search="disabled" + tools.view_image=false in
// the spawn block below) or a model-preset change. Issue openai/codex#6049
// tracks the upstream gap; somora can only do its half here.
//
// Audit policy: list contains ONLY features that are currently `stable`
// AND `default true` per `codex features list`. Stale entries (removed /
// deprecated / under-development) are silently no-ops and were pruned
// 2026-05-16 — they cluttered without effect. Re-audit on every codex
// upgrade: any new stable+default-true entry that exposes a tool surface
// or host-config leak goes here. Last audit: 2026-07-21 against
// codex-cli 0.144.6 (added browser_use_full_cdp_access, mentions_v2,
// plugin_sharing, remote_plugin, goals, code_mode_host; bundled-skills
// suppression lives in the `-c skills.*` overrides in runTurn, not
// here — skills are not part of the feature catalog).
const CODEX_DISABLED_FEATURES = [
  // Direct system access
  'shell_tool',
  'unified_exec',
  'shell_snapshot', // captures host shell env into prompt
  // External integrations
  'browser_use',
  'browser_use_external', // added 2026-05-16 — was leaking `web.run` to model
  'browser_use_full_cdp_access', // 0.144 audit — sub-flag of browser_use, disabled for completeness
  'in_app_browser',
  'computer_use',
  'image_generation',
  'apps', // connector/apps surface
  // Sub-agent / multi-agent (somora has its own spawn_subagent)
  'multi_agent',
  'collaboration_modes', // NB 0.144.6: flag "removed", behavior baked in — kept for older codex; inert without multi_agent
  // Context-leak vectors (pull host config into prompt)
  'personality', // <personality_spec> from ~/.codex migration files
  'mentions_v2', // 0.144 audit — @-mention parsing could pull host files into the prompt
  // Codex-side hooks / plugins (could exec arbitrary scripts)
  'hooks',
  'plugins',
  'plugin_sharing', // 0.144 audit — plugin-subsystem extension; plugins are off, disable explicitly
  'remote_plugin', // 0.144 audit — same
  // New 0.144 behavior toggles we don't use
  'goals', // thread-goal tracking (sqlite state db + goal events)
  'code_mode_host', // host side of the (still-experimental) code_mode surface
  // Misc behavior toggles we don't want flipping under us
  'fast_mode', // picks a different model — somora picks models
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
  /** Resolved modelId the codex thread was created/last continued with.
   *  Codex refuses to silently resume a thread under a different model
   *  (it emits a raw mismatch error item instead of answering — hans
   *  2026-07-20 report). We persist the model next to the thread id so
   *  a mismatch is detected BEFORE resume and handled as a deliberate
   *  re-thread, not surfaced as a broken turn. */
  codexRecordedModel?: string;
  engineLastSeen?: EngineLastSeen;
  compactions?: Compaction[];
}

/** codex `exec resume` stderr when the thread id has no local rollout
 *  (cleaned up, expired, CODEX_HOME switch, …). Observed on codex-cli
 *  0.144.6: `thread/resume failed: no rollout found for thread id <id>`. */
const CODEX_STALE_THREAD_RE = /no rollout found for thread|thread\/resume failed/i;

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
      projectContext,
      userMessage,
      history,
      metaStore,
      resolvedModel,
      thinking,
      fromAgent,
      signal,
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
    //
    // EXCEPT on a model switch: codex threads are pinned to the model
    // they were recorded with — resuming under a different model makes
    // codex emit a raw mismatch error item instead of answering. The
    // somora session and the codex thread are separate things, so we
    // handle the switch the same way as a lost thread: drop ONLY the
    // codex-side thread and rebuild a fresh one seeded with the full
    // (compaction-aware) history replay. The somora session — slug,
    // JSONL, meta — is untouched; the user just sees an info marker.
    let resumeId = meta.codexSessionId;
    let modelSwitched: { from: string; to: string } | undefined;
    if (
      resumeId &&
      meta.codexRecordedModel &&
      meta.codexRecordedModel !== resolvedModel.modelId
    ) {
      modelSwitched = { from: meta.codexRecordedModel, to: resolvedModel.modelId };
      resumeId = undefined;
      logger.info({
        msg: 'engine.model_switch_rethread',
        engine: ENGINE,
        agent,
        session,
        recordedModel: modelSwitched.from,
        selectedModel: modelSwitched.to,
        droppedThreadId: meta.codexSessionId,
      });
    }
    // On a re-thread the fresh codex thread knows NOTHING — replay from
    // ts 0 so the compaction-aware delta folds in the whole session
    // ([summary] + pairs after), not just the gap since codex last ran.
    const lastSeenTs = modelSwitched ? 0 : getLastSeenTs(meta, ENGINE);
    const replayDelta = computeReplayDelta(history, lastSeenTs, meta.compactions);
    const replayPrefix = renderReplayPrefix(replayDelta);

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };
    if (modelSwitched) {
      // Friendly, persisted marker instead of codex's raw mismatch item.
      yield {
        kind: 'engine_meta',
        ts: ts(),
        engine: ENGINE,
        itemType: 'model_switch',
        payload: {
          from: modelSwitched.from,
          to: modelSwitched.to,
          text: `Codex thread restarted for the model switch (${modelSwitched.from} → ${modelSwitched.to}) — session history carried over.`,
        },
      };
    }

    // codex exec has no separate system-prompt option. On the first turn
    // of a session we inline the persona systemPrompt; on resume codex
    // remembers it internally so we skip it. The ephemeralContext (memory
    // recall, future dream findings) MUST go through on every turn —
    // including resume — because the content changes per turn and codex's
    // remembered systemPrompt is frozen at session-start. Same goes for
    // the cross-engine replay prefix.
    const ephemeralBlock = ephemeralContext ? `${ephemeralContext}\n\n---\n\n` : '';
    // Project block on resume: codex's frozen systemPrompt also locks
    // out a mid-session project pin. Mirror the ephemeralBlock pattern
    // here — inline the project block on resume so a `/projekt` switch
    // is visible to the model from the next turn onward. On fresh
    // sessions the block is already in `systemPrompt` (run-turn includes
    // it there); we skip projectContext on fresh to avoid duplicating it.
    const projectBlockForResume =
      resumeId && projectContext ? `${projectContext}\n\n---\n\n` : '';
    const taggedUserMessage = withFromAgentHeader(userMessage, fromAgent);
    // Phase Y.B — codex's `--image` flag accepts only image files.
    // PDFs get rasterised to PNG-pages, text attachments get inlined
    // into the prompt prefix (codex has no native non-image attachment
    // surface). buildCodexAttachments handles all three cases.
    const { imagePaths, promptPrefix: attachmentPrefix } = await buildCodexAttachments(
      input.attachments ?? [],
    );
    const promptPayload = resumeId
      ? `${attachmentPrefix}${ephemeralBlock}${projectBlockForResume}${replayPrefix}${taggedUserMessage}`
      : `${systemPrompt}\n\n---\n\n${attachmentPrefix}${ephemeralBlock}${replayPrefix}${taggedUserMessage}`;

    const args: string[] = ['exec'];
    if (resumeId) args.push('resume');
    // Register the somora-memory MCP server for this exec via `-c` overrides.
    // Must come BEFORE `--json` so codex's argument parser applies them
    // before evaluating the rest of the command (codex's CLI lib expects
    // global flags up front).
    args.push(
      ...somoraMemoryCodexFlags({
        agent,
        session,
        subagentDepth: input.subagentDepth,
        activeModelRef: `${resolvedModel.providerName}/${resolvedModel.modelId}`,
      }),
    );
    // One somora-<name> proxy entry per external MCP server (design
    // §4.4) — same child binary in proxy mode, forwards to the hub.
    // tool_timeout_sec covers the per-server call budget + 2s forward
    // round-trip buffer.
    for (const srv of input.externalMcpServers ?? []) {
      args.push(
        ...somoraMcpProxyCodexFlags({
          server: srv.name,
          agent,
          toolTimeoutSec: Math.ceil(srv.timeoutMs / 1000) + 2,
        }),
      );
    }
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
    // Server-side tool-surface lock-down. These config keys kill codex-CLI
    // built-ins that aren't gated by the feature catalog above:
    //   web_search="disabled"   → hides `web.run` (hosted web-search tool).
    //                             Without this, the model sees web.run even
    //                             with browser_use* disabled.
    //   tools.view_image=false  → hides `functions.view_image`.
    // Other `functions.*` namespaces (apply_patch, update_plan,
    // request_user_input, list_mcp_resources) are server-injected by the
    // Responses API based on the codex-* model preset and cannot be
    // suppressed from the codex CLI side — issue openai/codex#6049.
    // somora-memory's web_search/file_patch/etc. are the intended path.
    args.push('-c', 'web_search="disabled"');
    args.push('-c', 'tools.view_image=false');
    // codex 0.144 re-audit (2026-07-21, hans's skill-discovery report):
    // codex 0.14x embeds "core skills" (imagegen, openai-docs,
    // plugin-creator, skill-creator, skill-installer) in the binary,
    // installs them into $CODEX_HOME/skills/.system and injects them
    // into every prompt — a skill surface separate from the feature
    // catalog above (hans saw the imagegen SKILL although the
    // image_generation FEATURE is disabled). Verified via `codex debug
    // prompt-input`: skills.bundled.enabled=false removes the whole
    // bundled set. include_instructions=false additionally drops the
    // skills-usage instruction block if anything is discovered anyway.
    // NB: user skills under $CODEX_HOME/skills/<name> have no global
    // off-switch (only per-skill [[skills.config]] entries) — somora
    // agents get their skills from somora's own registry, so keep
    // $CODEX_HOME/skills free of user skills on somora hosts.
    args.push('-c', 'skills.bundled.enabled=false');
    args.push('-c', 'skills.include_instructions=false');
    // Cross-engine thinking knob → codex's TOML override via shared helper.
    // Helper guards on 'reasoning' capability + maps 'off' → 'minimal'
    // (codex has no true off-switch for reasoning models).
    args.push(...codexCliReasoningArgs(thinking, resolvedModel.model));
    args.push('--json', '--skip-git-repo-check');
    // Sandbox policy: `--dangerously-bypass-approvals-and-sandbox` instead
    // of `--sandbox danger-full-access`. The scary name is the accurate one
    // for somora:
    //   - codex's own filesystem tools (shell_tool, unified_exec, apply_patch_*,
    //     edit_*) are ALL disabled via the --disable list above. codex has no
    //     way to touch the filesystem on its own.
    //   - the agent's actual write capability comes from somora's MCP tools
    //     (mcp__somora-memory__file_write/exec/file_patch/…) which live OUTSIDE
    //     codex's sandbox surface entirely. somora is the external sandbox —
    //     and that's precisely what the bypass flag is documented for:
    //     "intended solely for running in environments that are externally
    //     sandboxed" (`codex exec --help`).
    //   - codex injects a sandbox-info block into the model's system prompt
    //     based on the sandbox state. Earlier we used
    //     `--sandbox danger-full-access` on fresh exec only, relying on
    //     codex to inherit the policy on `exec resume`. That stopped working
    //     in codex 0.126+: resumed threads fall back to read-only in the
    //     prompt regardless of how the thread was created, so the model
    //     sees `sandbox_mode=read-only` and refuses legitimate writes via
    //     somora's MCP tools (hans 2026-05-12 report).
    //   - the bypass flag is a runtime-level option, accepted by both
    //     `codex exec` and `codex exec resume`, so it doesn't have the
    //     resume-vs-fresh asymmetry. It also bypasses approval prompts,
    //     which we don't use anyway (non-interactive exec would hang on
    //     them).
    args.push('--dangerously-bypass-approvals-and-sandbox');
    // Phase Y.B — image attachments. codex exec accepts repeated
    // `-i <PATH>` for both fresh and resumed sessions. Order vs the
    // other flags doesn't matter to codex's parser. PDF pages
    // already pre-rendered and surfaced as image paths by
    // buildCodexAttachments above.
    for (const p of imagePaths) args.push('-i', p);
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

    // User pressed ESC mid-turn → kill the codex subprocess. SIGTERM
    // first; codex normally exits cleanly on it. The exit handler then
    // resolves exitPromise and we fall through to the abort-aware
    // path in the catch/finally below.
    let abortFired = false;
    const onUpstreamAbort = () => {
      abortFired = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* already exited */
      }
    };
    if (signal) {
      if (signal.aborted) onUpstreamAbort();
      else signal.addEventListener('abort', onUpstreamAbort, { once: true });
    }

    let stderrBuf = '';
    // codex reports failures as JSON events on stdout, not on stderr —
    // see codex-events.ts. Without this, a 400 from the model endpoint
    // surfaced as "exit 1: " with nothing after the colon.
    const failure = new CodexFailureDetail();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    // Idle-event watchdog — symmetric to claude-cli. If codex stops
    // emitting JSON lines for the configured window we assume the child
    // is wedged (kernel pause, deadlocked threadpool, …) and SIGTERM it
    // so the upstream abort path takes over. Subprocess-death without
    // idle is already handled — child.on('exit') closes stdout which
    // ends the for-await loop, and the existing code !== 0 branch fires.
    // The watchdog catches the harder case: child alive, stdout silent.
    // Threshold from config.engineWatchdog.codexCliIdleMs (default 300s).
    const IDLE_TIMEOUT_MS = input.idleTimeoutMs ?? 300_000;
    // While a tool call is outstanding, codex's stdout legitimately goes
    // quiet for the tool's whole duration (the MCP tool runs out-of-band),
    // so relax the watchdog to the MCP tool timeout — a healthy long tool
    // (agent_ask, subagent_result wait_until_done) isn't cut off, while a
    // truly wedged subprocess is still caught at the tool-timeout horizon
    // (Juni-Audit 2026-06). max() so it never shortens the normal window.
    const TOOL_IDLE_TIMEOUT_MS = Math.max(input.toolIdleTimeoutMs ?? 0, IDLE_TIMEOUT_MS);
    let pendingToolCalls = 0;
    let watchdogFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const threshold = pendingToolCalls > 0 ? TOOL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
      idleTimer = setTimeout(() => {
        if (child.exitCode !== null) return; // already exited cleanly
        watchdogFired = true;
        logger.error({
          msg: 'engine.watchdog_idle_timeout',
          engine: ENGINE,
          agent,
          session,
          idleMs: threshold,
          pendingToolCalls,
          hint: 'no codex events received — likely subprocess wedged; SIGTERM + force-close stdout',
        });
        // SIGTERM first — gives the child a chance to flush + exit cleanly.
        try {
          child.kill('SIGTERM');
        } catch {
          /* already exited */
        }
        // Force-close stdout immediately so the for-await escapes even if
        // libuv hasn't picked up the child exit yet. Without this, a child
        // that's blocked in uninterruptible state (or whose SIGTERM
        // handler refuses to exit) leaves the parent stuck reading a
        // half-open pipe.
        try {
          child.stdout?.destroy(new Error('codex-cli watchdog: forced stdout close'));
        } catch {
          /* already destroyed */
        }
        // SIGKILL escalation after a short grace window — last resort
        // if the child ignored SIGTERM. Race-condition-safe: a child
        // that already exited cleanly returns false from kill().
        setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already exited */
            }
          }
        }, 2_000).unref();
      }, threshold);
    };
    const disarmIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    armIdleTimer();

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
          armIdleTimer();
          failure.observe(ev);

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
              // Tool now running out-of-band — relax the watchdog so a
              // legit long tool isn't killed mid-run (Juni-Audit 2026-06).
              pendingToolCalls++;
              armIdleTimer();
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
                // Concatenate, don't overwrite. Multi-block turns
                // (text-before-tool → mcp_tool_call → text-after-tool)
                // surface as multiple `agent_message` completion events;
                // a plain `cumulative = text` would clobber text-A with
                // text-B at the chat:final clamp, identical class of
                // bug to claude-cli pre-2026-05-12 (luca report).
                cumulative = cumulative ? `${cumulative}\n\n${text}` : text;
                finalText = cumulative;
                yield { kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: cumulative };
              }
            } else if (itemType === 'mcp_tool_call') {
              // Tool finished — drop back toward the normal idle threshold
              // once no tools are outstanding (re-armed at the next event).
              if (pendingToolCalls > 0) pendingToolCalls--;
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
              // Codex side-channel state (todo_list, hookPrompt, …) — emit
              // as engine_meta so it persists in JSONL for memory/REM-dream
              // and surfaces in the chat when the user has tools-visibility
              // on. Opaque payload — codex 0.131+ may ship new itemTypes
              // without parser churn. Info-log so the default config sees
              // these breadcrumbs without needing SOMORA_LOG_LEVEL=debug —
              // we want visibility into what codex is emitting, but not the
              // "alert" framing of the old `engine.unknown_item` warn.
              logger.info({
                msg: 'engine.meta_item',
                engine: ENGINE,
                itemType,
                itemKeys: Object.keys(item).slice(0, 16),
              });
              yield {
                kind: 'engine_meta',
                ts: ts(),
                engine: ENGINE,
                itemType,
                payload: item,
              };
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
      disarmIdleTimer();

      if (watchdogFired) {
        const message = `codex exec timed out (${IDLE_TIMEOUT_MS / 1000}s idle, exit ${code}): ${failure.render(stderrBuf, 300)}`;
        logger.error({
          msg: 'engine.fail',
          engine: ENGINE,
          agent,
          session,
          exitCode: code,
          stderr: stderrBuf.slice(0, 1000),
          streamErrors: failure.errors,
          err: 'idle watchdog timeout',
        });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
        return;
      }

      if (abortFired) {
        // ESC mid-turn — emit whatever streamed so far + marker, no error.
        logger.info({ msg: 'engine.aborted', engine: ENGINE, agent, session });
        const partial = cumulative
          ? `${cumulative}\n\n[somora] aborted by user`
          : '[somora] aborted by user';
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: partial };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
        return;
      }

      if (spawnError) {
        const message = `codex spawn failed: ${spawnError.message}`;
        logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: spawnError.message });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
        return;
      }

      if (code !== 0 && !receivedAnyEvent) {
        // Stale-thread recovery (Juni-Audit 2026-06): a dead
        // codexSessionId (rollout cleaned up, expired, CODEX_HOME
        // switch) used to brick the session — every turn retried the
        // same dead id until a manual /reset. Mirror claude-cli's
        // recovery: drop the stale thread pointer so the NEXT turn
        // starts a fresh thread. Also drop this engine's lastSeen so
        // that rebuild replays the full (compaction-aware) history —
        // a fresh thread with only the delta since codex last ran
        // would silently lose the older context.
        if (resumeId && CODEX_STALE_THREAD_RE.test(stderrBuf)) {
          try {
            await metaStore.update(agent, session, (freshMeta) => {
              const {
                codexSessionId: _dropThread,
                codexRecordedModel: _dropModel,
                ...rest
              } = freshMeta as CodexCliMeta;
              const lastSeen = { ...(rest.engineLastSeen ?? {}) };
              delete lastSeen[ENGINE];
              return { ...rest, engineLastSeen: lastSeen };
            });
            logger.info({
              msg: 'engine.session_resume_cleared',
              engine: ENGINE,
              agent,
              session,
              stale_id: resumeId,
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
          const message =
            'The Codex thread for this session no longer exists — it was discarded. ' +
            'The next message starts a fresh thread with the session history carried over.';
          yield { kind: 'error', ts: ts(), engine: ENGINE, message };
          yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
          return;
        }
        const message = `codex exec failed (exit ${code}): ${failure.render(stderrBuf)}`;
        logger.error({
          msg: 'engine.fail',
          engine: ENGINE,
          agent,
          session,
          model: resolvedModel.modelId,
          exitCode: code,
          stderr: stderrBuf.slice(0, 1000),
          streamErrors: failure.errors,
        });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
        return;
      }

      // Partial-event failure: codex emitted at least one event then exited
      // non-zero. We keep whatever streamed text we have (final assistant
      // message below) but loudly log a warning with the stderr tail so
      // ops can see WHY the turn ended badly. Luca's 2026-05-13 report —
      // pre-fix the only signal was `exitCode` on the engine.turn info log.
      if (code !== 0 && receivedAnyEvent) {
        logger.warn({
          msg: 'engine.degraded',
          engine: ENGINE,
          agent,
          session,
          exitCode: code,
          stderr: stderrBuf.slice(0, 1000),
          streamErrors: failure.errors,
          hint: 'codex exited non-zero after partial events; turn surfaced what streamed before the exit',
        });
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
        // Re-read meta from disk before merging — tools running in the
        // MCP child during this turn may have mutated session-scoped
        // fields (project_focus writes projectSlug + projectLinkedAt;
        // future tools may write others). The `meta` snapshot above is
        // from turn START and would clobber those mid-turn writes if
        // we spread it directly. Refs: naxon 2026-05-13 — project_focus
        // pin survived inside the turn, then vanished at turn end.
        // Atomic read-merge-write under the per-session lock so a
        // concurrent /sessions stats write or activity mark can't revert
        // codexSessionId, nor ours theirs (Juni-Audit 2026-06).
        await metaStore.update(agent, session, (freshMeta) => ({
          ...freshMeta,
          engine: ENGINE,
          codexSessionId: lastThreadId,
          // This turn ran under resolvedModel — the thread is now pinned
          // to it. Stamped every turn so the mismatch check above always
          // compares against the thread's true current model.
          codexRecordedModel: resolvedModel.modelId,
          engineLastSeen: withLastSeenTs(freshMeta, ENGINE, ts()),
        }));
      }
    } catch (err) {
      if (abortFired) {
        logger.info({ msg: 'engine.aborted', engine: ENGINE, agent, session });
        const partial = cumulative
          ? `${cumulative}\n\n[somora] aborted by user`
          : '[somora] aborted by user';
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: partial };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      } else if (watchdogFired) {
        // Stdout-destroy from the watchdog timer rejected the for-await.
        // Surface as the same canonical timeout message as the clean-exit
        // path so log forensics see one error class either way.
        logger.error({
          msg: 'engine.fail',
          engine: ENGINE,
          agent,
          session,
          err: 'idle watchdog timeout (forced stdout close)',
        });
        yield {
          kind: 'error',
          ts: ts(),
          engine: ENGINE,
          message: `codex exec timed out (${IDLE_TIMEOUT_MS / 1000}s idle, stdout force-closed): ${stderrBuf.slice(0, 300).trim()}`,
        };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      } else {
        logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: String(err) });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message: (err as Error).message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      }
    } finally {
      disarmIdleTimer();
      if (signal) signal.removeEventListener('abort', onUpstreamAbort);
    }
  },
};
