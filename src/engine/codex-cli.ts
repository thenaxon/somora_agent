// codex-cli engine — Codex app-server + dynamic tools.
//
// Design: private/codex-app-server-design.md (2026-09-05). Replaces the
// `codex exec --json` + MCP adapter in one step: Codex 0.153 runs the
// GPT-5.6 family and GPT-6 as code-mode-only and always defers MCP tools,
// which left the model guessing somora's tool names. Dynamic tools are
// first-class for Codex (per-tool deferral, namespaces, direct-only
// namespaces) — the path OpenClaw takes.
//
// Per turn:
//   1. sync auth into somora's CODEX_HOME, spawn `codex app-server`
//   2. thread/start (fresh) or thread/resume (stored thread id) with the
//      thread config overlay, developer instructions and the dynamic tool
//      catalog built from this turn's ToolInvoker
//   3. turn/start with the user text (+ localImage attachments), effort
//   4. notifications → somora events; item/tool/call → registry invoke
//   5. turn/completed → assistant_message + turn_end, meta write, SIGTERM
//
// Engine name stays 'codex-cli' so provider configs keep working.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ToolDefinition } from '../tools/types.ts';
import {
  computeReplayDelta,
  getLastSeenTs,
  renderReplayPrefix,
  withLastSeenTs,
  type EngineLastSeen,
  capReplayDelta,
} from './replay.ts';
import { withFromAgentHeader } from './a2a.ts';
import type { AgentEngine, TurnInput } from './types.ts';
import { buildCodexAttachments } from '../multimodal/user-content.ts';
import { codexReasoningEffort } from './thinking-params.ts';
import { CodexAppServerClient, CodexRpcError } from './codex-app-server-client.ts';
import { codexAppServerArgv, resolveCodexLaunch } from './codex-bin.ts';
import { codexChildEnv, somoraCodexHome, syncCodexAuth } from './codex-home.ts';
import {
  buildCodexToolCatalog,
  codexToolGuidance,
  DEFAULT_CODEX_DIRECT_TOOLS,
  toolResultToCodexResponse,
  type CodexToolCatalog,
} from './codex-dynamic-tools.ts';
import { buildCodexThreadConfig } from './codex-thread-config.ts';
import type { Compaction } from '../compaction/index.ts';

const ENGINE = 'codex-cli';

/** Tool name shape on somora events — matches the claude-cli MCP shape so
 *  the TUI/web formatters (which strip `mcp__somora__`) render both
 *  engines identically. */
const EVENT_TOOL_PREFIX = 'mcp__somora__';

interface CodexCliMeta {
  engine?: string;
  /** Codex thread id of this session. */
  codexSessionId?: string;
  /** Model the thread last ran under. A switch is passed to
   *  thread/resume as `model` (no rethread needed with the app-server)
   *  and surfaced as an engine_meta marker. */
  codexRecordedModel?: string;
  /** Obsolete (MCP-era rename tracking); tolerated on old sessions. */
  mcpServerName?: string;
  engineLastSeen?: EngineLastSeen;
  compactions?: Compaction[];
}

/** thread/resume errors that mean "this thread is gone" → fresh thread. */
const CODEX_STALE_THREAD_RE = /no rollout found|not found|does not exist|failed to load|no such thread/i;

interface UsageAcc {
  tokens_in: number;
  tokens_in_cached: number;
  tokens_out: number;
  tokens_out_reasoning: number;
  seen: boolean;
}

/** Config bridged through process.env by applyCodexCliEnv (config.yaml
 *  codexCli.*), so the engine stays free of the Config type. */
function codexDirectTools(): readonly string[] {
  const raw = process.env.SOMORA_CODEX_DIRECT_TOOLS;
  if (!raw) return DEFAULT_CODEX_DIRECT_TOOLS;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
  } catch {
    /* fall through */
  }
  return DEFAULT_CODEX_DIRECT_TOOLS;
}

