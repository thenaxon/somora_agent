// grok-cli engine adapter — drives xAI's Grok Build CLI over ACP
// (Agent Client Protocol: JSON-RPC 2.0, newline-delimited, on stdio).
//
// Why ACP and not the public xAI API: a SuperGrok/Premium subscription
// authenticates the *binary*, not the API. `grok login` writes a session
// to ~/.grok/auth.json, and the ACP handshake reports it as the
// `cached_token` auth method — used automatically, no explicit
// `authenticate` round-trip needed. Talking to api.x.ai instead would
// bill pay-per-token against a separate xAI API account.
//
// Process model: one `grok agent stdio` child per turn, mirroring
// codex-cli. The child is cheap to start (~1s to handshake) and dying
// with the turn means no long-lived state to leak or reconcile. Session
// continuity comes from `session/load` against the persisted
// grokSessionId, which the ACP handshake advertises via
// agentCapabilities.loadSession.
//
// Wire shapes below are transcribed from a recorded probe against
// grok 0.2.106 — see the `session/update` variants in mapUpdate().

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MCP_SERVER_NAME, somoraMemoryServerSpawn } from '../mcp/config.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { withFromAgentHeader } from './a2a.ts';
import { grokCliReasoningArgs } from './thinking-params.ts';
import type { AgentEngine, ResolvedAttachment, TurnInput } from './types.ts';

const ENGINE = 'grok-cli';

/** Fallback idle window when the server doesn't resolve one. */
const DEFAULT_IDLE_MS = 300_000;

/** Handshake must complete inside this or the binary is considered broken. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

function resolveGrokBin(): string {
  if (process.env.SOMORA_GROK_BIN) return process.env.SOMORA_GROK_BIN;
  const localBin = join(homedir(), '.local', 'bin', 'grok');
  if (existsSync(localBin)) return localBin;
  return 'grok';
}

const GROK_BIN = resolveGrokBin();

// ---------------------------------------------------------------------
// ACP wire types (only the fields we consume)
// ---------------------------------------------------------------------

interface JsonRpcFrame {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface AcpContent {
  type: string;
  text?: string;
}

interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: AcpContent;
  // tool_call / tool_call_update
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content_?: unknown;
}

interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
}

/**
 * ACP stdio MCP-server descriptor. Note the env shape: ACP takes an
 * ARRAY of {name, value} pairs, not the {KEY: value} record that
 * somoraMemoryServerSpawn() (and every other engine) hands out. That
 * mismatch is the whole reason this helper exists.
 */
interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/**
 * Build the ACP `mcpServers` entry that gives a grok session somora's
 * own tool surface (memory, files, exec, wiki, subagents — 45 tools as
 * of 2026-07).
 *
 * Grok spawns the child itself and, per the probe on 2026-07-20,
 * exposes the tools to the model behind a search_tool/use_tool
 * indirection rather than listing all 45 up front — so a large surface
 * costs little context.
 *
 * Tool naming: grok presents them as `<server>__<tool>`
 * (`somora-memory__time_now`), NOT with somora's own `mcp__` prefix.
 * See stripToolPrefix() for the normalisation applied before events
 * reach the rest of somora.
 */
function buildMcpServers(args: {
  agent: string;
  session: string;
  subagentDepth?: number;
  activeModelRef?: string;
}): AcpMcpServer[] {
  const spawnCfg = somoraMemoryServerSpawn({
    agent: args.agent,
    session: args.session,
    subagentDepth: args.subagentDepth,
    activeModelRef: args.activeModelRef,
  });
  return [
    {
      name: MCP_SERVER_NAME,
      command: spawnCfg.command,
      args: spawnCfg.args,
      env: Object.entries(spawnCfg.env).map(([name, value]) => ({ name, value })),
    },
  ];
}

/**
 * Resolve what somora should record as "the tool that ran", and
 * normalise it to somora's `mcp__<server>__<tool>` convention.
 *
 * Grok doesn't call MCP tools directly. It funnels them through a
 * two-step indirection — `search_tool` to discover, then `use_tool`
 * with the real name in `rawInput.tool_name`. That keeps a 45-tool
 * surface out of the model's context, but it means the ACP frame's
 * title is the literal string "use_tool" for every single call.
 * Recording that verbatim would make session logs useless: every tool
 * row would read "use_tool" with no indication of what actually ran.
 *
 * So: unwrap use_tool to the inner name, then prefix.
 *
 *   use_tool{tool_name:'somora-memory__time_now'}
 *                                → mcp__somora-memory__time_now
 *   somora-memory__memory_list   → mcp__somora-memory__memory_list
 *   mcp__somora-memory__time_now → unchanged (already normalised)
 *   search_tool, read_file       → unchanged (grok's own built-ins)
 */
function resolveToolName(rawTitle: string, rawInput: unknown): string {
  let name = rawTitle;

  if (name === 'use_tool' && rawInput && typeof rawInput === 'object') {
    const inner = (rawInput as { tool_name?: unknown }).tool_name;
    if (typeof inner === 'string' && inner.length > 0) {
      name = inner;
    }
  }

  if (name.startsWith(`${MCP_SERVER_NAME}__`)) {
    return `mcp__${name}`;
  }
  return name;
}

/**
 * Fold user attachments into the prompt.
 *
 * Division of labour: images and PDFs never reach this adapter at all.
 * run-turn.ts applies a capability gate first and hard-refuses them
 * for any model without the `image` / `pdf` capability — grok-4.5 has
 * neither, so the user gets "does not support image inputs" before an
 * engine is even spawned.
 *
 * What DOES arrive here is text, which the gate lets through. Grok
 * Build has no attachment channel over ACP, so the only way to deliver
 * a text file is to inline it — same approach codex-cli takes for its
 * non-image attachments.
 *
 * Anything else reaching this function means the gate let a kind
 * through that we can't render. That should not happen, but saying so
 * beats dropping the file silently, so it becomes a note to the model.
 */