function codexToolTimeoutMs(): number {
  const raw = Number(process.env.SOMORA_CODEX_TOOL_TIMEOUT_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 1800_000;
}

/** Ordered text segments keyed by Codex item id (agentMessage /
 *  reasoning items stream deltas, then complete with the full text). */
class SegmentBuffer {
  private readonly order: string[] = [];
  private readonly text = new Map<string, string>();

  append(itemId: string, delta: string): void {
    if (!this.text.has(itemId)) {
      this.order.push(itemId);
      this.text.set(itemId, '');
    }
    this.text.set(itemId, `${this.text.get(itemId) ?? ''}${delta}`);
  }

  set(itemId: string, full: string): void {
    if (!this.text.has(itemId)) this.order.push(itemId);
    this.text.set(itemId, full);
  }

  has(itemId: string): boolean {
    return this.text.has(itemId);
  }

  get cumulative(): string {
    return this.order
      .map((id) => (this.text.get(id) ?? '').trim())
      .filter((t) => t.length > 0)
      .join('\n\n');
  }
}

/** Push-based event queue consumed by the async generator. */
class EventQueue {
  private readonly items: NormalizedEvent[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(ev: NormalizedEvent): void {
    this.items.push(ev);
    this.wake?.();
  }

  finish(): void {
    this.done = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<NormalizedEvent> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
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
    const logCtx = { engine: ENGINE, agent, session };
    const ts = () => Date.now();
    const turnId = `t-${Date.now()}`;
    const meta = (await metaStore.get(agent, session)) as CodexCliMeta;

    let resumeId = meta.codexSessionId;
    const modelSwitched =
      resumeId && meta.codexRecordedModel && meta.codexRecordedModel !== resolvedModel.modelId
        ? { from: meta.codexRecordedModel, to: resolvedModel.modelId }
        : undefined;

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };
    if (modelSwitched) {
      logger.info({ msg: 'engine.model_switch', ...logCtx, ...modelSwitched, threadId: resumeId });
      yield {
        kind: 'engine_meta',
        ts: ts(),
        engine: ENGINE,
        itemType: 'model_switch',
        payload: {
          from: modelSwitched.from,
          to: modelSwitched.to,
          text: `Codex thread continues under ${modelSwitched.to} (was ${modelSwitched.from}).`,
        },
      };
    }

    // ---- tool catalog + developer instructions -------------------------
    const toolDefs: readonly ToolDefinition[] = input.tools?.list() ?? [];
    const catalog: CodexToolCatalog = buildCodexToolCatalog(toolDefs, codexDirectTools());
    if (catalog.skipped.length > 0) {
      logger.warn({ msg: 'engine.codex_tools_skipped', ...logCtx, skipped: catalog.skipped });
    }
    const developerInstructions = `${systemPrompt}\n\n---\n\n${codexToolGuidance(catalog)}`;
    const threadConfig = buildCodexThreadConfig({
      shellEnvironmentPolicy: process.env.SOMORA_CODEX_SHELL_ENV_POLICY,
      directOnlyNamespaces: catalog.directOnlyNamespaces,
    });

    // ---- turn input -----------------------------------------------------
    const { imagePaths, promptPrefix: attachmentPrefix } = await buildCodexAttachments(
      input.attachments ?? [],
    );
    const taggedUserMessage = withFromAgentHeader(userMessage, fromAgent);
    const ephemeralBlock = ephemeralContext ? `${ephemeralContext}\n\n---\n\n` : '';
    const buildText = (resumed: boolean, replayPrefix: string): string => {
      const projectBlock = resumed && projectContext ? `${projectContext}\n\n---\n\n` : '';
      return `${attachmentPrefix}${ephemeralBlock}${projectBlock}${replayPrefix}${taggedUserMessage}`;
    };
    const effort = codexReasoningEffort(thinking, resolvedModel.model);
    const summary = input.captureThinking === false ? 'none' : 'auto';

    // ---- process ----------------------------------------------------------
    const auth = syncCodexAuth();
    if (!auth.somoraExists) {
      logger.warn({
        msg: 'engine.codex_auth_missing',
        ...logCtx,
        userAuthPath: auth.userAuthPath,
        hint: 'run `somora codex login` (or `codex login`) — the turn will fail on authentication',
      });
    }
    const workspace = join(somoraCodexHome(), 'workspace');
    mkdirSync(workspace, { recursive: true });
    const launch = resolveCodexLaunch();

    const queue = new EventQueue();
    const assistant = new SegmentBuffer();
    const reasoning = new SegmentBuffer();
    const usage: UsageAcc = {
      tokens_in: 0,
      tokens_in_cached: 0,
      tokens_out: 0,
      tokens_out_reasoning: 0,
      seen: false,
    };
    const streamErrors: string[] = [];
    let threadId: string | undefined = resumeId;
    let activeTurnId: string | undefined;
    let turnOutcome: { status: string; error?: string } | undefined;
    let pendingToolCalls = 0;
    let abortFired = false;
    let watchdogFired = false;
    let finished = false;
    let client: CodexAppServerClient | undefined;

    const IDLE_TIMEOUT_MS = input.idleTimeoutMs ?? 300_000;
    const TOOL_IDLE_TIMEOUT_MS = Math.max(input.toolIdleTimeoutMs ?? 0, IDLE_TIMEOUT_MS);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      queue.finish();
    };
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      const threshold = pendingToolCalls > 0 ? TOOL_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
      idleTimer = setTimeout(() => {
        if (finished) return;
        watchdogFired = true;
        logger.error({
          msg: 'engine.watchdog_idle_timeout',
          ...logCtx,
          idleMs: threshold,
          pendingToolCalls,
          hint: 'no app-server notification received — process wedged; SIGTERM',
        });
        client?.close();
        finish();
      }, threshold);
    };

    const onAbort = (): void => {
      if (abortFired) return;
      abortFired = true;
      logger.info({ msg: 'engine.abort_requested', ...logCtx, threadId, turnId: activeTurnId });
      if (client && threadId && activeTurnId) {
        client
          .request('turn/interrupt', { threadId, turnId: activeTurnId }, { timeoutMs: 2_000 })
          .catch(() => {});
        setTimeout(() => {
          if (!finished) {
            client?.close();
            finish();
          }
        }, 2_500).unref();
      } else {
        client?.close();
        finish();
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // ---- notifications ----------------------------------------------------
    const onNotification = (method: string, rawParams: unknown): void => {
      if (finished) return;
      armIdleTimer();
      const p = (rawParams ?? {}) as Record<string, unknown>;
      switch (method) {
        case 'thread/started': {
          const t = p.thread as { id?: unknown } | undefined;
          if (typeof t?.id === 'string') threadId = t.id;
          break;
        }
        case 'turn/started': {
          const t = p.turn as { id?: unknown } | undefined;
          if (typeof t?.id === 'string') activeTurnId = t.id;
          break;
        }
        case 'item/agentMessage/delta': {
          if (typeof p.itemId === 'string' && typeof p.delta === 'string') {
            assistant.append(p.itemId, p.delta);
            queue.push({ kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: assistant.cumulative });
          }
          break;
        }
        case 'item/reasoning/summaryPartAdded': {
          if (typeof p.itemId === 'string' && reasoning.has(p.itemId)) reasoning.append(p.itemId, '\n\n');
          break;
        }
        case 'item/reasoning/summaryTextDelta': {
          if (typeof p.itemId === 'string' && typeof p.delta === 'string') {
            reasoning.append(p.itemId, p.delta);
            queue.push({ kind: 'thinking_delta', ts: ts(), engine: ENGINE, text: reasoning.cumulative });
          }
          break;
        }
        case 'item/started':
        case 'item/completed': {
          const item = p.item as Record<string, unknown> | undefined;
          if (!item || typeof item !== 'object') break;
          const type = typeof item.type === 'string' ? item.type : 'unknown';
          const itemId = typeof item.id === 'string' ? item.id : `item-${Date.now()}`;
          if (method === 'item/started') {
            if (type === 'agentMessage') assistant.set(itemId, '');
            break;
          }
          if (type === 'agentMessage') {
            if (typeof item.text === 'string') assistant.set(itemId, item.text);
          } else if (type === 'reasoning') {
            const parts = Array.isArray(item.summary)
              ? item.summary.filter((s): s is string => typeof s === 'string')
              : [];
            if (parts.length > 0) reasoning.set(itemId, parts.join('\n\n'));
          } else if (type === 'userMessage' || type === 'dynamicToolCall') {
            // dynamicToolCall is surfaced from the item/tool/call request.
          } else {
            // mcpToolCall / commandExecution / fileChange / collab… should not
            // happen with the lock-down; persist as breadcrumb.
            logger.info({ msg: 'engine.meta_item', ...logCtx, itemType: type });
            queue.push({ kind: 'engine_meta', ts: ts(), engine: ENGINE, itemType: type, payload: item });
          }
          break;
        }
        case 'thread/tokenUsage/updated': {
          const tu = p.tokenUsage as { last?: Record<string, unknown> } | undefined;
          const last = tu?.last;
          if (last) {
            const n = (k: string) => (typeof last[k] === 'number' ? (last[k] as number) : 0);
            usage.tokens_in += n('inputTokens');
            usage.tokens_in_cached += n('cachedInputTokens');
            usage.tokens_out += n('outputTokens');
            usage.tokens_out_reasoning += n('reasoningOutputTokens');
            usage.seen = true;
          }
          break;
        }
        case 'error': {
          const message = typeof p.message === 'string' ? p.message : JSON.stringify(p).slice(0, 500);
          streamErrors.push(message);
          logger.warn({ msg: 'engine.codex_error_item', ...logCtx, message: message.slice(0, 500) });
          queue.push({
            kind: 'engine_meta',
            ts: ts(),
            engine: ENGINE,
            itemType: 'error',
            payload: { message },
          });
          break;
        }
        case 'warning':
        case 'configWarning':
        case 'deprecationNotice': {
          const text = String(p.message ?? p.summary ?? '');
          // Sandbox prerequisites are irrelevant: threads run with
          // danger-full-access (somora is the sandbox). Keep the log clean.
          if (/bubblewrap|sandbox prerequisites/i.test(text)) {
            logger.debug({ msg: 'engine.codex_warning', ...logCtx, method, message: text.slice(0, 200) });
            break;
          }
          logger.warn({
            msg: 'engine.codex_warning',
            ...logCtx,
            method,
            message: String(p.message ?? p.summary ?? '').slice(0, 400),
          });
          break;
        }
        case 'turn/completed': {
          const turn = p.turn as { status?: unknown; error?: { message?: unknown } | null } | undefined;
          turnOutcome = {
            status: typeof turn?.status === 'string' ? turn.status : 'unknown',
            ...(turn?.error && typeof turn.error.message === 'string' ? { error: turn.error.message } : {}),
          };
          finish();
          break;
        }
        default:
          logger.debug({ msg: 'engine.codex_notification', ...logCtx, method });
      }
    };

    // ---- server → client requests (tools, approvals) ----------------------
    const toolTimeoutMs = codexToolTimeoutMs();
    const onServerRequest = async (req: { method: string; params: unknown }): Promise<unknown> => {
      if (req.method === 'item/tool/call') {
        const params = (req.params ?? {}) as {
          callId?: unknown;
          namespace?: unknown;
          tool?: unknown;
          arguments?: unknown;
        };
        const callId = typeof params.callId === 'string' ? params.callId : `call-${Date.now()}`;
        const nsRaw = typeof params.namespace === 'string' ? params.namespace : null;
        const toolRaw = typeof params.tool === 'string' ? params.tool : '';
        const registryName = catalog.resolve(nsRaw, toolRaw);
        const args = params.arguments ?? {};
        queue.push({
          kind: 'tool_call',
          ts: ts(),
          engine: ENGINE,
          callId,
          tool: `${EVENT_TOOL_PREFIX}${registryName ?? toolRaw}`,
          input: args,
        });
        if (!registryName || !input.tools) {
          const error = `unknown tool '${nsRaw ? `${nsRaw}.` : ''}${toolRaw}'`;
          queue.push({ kind: 'tool_result', ts: ts(), engine: ENGINE, callId, output: null, error });
          return toolResultToCodexResponse({ ok: false, error });
        }
        pendingToolCalls++;
        armIdleTimer();
        const started = Date.now();
        let result;
        try {
          result = await Promise.race([
            input.tools.invoke(registryName, args),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`tool '${registryName}' timed out after ${toolTimeoutMs / 1000}s`)),
                toolTimeoutMs,
              ).unref(),
            ),
          ]);
        } catch (err) {
          result = { ok: false, error: (err as Error).message };
        } finally {
          if (pendingToolCalls > 0) pendingToolCalls--;
          armIdleTimer();
        }
        logger.info({
          msg: 'engine.tool_call',
          ...logCtx,
          tool: registryName,
          ok: result.ok,
          ms: Date.now() - started,
        });
        queue.push({
          kind: 'tool_result',
          ts: ts(),
          engine: ENGINE,
          callId,
          output: result.ok ? (result.data ?? null) : null,
          ...(result.ok ? {} : { error: result.error ?? 'tool failed' }),
        });
        return toolResultToCodexResponse(result);
      }
      if (req.method === 'item/tool/requestUserInput') return { answers: {} };
      if (req.method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
      if (req.method.endsWith('/requestApproval') || req.method === 'execCommandApproval' || req.method === 'applyPatchApproval') {
        logger.warn({ msg: 'engine.codex_unexpected_approval', ...logCtx, method: req.method });
        return { decision: 'decline' };
      }
      logger.warn({ msg: 'engine.codex_unhandled_request', ...logCtx, method: req.method });
      return {};
    };

    // ---- drive the turn (runs concurrently with draining the queue) ------
    const drive = async (): Promise<void> => {
      try {
        client = await CodexAppServerClient.start({
          command: launch.command,
          args: codexAppServerArgv(launch),
          env: codexChildEnv(),
          cwd: workspace,
          onNotification,
          onServerRequest,
          logCtx,
        });
        void client.exited().then(({ code, signal: sig }) => {
          if (!finished) {
            logger.error({
              msg: 'engine.codex_app_server_exited_early',
              ...logCtx,
              code,
              signal: sig,
              stderr: client?.stderrTail.slice(-600),
            });
            streamErrors.push(
              `codex app-server exited (code ${code}, signal ${sig ?? 'none'})${client?.stderrTail.trim() ? `: ${client.stderrTail.trim().slice(-400)}` : ''}`,
            );
            finish();
          }
        });
        armIdleTimer();
        if (abortFired) return;

        const baseThreadParams = {
          model: resolvedModel.modelId,
          cwd: workspace,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          config: threadConfig,
          developerInstructions,
          personality: 'none',
          dynamicTools: catalog.specs,
        };
        let resumed = false;
        if (resumeId) {
          try {
            const r = (await client.request(
              'thread/resume',
              { threadId: resumeId, excludeTurns: true, ...baseThreadParams },
              { timeoutMs: 60_000 },
            )) as { thread?: { id?: string } };
            threadId = r.thread?.id ?? resumeId;
            resumed = true;
          } catch (err) {
            const message = (err as Error).message;
            if (err instanceof CodexRpcError && CODEX_STALE_THREAD_RE.test(message)) {
              logger.warn({
                msg: 'engine.session_resume_cleared',
                ...logCtx,
                stale_id: resumeId,
                err: message.slice(0, 300),
                hint: 'thread gone — starting a fresh thread with the session history replayed',
              });
              queue.push({
                kind: 'engine_meta',
                ts: ts(),
                engine: ENGINE,
                itemType: 'thread_recreated',
                payload: {
                  from: resumeId,
                  text: 'The Codex thread for this session no longer existed — a fresh thread was started with the session history carried over.',
                },
              });
              resumeId = undefined;
              threadId = undefined;
            } else {
              throw err;
            }
          }
        }
        if (!resumed) {
          const r = (await client.request(
            'thread/start',
            { ...baseThreadParams, serviceName: 'somora' },
            { timeoutMs: 60_000 },
          )) as { thread?: { id?: string } };
          threadId = r.thread?.id;
        }
        if (abortFired) return;

        const lastSeenTs = resumed ? getLastSeenTs(meta, ENGINE) : 0;
        const rawDelta = computeReplayDelta(history, lastSeenTs, meta.compactions);
        const replayDelta = resumed ? rawDelta : capReplayDelta(rawDelta);
        const replayPrefix = renderReplayPrefix(replayDelta);
        logger.info({
          msg: 'engine.init',
          ...logCtx,
          provider: resolvedModel.providerName,
          model: resolvedModel.modelId,
          bin: launch.source === 'bundled' ? `bundled ${launch.version ?? '?'}` : launch.command,
          resumed,
          threadId,
          lastSeenTs,
          replayPairs: replayDelta.pairs.length,
          replaySummary: Boolean(replayDelta.summary),
          directTools: catalog.directNames.length,
          deferredTools: catalog.deferredNames.length,
          images: imagePaths.length,
          effort: effort ?? null,
        });

        const inputItems: Array<Record<string, unknown>> = [
          { type: 'text', text: buildText(resumed, replayPrefix), text_elements: [] },
          ...imagePaths.map((path) => ({ type: 'localImage', path })),
        ];
        const t = (await client.request(
          'turn/start',
          {
            threadId,
            input: inputItems,
            ...(effort ? { effort } : {}),
            summary,
          },
          { timeoutMs: 60_000 },
        )) as { turn?: { id?: string } };
        if (typeof t.turn?.id === 'string') activeTurnId = t.turn.id;
      } catch (err) {
        if (!finished) {
          streamErrors.push((err as Error).message);
          logger.error({ msg: 'engine.fail', ...logCtx, err: (err as Error).message });
          finish();
        }
      }
    };
    void drive();

    // ---- emit -------------------------------------------------------------
    try {
      for await (const ev of queue.drain()) yield ev;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (idleTimer) clearTimeout(idleTimer);
    }
    client?.close();

    const finalText = assistant.cumulative;
    const thinkingText = reasoning.cumulative;
    const usageOut = usage.seen
      ? {
          usage: {
            tokens_in: usage.tokens_in,
            tokens_out: usage.tokens_out,
            tokens_in_cached: usage.tokens_in_cached,
            tokens_out_reasoning: usage.tokens_out_reasoning,
          },
        }
      : {};

    const emitFinal = function* (): Generator<NormalizedEvent> {
      if (thinkingText) yield { kind: 'thinking_message', ts: ts(), engine: ENGINE, text: thinkingText };
    };

    if (watchdogFired) {
      const message = `codex app-server timed out (${IDLE_TIMEOUT_MS / 1000}s idle)${streamErrors.length ? `: ${streamErrors.join('; ').slice(0, 400)}` : ''}`;
      yield { kind: 'error', ts: ts(), engine: ENGINE, message };
      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId, ...usageOut };
      await persistMeta();
      return;
    }
    if (abortFired) {
      logger.info({ msg: 'engine.aborted', ...logCtx });
      const partial = finalText ? `${finalText}\n\n[somora] aborted by user` : '[somora] aborted by user';
      yield* emitFinal();
      yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: partial };
      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId, ...usageOut };
      await persistMeta();
      return;
    }
    if (!turnOutcome || turnOutcome.status !== 'completed') {
      const reason =
        turnOutcome?.error ??
        (streamErrors.length > 0 ? streamErrors.join('; ') : `turn ended with status ${turnOutcome?.status ?? 'unknown'}`);
      logger.error({
        msg: 'engine.fail',
        ...logCtx,
        model: resolvedModel.modelId,
        status: turnOutcome?.status,
        err: reason.slice(0, 1000),
        streamErrors,
      });
      if (finalText) {
        yield* emitFinal();
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: finalText };
      }
      yield { kind: 'error', ts: ts(), engine: ENGINE, message: `codex turn failed: ${reason}` };
      yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId, ...usageOut };
      await persistMeta();
      return;
    }

    if (finalText) {
      yield* emitFinal();
      yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: finalText };
    }
    logger.info({
      msg: 'engine.turn',
      ...logCtx,
      provider: resolvedModel.providerName,
      model: resolvedModel.modelId,
      tokens_in: usage.tokens_in,
      tokens_in_cached: usage.tokens_in_cached,
      tokens_out: usage.tokens_out,
      tokens_out_reasoning: usage.tokens_out_reasoning,
      threadId,
      finalTextLen: finalText.length,
    });
    yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId, ...usageOut };
    await persistMeta();

    async function persistMeta(): Promise<void> {
      if (!threadId) return;
      const id = threadId;
      try {
        await metaStore.update(agent, session, (freshMeta) => {
          const { mcpServerName: _drop, ...rest } = freshMeta as CodexCliMeta;
          return {
            ...rest,
            engine: ENGINE,
            codexSessionId: id,
            codexRecordedModel: resolvedModel.modelId,
            engineLastSeen: withLastSeenTs(freshMeta, ENGINE, ts()),
          };
        });
      } catch (err) {
        logger.warn({ msg: 'engine.meta_write_failed', ...logCtx, err: String(err) });
      }
    }
  },
};