function renderAttachments(attachments: ResolvedAttachment[]): string {
  const parts: string[] = [];
  const undeliverable: ResolvedAttachment[] = [];

  for (const a of attachments) {
    if (a.mime.kind === 'text') {
      try {
        parts.push(`[Attached ${a.name}]\n\n${readFileSync(a.path, 'utf8')}\n[/Attached]`);
      } catch (err) {
        logger.warn(
          { engine: ENGINE, name: a.name, err: (err as Error).message },
          'attachment unreadable',
        );
        undeliverable.push(a);
      }
    } else {
      undeliverable.push(a);
    }
  }

  if (undeliverable.length > 0) {
    parts.push(
      [
        `[somora] ${undeliverable.length} attachment(s) could not be delivered to this model:`,
        ...undeliverable.map((a) => `  - ${a.name} (${a.mime.kind}, ${a.size} bytes)`),
        '',
        'The content was NOT transmitted — you cannot see it. Do not guess',
        'at what it contains. Tell the user plainly, and suggest a model',
        'that supports this attachment kind.',
      ].join('\n'),
    );
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------
// Minimal ACP client over a spawned child
// ---------------------------------------------------------------------

type Notification = { method: string; params: Record<string, unknown> };

class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, (f: JsonRpcFrame) => void>();
  /** Notifications + server->client requests, drained by the turn loop. */
  private queue: Notification[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  private exitInfo: string | null = null;

  constructor(args: string[], cwd: string) {
    this.child = spawn(GROK_BIN, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (c: Buffer) => this.onData(c));
    this.child.stderr.on('data', (c: Buffer) => {
      const s = c.toString().trim();
      if (s) logger.debug({ engine: ENGINE, stderr: s }, 'grok stderr');
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.exitInfo = `grok exited (code=${code} signal=${signal})`;
      // Unblock anyone waiting so they see the closed state.
      for (const [, res] of this.pending) {
        res({ jsonrpc: '2.0', error: { code: -1, message: this.exitInfo } });
      }
      this.pending.clear();
      this.wake();
    });
    this.child.on('error', (err) => {
      this.closed = true;
      this.exitInfo = `grok spawn failed: ${err.message}`;
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let frame: JsonRpcFrame;
      try {
        frame = JSON.parse(line) as JsonRpcFrame;
      } catch {
        logger.debug({ engine: ENGINE, line: line.slice(0, 200) }, 'unparseable ACP frame');
        continue;
      }
      if (frame.id !== undefined && frame.method === undefined) {
        const res = this.pending.get(frame.id as number);
        if (res) {
          this.pending.delete(frame.id as number);
          res(frame);
        }
        continue;
      }
      if (frame.method) {
        this.queue.push({
          method: frame.method,
          params: (frame.params ?? {}) as Record<string, unknown>,
        });
        // Server->client REQUEST (has an id): must be answered or the
        // agent blocks forever. The only one grok issues in practice is
        // session/request_permission; we run with --always-approve so it
        // shouldn't fire, but answer defensively rather than deadlock.
        if (frame.id !== undefined) {
          this.respond(frame.id, {
            outcome: { outcome: 'selected', optionId: 'allow' },
          });
        }
        this.wake();
      }
    }
  }

  private write(obj: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      logger.warn({ engine: ENGINE, err }, 'ACP stdin write failed');
    }
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcFrame> {
    if (this.closed) {
      return Promise.resolve({
        jsonrpc: '2.0',
        error: { code: -1, message: this.exitInfo ?? 'grok not running' },
      });
    }
    const id = this.nextId++;
    return new Promise<JsonRpcFrame>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          jsonrpc: '2.0',
          error: { code: -2, message: `ACP ${method} timed out after ${timeoutMs}ms` },
        });
      }, timeoutMs);
      this.pending.set(id, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Drain buffered notifications, waiting up to idleMs for the next one.
   * Returns null when the window elapses with nothing arriving (caller
   * treats that as a watchdog trip) or when the child is gone and the
   * buffer is empty.
   */
  async next(idleMs: number): Promise<Notification | null> {
    if (this.queue.length > 0) return this.queue.shift() ?? null;
    if (this.closed) return null;
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        this.waiter = null;
        resolve();
      }, idleMs);
      this.waiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    if (this.queue.length > 0) return this.queue.shift() ?? null;
    if (timedOut) return null;
    return this.closed ? null : this.next(idleMs);
  }

  /**
   * Discard every buffered notification. Called after session/load:
   * ACP replays the entire prior conversation as session/update frames
   * so a fresh client can rebuild its view. We already have that
   * history in somora's own JSONL, and folding the replayed
   * agent_message_chunks into the current turn's text would echo the
   * whole session back at the user (observed: turn 2 answering
   * "pongpong" instead of "pong").
   */
  drain(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    return n;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get lastError(): string | null {
    return this.exitInfo;
  }

  kill(): void {
    if (!this.closed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

// ---------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------

export const grokCliEngine: AgentEngine = {
  name: ENGINE,

  async *runTurn(input: TurnInput): AsyncIterable<NormalizedEvent> {
    const turnId = randomUUID();
    const idleMs = input.idleTimeoutMs ?? DEFAULT_IDLE_MS;
    const toolIdleMs = input.toolIdleTimeoutMs ?? idleMs;

    yield { kind: 'turn_start', ts: Date.now(), engine: ENGINE, turnId };

    const meta = await input.metaStore.get(input.agent, input.session);
    const priorSessionId =
      typeof meta.grokSessionId === 'string' ? meta.grokSessionId : null;

    // cwd: the agent's workspace is what grok's built-in file/shell
    // tools operate on. Falls back to $HOME rather than somora's own
    // process cwd, which would point the agent at the install dir.
    const cwd = process.env.SOMORA_WORKSPACE ?? homedir();

    const args = [
      'agent',
      '--always-approve',
      ...(input.resolvedModel.modelId ? ['-m', input.resolvedModel.modelId] : []),
      ...grokCliReasoningArgs(input.thinking, input.resolvedModel.model),
      'stdio',
    ];

    const client = new AcpClient(args, cwd);
    const onAbort = () => client.kill();
    input.signal?.addEventListener('abort', onAbort, { once: true });

    let assistantText = '';
    let emittedAny = false;
    const openTools = new Set<string>();

    try {
      // --- handshake -------------------------------------------------
      const init = await client.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        HANDSHAKE_TIMEOUT_MS,
      );
      if (init.error) {
        yield {
          kind: 'error',
          ts: Date.now(),
          engine: ENGINE,
          message: `grok handshake failed: ${init.error.message}. Is \`grok\` installed and has \`grok login\` been run?`,
        };
        yield { kind: 'turn_end', ts: Date.now(), engine: ENGINE, turnId };
        return;
      }

      // --- session: load prior, else create --------------------------
      // somora's own MCP surface, spawned by grok as a child of the ACP
      // agent. Scoped to this agent+session so memory tools hit the
      // right inbox and spawn_subagent records the correct parent.
      const mcpServers = buildMcpServers({
        agent: input.agent,
        session: input.session,
        subagentDepth: input.subagentDepth,
        activeModelRef: `${input.resolvedModel.providerName}/${input.resolvedModel.modelId}`,
      });

      let sessionId: string | null = null;
      if (priorSessionId) {
        const loaded = await client.request(
          'session/load',
          { sessionId: priorSessionId, cwd, mcpServers },
          HANDSHAKE_TIMEOUT_MS,
        );
        if (!loaded.error) {
          sessionId = priorSessionId;
        } else {
          logger.info(
            { engine: ENGINE, priorSessionId, err: loaded.error.message },
            'grok session/load failed — starting fresh',
          );
        }
      }
      if (!sessionId) {
        const created = await client.request(
          'session/new',
          { cwd, mcpServers },
          // MCP child startup (tsx + the somora server) adds a few
          // seconds on top of the bare handshake — measured ~3.5s on
          // 2026-07-20. Give session/new its own, longer budget.
          HANDSHAKE_TIMEOUT_MS * 2,
        );
        const sid = (created.result as { sessionId?: string } | undefined)?.sessionId;
        if (created.error || !sid) {
          yield {
            kind: 'error',
            ts: Date.now(),
            engine: ENGINE,
            message: `grok session/new failed: ${created.error?.message ?? 'no sessionId returned'}`,
          };
          yield { kind: 'turn_end', ts: Date.now(), engine: ENGINE, turnId };
          return;
        }
        sessionId = sid;
      }

      await input.metaStore.update(input.agent, input.session, (cur) => ({
        ...cur,
        grokSessionId: sessionId,
        engine: ENGINE,
      }));

      // --- build the prompt ------------------------------------------
      // ACP has no system-prompt slot. On a FRESH session the persona
      // rides in as a preamble on the first user message; on a RESUMED
      // one grok already remembers it, so we send only the per-turn
      // ephemeral context (memory recall / project block), which
      // changes every turn and must always be re-sent.
      const isFresh = sessionId !== priorSessionId;
      const parts: string[] = [];
      if (isFresh && input.systemPrompt.trim()) parts.push(input.systemPrompt.trim());
      if (input.ephemeralContext?.trim()) parts.push(input.ephemeralContext.trim());
      if (!isFresh && input.projectContext?.trim()) parts.push(input.projectContext.trim());
      // Text attachments inline, anything else becomes a note (see
      // renderAttachments) — never a silent drop.
      const attachments = input.attachments ?? [];
      if (attachments.length > 0) {
        const rendered = renderAttachments(attachments);
        if (rendered) parts.push(rendered);
      }
      parts.push(withFromAgentHeader(input.userMessage, input.fromAgent));
      const promptText = parts.join('\n\n---\n\n');

      const undelivered = attachments.filter((a) => a.mime.kind !== 'text');
      if (undelivered.length > 0) {
        logger.info(
          { engine: ENGINE, count: undelivered.length, kinds: undelivered.map((a) => a.mime.kind) },
          'attachments not deliverable over ACP',
        );
        // Side-channel for clients/history: not an `error`, so the
        // fallback path stays out of it.
        yield {
          kind: 'engine_meta',
          ts: Date.now(),
          engine: ENGINE,
          itemType: 'attachments_unsupported',
          payload: {
            count: undelivered.length,
            files: undelivered.map((a) => ({ name: a.name, kind: a.mime.kind })),
          },
        };
      }

      // Drop anything session/load replayed at us before we start
      // listening for THIS turn's output.
      const dropped = client.drain();
      if (dropped > 0) {
        logger.debug({ engine: ENGINE, dropped }, 'discarded replayed ACP frames');
      }

      // --- prompt (fire, then stream notifications) ------------------
      const promptDone = client.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: promptText }] },
        // The request resolves only at end-of-turn; the watchdog on the
        // notification stream is what actually bounds a wedged turn, so
        // give this a generous ceiling.
        Math.max(idleMs, toolIdleMs) * 4,
      );

      let settled = false;
      let usage: AcpUsage | undefined;
      /** Message from an _x.ai API-failure frame, if the turn hit one. */
      let apiError: string | null = null;
      /** Prompt currently executing, learned from _x.ai/queue/changed. */
      let activePromptId: string | null = null;
      void promptDone.then((f) => {
        settled = true;
        const m = (f.result as { _meta?: { usage?: AcpUsage } } | undefined)?._meta;
        if (m?.usage) usage = m.usage;
        if (f.error) {
          logger.warn({ engine: ENGINE, err: f.error.message }, 'session/prompt error');
        }
      });

      // Stream until the prompt settles, the watchdog trips, the child
      // dies, or the user aborts. `settled` alone isn't a sufficient
      // exit condition — the response frame can land before the last
      // few notifications, so we keep draining and let the null-return
      // from next() (empty queue + closed / timed out) end the loop.
      for (;;) {
        if (input.signal?.aborted) break;
        const window = openTools.size > 0 ? toolIdleMs : idleMs;
        const note = await client.next(window);

        if (note === null) {
          if (settled) break;
          if (client.isClosed) {
            yield {
              kind: 'error',
              ts: Date.now(),
              engine: ENGINE,
              message: client.lastError ?? 'grok closed unexpectedly',
            };
            break;
          }
          yield {
            kind: 'error',
            ts: Date.now(),
            engine: ENGINE,
            message: `grok produced no events for ${window}ms — aborting turn`,
          };
          break;
        }

        // xAI-proprietary side-channels (_x.ai/*) carry queue state,
        // announcements, settings — and, crucially, API failures.
        if (note.method.startsWith('_x.ai/')) {
          // Replayed history. session/load re-emits every past frame
          // tagged `_meta.isReplay: true`; drain() clears what arrived
          // before the load response, but this guard is what makes
          // reading the error frames below safe — without it a 402
          // from LAST week would abort every resumed turn.
          const replayed = (note.params as { _meta?: { isReplay?: boolean } })._meta?.isReplay;
          if (replayed) continue;

          if (note.method === '_x.ai/session/prompt_complete') {
            settled = true;
            break;
          }
          if (note.method === '_x.ai/queue/changed') {
            const rp = (note.params as { runningPromptId?: string }).runningPromptId;
            if (typeof rp === 'string') activePromptId = rp;
          }

          // API failures live HERE, not in the ACP error channel:
          // `retry_state{type:'failed'}` announces the failed attempt,
          // `turn_completed{stop_reason:'error'}` closes the turn. Both
          // observed carrying the real message, e.g.
          //   "API error (status 402 Payment Required): Grok Build
          //    usage balance exhausted"
          // Skipping the whole _x.ai/* namespace (as this adapter used
          // to) swallowed those and left the user with a bare
          // "grok returned no content" — a spent subscription looked
          // like an empty reply, and the configured fallback model
          // never kicked in because the placeholder counted as content.
          const xu = (note.params as { update?: Record<string, unknown> }).update;
          if (xu?.sessionUpdate === 'retry_state' && xu.type === 'failed') {
            apiError = typeof xu.message === 'string' ? xu.message : 'grok reported a failed attempt';
            logger.warn({ engine: ENGINE, apiError }, 'grok API failure');
          } else if (xu?.sessionUpdate === 'turn_completed' && xu.stop_reason === 'error') {
            if (typeof xu.agent_result === 'string' && xu.agent_result) apiError = xu.agent_result;
            settled = true;
            break;
          }
          continue;
        }
        if (note.method !== 'session/update') continue;

        // Second guard against replayed history (see AcpClient.drain):
        // once we know which prompt is executing, frames tagged with a
        // different promptId belong to an earlier turn. Frames without
        // a promptId (user_message_chunk, command lists) are structural
        // and pass through to the switch, which ignores them anyway.
        const framePromptId = (note.params as { _meta?: { promptId?: string } })._meta?.promptId;
        if (activePromptId && framePromptId && framePromptId !== activePromptId) {
          continue;
        }

        const upd = (note.params as { update?: AcpSessionUpdate }).update;
        if (!upd) continue;

        switch (upd.sessionUpdate) {
          case 'agent_message_chunk': {
            const t = upd.content?.text ?? '';
            if (t) {
              assistantText += t;
              emittedAny = true;
              // CUMULATIVE, not the bare chunk — see the contract note
              // in src/types/events.ts ("Deltas are cumulative") and
              // how claude-cli/codex-cli do it. Clients REPLACE the
              // rendered bubble with each delta rather than appending,
              // so sending only the fresh fragment makes the reply
              // flicker one word at a time until the final
              // assistant_message lands.
              yield {
                kind: 'assistant_delta',
                ts: Date.now(),
                engine: ENGINE,
                text: assistantText,
              };
            }
            break;
          }
          case 'agent_thought_chunk':
            // Reasoning trace. somora has no first-class thinking event;
            // reasoning token counts surface via turn_end usage instead.
            break;
          case 'tool_call': {
            const id = upd.toolCallId ?? randomUUID();
            openTools.add(id);
            yield {
              kind: 'tool_call',
              ts: Date.now(),
              engine: ENGINE,
              callId: id,
              tool: resolveToolName(upd.title ?? upd.kind ?? 'grok_tool', upd.rawInput),
              input: upd.rawInput ?? {},
            };
            break;
          }
          case 'tool_call_update': {
            const id = upd.toolCallId ?? '';
            const done =
              upd.status === 'completed' || upd.status === 'failed' || upd.status === 'error';
            if (done && id) {
              openTools.delete(id);
              yield {
                kind: 'tool_result',
                ts: Date.now(),
                engine: ENGINE,
                callId: id,
                output: upd.rawOutput ?? null,
                ...(upd.status !== 'completed' ? { error: String(upd.status) } : {}),
              };
            }
            break;
          }
          case 'user_message_chunk':
          case 'available_commands_update':
          case 'current_mode_update':
            break;
          case 'plan': {
            yield {
              kind: 'engine_meta',
              ts: Date.now(),
              engine: ENGINE,
              itemType: 'plan',
              payload: upd,
            };
            break;
          }
          default:
            logger.debug(
              { engine: ENGINE, sessionUpdate: upd.sessionUpdate },
              'unhandled ACP session/update',
            );
        }
      }

      if (!settled) {
        // Loop exited on abort or watchdog — make sure the pending
        // request can't keep a handle alive.
        client.kill();
      }
      await promptDone.catch(() => undefined);

      const finalText = input.signal?.aborted
        ? assistantText || '[somora] aborted by user'
        : assistantText;

      if (apiError && !emittedAny) {
        // Nothing streamed and grok told us why: surface it as an
        // `error` so run-turn-fallback can reroute to the configured
        // fallback model. Emitting a placeholder assistant_message
        // here (the old behaviour) counted as content and pinned the
        // turn to a provider that had just refused to serve it.
        yield {
          kind: 'error',
          ts: Date.now(),
          engine: ENGINE,
          message: `grok: ${apiError}`,
        };
      } else if (finalText || !emittedAny) {
        yield {
          kind: 'assistant_message',
          ts: Date.now(),
          engine: ENGINE,
          // Partial answer + late failure: keep the text, append the
          // reason rather than dropping either.
          text: apiError
            ? `${finalText}\n\n[somora] grok aborted this turn: ${apiError}`
            : finalText || '[somora] grok returned no content',
        };
      }

      yield {
        kind: 'turn_end',
        ts: Date.now(),
        engine: ENGINE,
        turnId,
        ...(usage
          ? {
              usage: {
                tokens_in: usage.inputTokens ?? 0,
                tokens_out: usage.outputTokens ?? 0,
                ...(usage.cachedReadTokens !== undefined
                  ? { tokens_in_cached: usage.cachedReadTokens }
                  : {}),
                ...(usage.reasoningTokens !== undefined
                  ? { tokens_out_reasoning: usage.reasoningTokens }
                  : {}),
              },
            }
          : {}),
      };
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      client.kill();
    }
  },
};
