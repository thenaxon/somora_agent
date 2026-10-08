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
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MCP_SERVER_NAME,
  somoraMcpProxyName,
  somoraMcpProxySpawn,
  somoraMemoryServerSpawn,
} from '../mcp/config.ts';
import { logger } from '../server/logger.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { grokCliReasoningArgs } from './thinking-params.ts';
import { grokChildEnv, somoraGrokHome, syncGrokHome } from './grok-home.ts';
import { resolveGrokLaunch } from './grok-bin.ts';
import { buildCodexAttachments } from '../multimodal/user-content.ts';
import { capReplayDelta, computeReplayDelta, getLastSeenTs, renderReplayPrefix, withLastSeenTs } from './replay.ts';
import type { AgentEngine, ResolvedAttachment, TurnInput } from './types.ts';
import type { ResolvedModel, ThinkingLevel } from '../config/types.ts';
import type { SteerMessage } from '../server/steer-inbox.ts';

const ENGINE = 'grok-cli';

/** Fallback idle window when the server doesn't resolve one. */
const DEFAULT_IDLE_MS = 300_000;

/** Handshake must complete inside this or the binary is considered broken. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/** A start failure in words that say what to do. Deliberately free of
 *  network phrases: a missing binary is not an outage, so the model is
 *  not marked unavailable for an hour. */
export function describeSpawnFailure(bin: string, err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') {
    return `grok binary not found (${bin}). Install the Grok Build CLI (curl -fsSL https://x.ai/cli/install.sh | bash) or set SOMORA_GROK_BIN, then run \`grok login\`.`;
  }
  if (err.code === 'EACCES') return `grok binary is not executable (${bin}).`;
  return `grok could not be started (${bin}): ${err.message}`;
}

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
 * (`somora__time_now`), NOT with somora's own `mcp__` prefix.
 * See stripToolPrefix() for the normalisation applied before events
 * reach the rest of somora.
 *
 * Beyond somora this also returns one `somora-<name>` proxy
 * child per enabled external MCP server (hub design §4.4) — the same
 * entries claude-cli and codex-cli add. grok-cli is a CLI engine, so
 * it reaches external servers the CLI way: the child serves the hub's
 * catalog snapshot and forwards tools/call to the main server, rather
 * than receiving pre-bridged tools via `tools` like openai-compat.
 * Per-agent gating happens inside the child (SOMORA_AGENT), so the
 * entry list itself is agent-independent.
 */
function buildMcpServers(args: {
  agent: string;
  session: string;
  subagentDepth?: number;
  activeModelRef?: string;
  externalMcpServers?: Array<{ name: string; timeoutMs: number }>;
}): AcpMcpServer[] {
  const toAcpEnv = (env: Record<string, string>) =>
    Object.entries(env).map(([name, value]) => ({ name, value }));

  const spawnCfg = somoraMemoryServerSpawn({
    agent: args.agent,
    session: args.session,
    subagentDepth: args.subagentDepth,
    activeModelRef: args.activeModelRef,
  });
  const servers: AcpMcpServer[] = [
    {
      name: MCP_SERVER_NAME,
      command: spawnCfg.command,
      args: spawnCfg.args,
      env: toAcpEnv(spawnCfg.env),
    },
  ];

  for (const srv of args.externalMcpServers ?? []) {
    const proxyCfg = somoraMcpProxySpawn({ server: srv.name, agent: args.agent });
    servers.push({
      name: somoraMcpProxyName(srv.name),
      command: proxyCfg.command,
      args: proxyCfg.args,
      env: toAcpEnv(proxyCfg.env),
    });
  }

  return servers;
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
 *   use_tool{tool_name:'somora__time_now'}
 *                                → mcp__somora__time_now
 *   somora__memory_list   → mcp__somora__memory_list
 *   somora-parallel__web_search  → mcp__somora-parallel__web_search
 *   mcp__somora__time_now → unchanged (already normalised)
 *   search_tool, read_file       → unchanged (grok's own built-ins)
 *
 * `serverNames` is the set of MCP entries actually handed to this
 * session (somora plus one somora-<name> per external server),
 * so the prefix decision is an exact match against what we registered
 * rather than a guess at what a `somora-`-shaped name might be.
 */
function resolveToolName(
  rawTitle: string,
  rawInput: unknown,
  serverNames: ReadonlySet<string>,
): string {
  let name = rawTitle;

  if (name === 'use_tool' && rawInput && typeof rawInput === 'object') {
    const inner = (rawInput as { tool_name?: unknown }).tool_name;
    if (typeof inner === 'string' && inner.length > 0) {
      name = inner;
    }
  }

  for (const server of serverNames) {
    if (name.startsWith(`${server}__`)) {
      return `mcp__${name}`;
    }
  }
  return name;
}

/**
 * What a somora tool returned, without Grok's wrapper. Grok reports an
 * MCP call as `{type: 'MCP', tool_name, server_name, output: {OkayOutput:
 * '<the tool's JSON as a string>'}}`; the clients summarise results from
 * the tool's own JSON, as they get it from the other engines. Anything
 * else (Grok's search_tool, an unknown shape) passes through unchanged.
 */
export function unwrapToolOutput(raw: unknown): { output: unknown; error?: string } {
  if (!raw || typeof raw !== 'object') return { output: raw ?? null };
  const r = raw as { type?: unknown; output?: unknown };
  if (r.type !== 'MCP' || !r.output || typeof r.output !== 'object') return { output: raw };
  const inner = r.output as Record<string, unknown>;
  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  if ('OkayOutput' in inner) return { output: parse(inner.OkayOutput) };
  const errKey = Object.keys(inner).find((k) => /err/i.test(k));
  if (errKey) {
    const value = parse(inner[errKey]);
    return { output: value, error: typeof value === 'string' ? value : JSON.stringify(value) };
  }
  return { output: raw };
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

/**
 * How a somora agent's tools reach Grok. Grok never lists MCP tools to
 * the model: it offers two meta-tools, `search_tool` (find by keyword)
 * and `use_tool` (call by id). The ids are `<server>__<tool>`, and the
 * agent's instructions name tools without that prefix — so the model is
 * told once how to translate (2026-10-08: its first call went to a bare
 * `time_now` and failed).
 */
export const GROK_TOOL_GUIDANCE = [
  '## Your tools',
  '',
  'Your tools are provided by somora through two meta-tools:',
  '- `search_tool` finds tools by keyword.',
  "- `use_tool` calls one: `tool_name` is its id, `tool_input` its arguments.",
  '',
  'Tool ids are `somora__<tool>`. When these instructions name a tool such as',
  '`memory_search`, call it as `somora__memory_search`. Tools of an external',
  'server read `somora-<server>__<tool>`. You have no other tools: anything',
  'that touches files, runs commands or searches the web goes through them.',
].join('\n');

/**
 * The agent profile sent with every session/new and session/load
 * (`_meta.agentProfile`). It does for Grok what the claude-cli and
 * codex-cli adapters do with their engines' own switches:
 *
 * - `tools`: only the two meta-tools that reach somora's MCP tools.
 *   Grok's own built-ins (terminal, file edit, web search, its own
 *   subagents, scheduler) are off — they ran unchecked by somora's tool
 *   gating, path rules and exec guard (2026-10-08: a live test wrote a
 *   file through `run_terminal_command`).
 * - `promptMode: full` + `promptBody`: somora's system prompt IS the
 *   system prompt, replacing Grok's coding-agent template. Sent on every
 *   load, so an edited persona reaches a resumed session (it used to
 *   ride on the first user message and stay frozen there).
 * - no skill discovery, no AGENTS.md lookup in the working folder.
 */
export function buildAgentProfile(systemPrompt: string): Record<string, unknown> {
  return {
    name: 'somora',
    description: 'A somora agent',
    promptMode: 'full',
    promptBody: [systemPrompt.trim(), GROK_TOOL_GUIDANCE].filter(Boolean).join('\n\n'),
    tools: ['search_tool', 'use_tool'],
    discoverSkills: false,
    inheritSkills: false,
    agentsMd: false,
  };
}

/** After a Stop, how long Grok gets to end the turn itself. */
const ABORT_GRACE_MS = 3_000;

/** How long a turn waits for somora's MCP servers to report ready. */
const MCP_READY_TIMEOUT_MS = 30_000;
const MCP_READY_POLL_MS = 250;

/** Server name → session status from an `_x.ai/mcp/list` answer. */
export function mcpStatuses(result: unknown): Map<string, string> {
  const out = new Map<string, string>();
  // xAI extension answers arrive wrapped once more: {result: {servers}}.
  const inner = (result as { result?: unknown } | undefined)?.result ?? result;
  const servers = (inner as { servers?: Array<{ name?: unknown; session?: { status?: unknown } }> } | undefined)?.servers;
  for (const s of servers ?? []) {
    if (typeof s.name === 'string') out.set(s.name, typeof s.session?.status === 'string' ? s.session.status : 'unknown');
  }
  return out;
}

// ---------------------------------------------------------------------
// Minimal ACP client over a spawned child
// ---------------------------------------------------------------------

type Notification = { method: string; params: Record<string, unknown> };

/**
 * Grok's own record of a session: `<GROK_HOME>/sessions/<cwd>/<id>/updates.jsonl`.
 * Steering reads it — a mid-turn message is written there the moment
 * Grok hands it to the model, and nothing on the ACP stream says so.
 */
export function grokUpdatesFile(grokHome: string, sessionId: string): string | null {
  const root = join(grokHome, 'sessions');
  try {
    for (const dir of readdirSync(root)) {
      const f = join(root, dir, sessionId, 'updates.jsonl');
      if (existsSync(f)) return f;
    }
  } catch {
    /* no sessions yet */
  }
  return null;
}

/**
 * The ids of steered messages Grok has handed to the model, read from
 * lines appended to updates.jsonl: a user_message_chunk flagged
 * `_meta.interjection` whose typed text is the framed message. Earlier
 * entries match first, so the same text sent twice confirms in order.
 */
export function confirmedInterjections(lines: string, pending: { id: string; text: string }[]): string[] {
  const open = [...pending];
  const done: string[] = [];
  for (const line of lines.split('\n')) {
    if (!line.includes('"interjection"')) continue;
    let upd: { sessionUpdate?: string; _meta?: { interjection?: boolean }; content?: { text?: string; _meta?: { displayText?: string } } } | undefined;
    try {
      upd = (JSON.parse(line) as { params?: { update?: typeof upd } }).params?.update;
    } catch {
      continue;
    }
    if (upd?.sessionUpdate !== 'user_message_chunk' || upd._meta?.interjection !== true) continue;
    const typed = upd.content?._meta?.displayText;
    const wrapped = upd.content?.text ?? '';
    const i = open.findIndex((p) => p.text === typed || (typed === undefined && wrapped.includes(p.text)));
    if (i >= 0) done.push(open.splice(i, 1)[0]!.id);
  }
  return done;
}

function imageMimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
}

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

  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(bin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
      this.exitInfo = describeSpawnFailure(bin, err as NodeJS.ErrnoException);
      // Answer every waiting request now with the real cause — before,
      // the handshake sat out its 30 s timeout and then blamed the login.
      for (const [, res] of this.pending) {
        res({ jsonrpc: '2.0', error: { code: -1, message: this.exitInfo } });
      }
      this.pending.clear();
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
            outcome: { outcome: 'selected', optionId: 'allow-once' },
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

  /** A JSON-RPC notification: no id, no answer (session/cancel). */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Put an event of somora's own into the stream the turn loop reads,
   *  so a timer (steering) can wake the loop without its own channel. */
  inject(note: Notification): void {
    this.queue.push(note);
    this.wake();
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
    // After an MCP server rename (`somora-memory` → `somora`, 2026-09-03)
    // the stored grok session knows the tools under the old name — start
    // a fresh ACP session instead of session/load. Same guard as the
    // claude-cli / codex-cli adapters.
    const recordedServer = typeof meta.mcpServerName === 'string' ? meta.mcpServerName : null;
    const mcpRenamed = typeof meta.grokSessionId === 'string' && recordedServer !== MCP_SERVER_NAME;
    const priorSessionId =
      typeof meta.grokSessionId === 'string' && !mcpRenamed ? meta.grokSessionId : null;
    if (mcpRenamed) {
      logger.info({
        msg: 'engine.mcp_rename_resession',
        engine: ENGINE,
        agent: input.agent,
        session: input.session,
        recordedServer,
        currentServer: MCP_SERVER_NAME,
        droppedSessionId: meta.grokSessionId,
      });
      yield {
        kind: 'engine_meta',
        ts: Date.now(),
        engine: ENGINE,
        itemType: 'mcp_server_renamed',
        payload: {
          from: recordedServer,
          to: MCP_SERVER_NAME,
          text: `Grok session restarted because somora's MCP server was renamed (${recordedServer ?? 'somora-memory'} → ${MCP_SERVER_NAME}) — session history carried over.`,
        },
      };
    }

    // cwd: the session's working folder (the agent's workspace, or the
    // pinned project's folder), as for every other engine. Grok keys its
    // stored sessions by it.
    const cwd = input.workdir ?? process.env.SOMORA_WORKSPACE ?? homedir();

    // somora's own Grok home, with the login brought in step (see
    // grok-home.ts). Read on every turn, like the binary below.
    const home = syncGrokHome();
    if (home.action === 'missing') {
      logger.warn({ msg: 'engine.grok_auth_missing', engine: ENGINE, agent: input.agent, hint: 'run `grok login` — the turn will fail on authentication' });
    }
    // Looked up on every turn (grok-bin.ts): the bundled binary unless
    // SOMORA_GROK_BIN overrides it, a new version or a late install is
    // picked up without a restart.
    const launch = await resolveGrokLaunch();
    const bin = launch.bin;

    const args = [
      'agent',
      // A private process for this turn, never the shared leader.
      '--no-leader',
      // Only somora's tools exist in the session (agent profile below),
      // so approving them automatically is what somora's gating wants.
      '--always-approve',
      ...(input.resolvedModel.modelId ? ['-m', input.resolvedModel.modelId] : []),
      ...grokCliReasoningArgs(input.thinking, input.resolvedModel.model),
      'stdio',
    ];

    const client = new AcpClient(bin, args, cwd, grokChildEnv());
    logger.info({ msg: 'engine.grok_spawn', engine: ENGINE, agent: input.agent, session: input.session, bin, source: launch.source, version: launch.version, grokHome: somoraGrokHome(), cwd });
    // Stop: ask Grok to cancel the prompt (it ends the turn cleanly and
    // keeps the session consistent); kill the process only if it has not
    // stopped within ABORT_GRACE_MS, or when there is no session yet.
    let activeSessionId: string | null = null;
    let abortKill: NodeJS.Timeout | null = null;
    let abortedAt = 0;
    let steerTimer: NodeJS.Timeout | null = null;
    /** Steered messages sent to Grok and not yet seen taken (see below). */
    const steerPending: { id: string; text: string; msg: SteerMessage }[] = [];
    let settled = false;
    const onAbort = () => {
      abortedAt = Date.now();
      if (!activeSessionId) {
        client.kill();
        return;
      }
      client.notify('session/cancel', { sessionId: activeSessionId });
      abortKill = setTimeout(() => client.kill(), ABORT_GRACE_MS);
      abortKill.unref?.();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    let assistantText = '';

    // Reasoning trace from agent_thought_chunk.
    let thinkingText = '';
    let emittedAny = false;
    /** A tool ran since the last text: the next text opens a paragraph. */
    let toolSinceText = false;
    /** Same for the reasoning trace: each model round's thoughts apart. */
    let roundSinceThought = false;
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
        // A start failure already says what is wrong (describeSpawnFailure);
        // only a real handshake failure gets the login hint.
        const message = client.lastError
          ? client.lastError
          : `grok handshake failed: ${init.error.message}. Has \`grok login\` been run?`;
        yield { kind: 'error', ts: Date.now(), engine: ENGINE, message };
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
        externalMcpServers: input.externalMcpServers,
      });
      const mcpServerNames = new Set(mcpServers.map((s) => s.name));
      const agentProfile = buildAgentProfile(input.systemPrompt);
      // The profile sets tools and the prompt of a NEW session; a loaded
      // session keeps the system prompt it was stored with unless
      // `systemPromptOverride` replaces it — so an edited persona reaches
      // a resumed session too (2026-10-08: it quoted the old line).
      const sessionMeta = { agentProfile, systemPromptOverride: agentProfile.promptBody };

      let sessionId: string | null = null;
      if (priorSessionId) {
        const loaded = await client.request(
          'session/load',
          { sessionId: priorSessionId, cwd, mcpServers, _meta: sessionMeta },
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
          { cwd, mcpServers, _meta: sessionMeta },
          // MCP child startup (tsx + the somora server) adds a few
          // seconds on top of the bare handshake — measured ~3.5s for
          // the single somora child on 2026-07-20. External
          // servers add one more child of the same binary each, so the
          // budget scales per child instead of being a flat doubling.
          // With no external servers configured this is exactly the
          // previous `* 2`.
          HANDSHAKE_TIMEOUT_MS * (1 + mcpServers.length),
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
      activeSessionId = sessionId;

      // Grok starts the MCP children with the session and answers before
      // they are up; a prompt sent at once found somora's tools missing
      // ("the somora server is still connecting") and the model gave up
      // or spent a round searching. Wait until every server is ready (or
      // has failed), at most MCP_READY_TIMEOUT_MS.
      const mcpWaitStart = Date.now();
      let statuses = new Map<string, string>();
      for (;;) {
        const listed = await client.request('_x.ai/mcp/list', { sessionId }, 5_000);
        statuses = mcpStatuses(listed.result);
        const ours = [...mcpServerNames].map((n) => statuses.get(n) ?? 'missing');
        if (listed.error || ours.every((st) => st === 'ready' || st === 'unavailable' || st === 'setuprequired')) break;
        if (Date.now() - mcpWaitStart > MCP_READY_TIMEOUT_MS || client.isClosed) break;
        await new Promise((r) => setTimeout(r, MCP_READY_POLL_MS));
      }
      const notReady = [...mcpServerNames].filter((n) => statuses.get(n) !== 'ready');
      logger.info({
        msg: 'engine.grok_mcp_ready',
        engine: ENGINE,
        agent: input.agent,
        session: input.session,
        waitedMs: Date.now() - mcpWaitStart,
        ...(notReady.length ? { notReady: Object.fromEntries(notReady.map((n) => [n, statuses.get(n) ?? 'missing'])) } : {}),
      });

      await input.metaStore.update(input.agent, input.session, (cur) => ({
        ...cur,
        grokSessionId: sessionId,
        // Grok files a session under its working folder; compacting by
        // hand (compactGrokSession) loads it from the same one.
        grokCwd: cwd,
        mcpServerName: MCP_SERVER_NAME,
        engine: ENGINE,
      }));

      // --- build the prompt ------------------------------------------
      // The system prompt travels in the agent profile (session/new and
      // session/load); the message carries only the per-turn context
      // (memory recall / project block) and what the person wrote.
      const isFresh = sessionId !== priorSessionId;
      const parts: string[] = [];
      if (input.ephemeralContext?.trim()) parts.push(input.ephemeralContext.trim());
      if (!isFresh && input.projectContext?.trim()) parts.push(input.projectContext.trim());
      // Text attachments inline; images (and PDFs, rendered to page
      // images like for codex) as ACP image blocks after the text — Grok
      // takes those in a prompt and scales them itself. Anything else
      // becomes a note (renderAttachments), never a silent drop.
      const attachments = input.attachments ?? [];
      const seeable = attachments.filter((a) => a.mime.kind === 'image' || a.mime.kind === 'pdf');
      const { imagePaths, promptPrefix: seeablePrefix } = await buildCodexAttachments(seeable);
      if (seeablePrefix.trim()) parts.push(seeablePrefix.trim());
      // Stored attachments carry their detected type; rendered PDF pages are PNGs.
      const knownMime = new Map(seeable.filter((a) => a.mime.kind === 'image').map((a) => [a.path, a.mime.mimeType]));
      const imageBlocks = imagePaths.flatMap((path) => {
        try {
          return [{ type: 'image' as const, mimeType: knownMime.get(path) ?? imageMimeForPath(path), data: readFileSync(path).toString('base64') }];
        } catch (err) {
          logger.warn({ engine: ENGINE, path, err: (err as Error).message }, 'attachment image unreadable');
          return [];
        }
      });
      const rest = attachments.filter((a) => a.mime.kind !== 'image' && a.mime.kind !== 'pdf');
      if (rest.length > 0) {
        const rendered = renderAttachments(rest);
        if (rendered) parts.push(rendered);
      }
      // Turns other engines answered since Grok last spoke in this session
      // (a model switch and back), or the conversation so far when this
      // is a new Grok session — the same catch-up codex-cli sends. Before,
      // a switch back to Grok lost what was said in between (2026-10-08:
      // a word told to Claude came back as "None.").
      const lastSeenTs = isFresh ? 0 : getLastSeenTs(meta, ENGINE);
      const rawDelta = computeReplayDelta(input.history, lastSeenTs, (meta as { compactions?: never }).compactions);
      const replayPrefix = renderReplayPrefix(isFresh ? capReplayDelta(rawDelta) : rawDelta);
      if (replayPrefix) parts.push(replayPrefix.trimEnd());
      // The A2A header travels in ephemeralContext (src/server/turn-framing.ts).
      parts.push(input.userMessage);
      const promptText = parts.join('\n\n---\n\n');

      const undelivered = rest.filter((a) => a.mime.kind !== 'text');
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
        { sessionId, prompt: [{ type: 'text', text: promptText }, ...imageBlocks] },
        // The request resolves only at end-of-turn; the watchdog on the
        // notification stream is what actually bounds a wedged turn, so
        // give this a generous ceiling.
        Math.max(idleMs, toolIdleMs) * 4,
      );

      // --- steering ------------------------------------------------------
      // A message sent while the turn runs goes to Grok as `_x.ai/interject`;
      // Grok hands it to the model at its next step (after a tool round,
      // before the next model call, or before ending the turn). The answer
      // only says "queued", so the record for the session file waits until
      // the message shows up in Grok's updates.jsonl. Whatever Grok had not
      // taken when the turn ended goes back to the letterbox and becomes
      // the next turn — Grok would otherwise run it as a turn of its own
      // in a process that is about to stop.
      let updatesFile: string | null = null;
      let updatesOffset = 0;
      const locateUpdates = (): boolean => {
        if (updatesFile) return true;
        updatesFile = grokUpdatesFile(somoraGrokHome(), sessionId);
        if (updatesFile) updatesOffset = statSync(updatesFile).size;
        return updatesFile !== null;
      };
      locateUpdates();
      /** Messages Grok has taken since the last look, in order. */
      const takeConfirmed = (): SteerMessage[] => {
        if (steerPending.length === 0 || !locateUpdates()) return [];
        const size = statSync(updatesFile!).size;
        if (size <= updatesOffset) return [];
        const buf = Buffer.alloc(size - updatesOffset);
        const fd = openSync(updatesFile!, 'r');
        try {
          readSync(fd, buf, 0, buf.length, updatesOffset);
        } finally {
          closeSync(fd);
        }
        // Only whole lines; a half-written last line is read next time.
        const text = buf.toString('utf8');
        const end = text.lastIndexOf('\n');
        if (end < 0) return [];
        updatesOffset += Buffer.byteLength(text.slice(0, end + 1));
        const ids = new Set(confirmedInterjections(text.slice(0, end + 1), steerPending));
        const taken: SteerMessage[] = [];
        for (let i = 0; i < steerPending.length; i++) {
          if (ids.has(steerPending[i]!.id)) taken.push(...steerPending.splice(i--, 1).map((p) => p.msg));
        }
        return taken;
      };
      if (input.steer) {
        const steer = input.steer;
        steerTimer = setInterval(() => {
          if (settled || client.isClosed || input.signal?.aborted) return;
          const taken = takeConfirmed();
          if (taken.length > 0) client.inject({ method: 'somora/steer_applied', params: { messages: taken } });
          const msgs = steer.drain();
          for (const m of msgs) {
            const text = steer.frame(m);
            client
              .request('_x.ai/interject', { sessionId, text, interjectionId: m.id }, 5_000)
              .then((frame) => {
                if (frame.error) throw new Error(frame.error.message);
                steerPending.push({ id: m.id, text, msg: m });
                logger.info({ msg: 'engine.grok_steer_sent', engine: ENGINE, agent: input.agent, session: input.session, steerId: m.id });
              })
              .catch((err: unknown) => {
                logger.warn({ msg: 'engine.steer_refused', engine: ENGINE, agent: input.agent, session: input.session, err: String((err as Error)?.message ?? err) });
                steer.requeue([m]);
              });
          }
        }, 300);
        steerTimer.unref?.();
      }

      settled = false;
      let usage: AcpUsage | undefined;
      /** Prompt size of the latest model call: what the session holds now. */
      let lastCallContextTokens: number | undefined;
      /** The window Grok itself reports for the model, when it does. */
      let engineContextWindow: number | undefined;
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
        // After a Stop, keep reading briefly: Grok ends the cancelled
        // prompt itself (onAbort sent session/cancel), and onAbort kills
        // the process should that take longer than ABORT_GRACE_MS.
        const aborting = input.signal?.aborted === true;
        const window = aborting ? 500 : openTools.size > 0 ? toolIdleMs : idleMs;
        const note = await client.next(window);

        if (note === null) {
          if (settled || (aborting && !client.isClosed)) break;
          if (client.isClosed) {
            // A user abort kills the child on purpose (onAbort above), so
            // the resulting "exited (signal=SIGTERM)" is not an engine
            // failure. Yielding it as `error` before any content made
            // run-turn-fallback swallow the turn_end and start the
            // FALLBACK model after the user had just cancelled. The
            // "[somora] aborted by user" assistant_message below covers
            // the abort case; only a genuine crash is an error.
            if (!input.signal?.aborted) {
              yield {
                kind: 'error',
                ts: Date.now(),
                engine: ENGINE,
                message: client.lastError ?? 'grok closed unexpectedly',
              };
            }
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
        if (note.method === 'somora/steer_applied') {
          // No paragraph mark here: the record lands up to ~2 s after Grok
          // took the message, often mid-sentence of the next round. The
          // round's end (response_completed) already set it.
          yield { kind: 'steer_applied', ts: Date.now(), engine: ENGINE, messages: note.params.messages as SteerMessage[] };
          continue;
        }

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
          // Every model call ends with response_completed and its usage
          // (input_tokens without the cached part, as on Anthropic's API):
          // the last one is the session's fill level, and it marks the end
          // of a round — what comes next starts a new paragraph.
          if (xu?.sessionUpdate === 'response_completed') {
            const u = xu.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
            if (u) lastCallContextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            toolSinceText = true;
            roundSinceThought = true;
            continue;
          }
          // Grok compacts its own conversation near the window's end; a row
          // in the history says so, as for codex — the fill level drops.
          if (xu?.sessionUpdate === 'auto_compact_completed') {
            const before = typeof xu.tokens_before === 'number' ? xu.tokens_before : undefined;
            const after = typeof xu.tokens_after === 'number' ? xu.tokens_after : undefined;
            logger.info({ msg: 'engine.grok_compacted', engine: ENGINE, agent: input.agent, session: input.session, tokensBefore: before, tokensAfter: after });
            yield {
              kind: 'engine_meta',
              ts: Date.now(),
              engine: ENGINE,
              itemType: 'context_compacted',
              payload: {
                text: 'grok compacted this conversation itself — the context percentage drops accordingly',
                reason: 'engine_side',
                ...(before !== undefined ? { tokensBefore: before } : {}),
                ...(after !== undefined ? { tokensAfter: after } : {}),
              },
            };
            continue;
          }
          if (note.method === '_x.ai/models/update') {
            const mu = note.params as { currentModelId?: string; availableModels?: { modelId?: string; _meta?: { totalContextTokens?: number } }[] };
            const cur = mu.availableModels?.find((m) => m.modelId === mu.currentModelId);
            if (typeof cur?._meta?.totalContextTokens === 'number') engineContextWindow = cur._meta.totalContextTokens;
            continue;
          }
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
              // A new stretch of text after tool work starts a paragraph,
              // as on claude-cli — the pieces used to run together
              // ("…look it up.It is 12:43…").
              if (toolSinceText && assistantText && !assistantText.endsWith('\n')) assistantText += '\n\n';
              toolSinceText = false;
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
          case 'agent_thought_chunk': {
            // Reasoning trace (ACP). Cumulative like agent_message_chunk.
            const t = upd.content?.text ?? '';
            if (t) {
              if (roundSinceThought && thinkingText && !thinkingText.endsWith('\n')) thinkingText += '\n\n';
              roundSinceThought = false;
              thinkingText += t;
              yield { kind: 'thinking_delta', ts: Date.now(), engine: ENGINE, text: thinkingText };
            }
            break;
          }
          case 'tool_call': {
            const id = upd.toolCallId ?? randomUUID();
            openTools.add(id);
            toolSinceText = true;
            roundSinceThought = true;
            yield {
              kind: 'tool_call',
              ts: Date.now(),
              engine: ENGINE,
              callId: id,
              tool: resolveToolName(
                upd.title ?? upd.kind ?? 'grok_tool',
                upd.rawInput,
                mcpServerNames,
              ),
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
              toolSinceText = true;
              const unwrapped = unwrapToolOutput(upd.rawOutput);
              const error = upd.status !== 'completed' ? (unwrapped.error ?? String(upd.status)) : unwrapped.error;
              yield {
                kind: 'tool_result',
                ts: Date.now(),
                engine: ENGINE,
                callId: id,
                output: unwrapped.output,
                ...(error ? { error } : {}),
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

      // Steering: what Grok took in its last steps is recorded; the rest
      // becomes the next turn. Grok writes updates.jsonl from a background
      // task, so a message taken right before the end may land a moment late.
      if (steerTimer) {
        clearInterval(steerTimer);
        steerTimer = null;
      }
      if (input.steer && steerPending.length > 0) {
        const late: SteerMessage[] = [];
        for (let waited = 0; ; waited += 100) {
          late.push(...takeConfirmed());
          if (steerPending.length === 0 || waited >= 1_000) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (late.length > 0) yield { kind: 'steer_applied', ts: Date.now(), engine: ENGINE, messages: late };
        if (steerPending.length > 0) {
          logger.info({ msg: 'engine.grok_steer_requeued', engine: ENGINE, agent: input.agent, session: input.session, count: steerPending.length });
          input.steer.requeue(steerPending.splice(0).map((p) => p.msg));
        }
      }

      // Grok has now heard everything up to here: the next catch-up starts
      // after this turn. Read fresh — tools may have written the meta. A
      // stopped turn counts too: Grok kept the prompt it was cancelled on.
      if (emittedAny || input.signal?.aborted) {
        await input.metaStore
          .update(input.agent, input.session, (fresh) => ({
            ...fresh,
            engineLastSeen: withLastSeenTs(fresh, ENGINE, Date.now()),
          }))
          .catch((err) => logger.warn({ msg: 'engine.meta_write_failed', engine: ENGINE, err: String(err) }));
      }

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
                if (thinkingText) {
          yield { kind: 'thinking_message', ts: Date.now(), engine: ENGINE, text: thinkingText };
          thinkingText = '';
        }
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
                ...(lastCallContextTokens !== undefined ? { context_tokens: lastCallContextTokens } : {}),
                ...(engineContextWindow !== undefined ? { context_window: engineContextWindow } : {}),
              },
            }
          : {}),
      };
    } finally {
      input.signal?.removeEventListener('abort', onAbort);
      if (abortKill) clearTimeout(abortKill);
      if (steerTimer) clearInterval(steerTimer);
      // A turn that threw still hands back what Grok never took.
      if (steerPending.length > 0) input.steer?.requeue(steerPending.splice(0).map((p) => p.msg));
      if (abortedAt) {
        logger.info({ msg: 'engine.grok_abort', engine: ENGINE, agent: input.agent, session: input.session, cancelled: activeSessionId !== null, endedByGrok: settled, exited: client.isClosed, ms: Date.now() - abortedAt });
      }
      client.kill();
    }
  },
};

/**
 * Compact a Grok session by hand (`/compact`): load it in a short-lived
 * Grok process and send `_x.ai/compact_conversation`, which answers once
 * Grok has summarised the conversation by its own rules. Grok takes no
 * instructions for it, like codex. Runs outside a turn; the caller holds
 * the session lock.
 */
export async function compactGrokSession(args: {
  agent: string;
  session: string;
  resolvedModel: TurnInput['resolvedModel'];
  metaStore: TurnInput['metaStore'];
  timeoutMs?: number;
}): Promise<{ status: 'compacted' | 'nothing_to_compact'; tokensBefore?: number; tokensAfter?: number; note?: string }> {
  const { agent, session, metaStore } = args;
  const meta = await metaStore.get(agent, session);
  const sessionId = typeof meta.grokSessionId === 'string' ? meta.grokSessionId : null;
  if (!sessionId) return { status: 'nothing_to_compact', note: 'Grok has no session for this conversation yet.' };
  const logCtx = { engine: ENGINE, agent, session };
  syncGrokHome();
  const launch = await resolveGrokLaunch();
  const cwd = typeof meta.grokCwd === 'string' && existsSync(meta.grokCwd) ? meta.grokCwd : (process.env.SOMORA_WORKSPACE ?? homedir());
  const argv = ['agent', '--no-leader', ...(args.resolvedModel.modelId ? ['-m', args.resolvedModel.modelId] : []), 'stdio'];
  const client = new AcpClient(launch.bin, argv, cwd, grokChildEnv());
  try {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, HANDSHAKE_TIMEOUT_MS);
    if (init.error) throw new Error(client.lastError ?? `grok handshake failed: ${init.error.message}`);
    const loaded = await client.request('session/load', { sessionId, cwd, mcpServers: [] }, HANDSHAKE_TIMEOUT_MS);
    if (loaded.error) return { status: 'nothing_to_compact', note: `Grok could not open the session: ${loaded.error.message}` };
    client.drain();
    const done = await client.request('_x.ai/compact_conversation', { sessionId }, args.timeoutMs ?? 300_000);
    if (done.error) {
      logger.warn({ msg: 'engine.manual_compaction_failed', ...logCtx, err: done.error.message });
      throw new Error(`Grok did not finish the compaction: ${done.error.message}`);
    }
    // The sizes come in the auto_compact_completed update sent just before the answer.
    let tokensBefore: number | undefined;
    let tokensAfter: number | undefined;
    for (let note = await client.next(200); note; note = await client.next(200)) {
      const u = (note.params as { update?: { sessionUpdate?: string; tokens_before?: number; tokens_after?: number } }).update;
      if (u?.sessionUpdate === 'auto_compact_completed') {
        if (typeof u.tokens_before === 'number') tokensBefore = u.tokens_before;
        if (typeof u.tokens_after === 'number') tokensAfter = u.tokens_after;
      }
    }
    logger.info({ msg: 'engine.manual_compaction_done', ...logCtx, tokensBefore, tokensAfter });
    return { status: 'compacted', ...(tokensBefore !== undefined ? { tokensBefore } : {}), ...(tokensAfter !== undefined ? { tokensAfter } : {}) };
  } finally {
    client.kill();
  }
}

export interface GrokOneShotArgs {
  model: ResolvedModel;
  systemPrompt: string;
  userMessage: string;
  timeoutMs: number;
  signal?: AbortSignal;
  thinking?: ThinkingLevel;
  logCtx?: Record<string, unknown>;
}

export interface GrokOneShotResult {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * One question, one answer, no tools: what REM, Deep, Lucid, the judge,
 * the wiki migration and compaction need from a worker model. A fresh
 * Grok session in a private process, its system prompt replaced by the
 * caller's, no MCP servers and no Grok built-ins (the allowlist names
 * only `search_tool`, which finds nothing without servers — an empty
 * list would mean "every tool"). The session folder and Grok's prompt
 * history are removed after, so a REM run of hundreds of pieces leaves
 * nothing behind.
 */
export async function grokOneShot(args: GrokOneShotArgs): Promise<GrokOneShotResult> {
  const logCtx = { engine: ENGINE, model: args.model.modelId, ...args.logCtx };
  syncGrokHome();
  const launch = await resolveGrokLaunch();
  const cwd = join(somoraGrokHome(), 'workspace');
  mkdirSync(cwd, { recursive: true });
  const argv = [
    'agent',
    '--no-leader',
    '--always-approve',
    ...(args.model.modelId ? ['-m', args.model.modelId] : []),
    ...grokCliReasoningArgs(args.thinking, args.model.model),
    'stdio',
  ];
  const client = new AcpClient(launch.bin, argv, cwd, grokChildEnv());
  const onAbort = () => client.kill();
  if (args.signal?.aborted) client.kill();
  args.signal?.addEventListener('abort', onAbort, { once: true });
  const started = Date.now();
  const deadline = () => Math.max(1_000, args.timeoutMs - (Date.now() - started));
  let sessionId: string | null = null;
  try {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, Math.min(HANDSHAKE_TIMEOUT_MS, deadline()));
    if (init.error) throw new Error(client.lastError ?? `grok handshake failed: ${init.error.message}. Has \`somora grok login\` been run?`);
    const profile = {
      name: 'somora-worker',
      description: 'somora background worker: answers one request without tools',
      promptMode: 'full',
      promptBody: args.systemPrompt,
      tools: ['search_tool'],
      discoverSkills: false,
      inheritSkills: false,
      agentsMd: false,
    };
    const created = await client.request('session/new', { cwd, mcpServers: [], _meta: { agentProfile: profile } }, Math.min(HANDSHAKE_TIMEOUT_MS, deadline()));
    sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId ?? null;
    if (created.error || !sessionId) throw new Error(client.lastError ?? `grok session/new failed: ${created.error?.message ?? 'no session id'}`);
    client.drain();
    logger.info({ msg: 'engine.grok_oneshot_request', ...logCtx, bin: launch.bin, chars: args.userMessage.length });

    const promptDone = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: args.userMessage }] }, deadline());
    let text = '';
    let apiError: string | null = null;
    let done = false;
    let usage: AcpUsage | undefined;
    void promptDone.then((f) => {
      done = true;
      const m = (f.result as { _meta?: { usage?: AcpUsage } } | undefined)?._meta;
      if (m?.usage) usage = m.usage;
      if (f.error) apiError ??= f.error.message;
    });
    while (!done) {
      const note = await client.next(250);
      if (note === null) {
        if (client.isClosed) break;
        continue;
      }
      const xu = (note.params as { update?: Record<string, unknown> }).update;
      if (note.method === 'session/update' && xu?.sessionUpdate === 'agent_message_chunk') {
        const t = (xu.content as { text?: string } | undefined)?.text;
        if (t) text += t;
      } else if (xu?.sessionUpdate === 'response_completed' && text && !text.endsWith('\n')) {
        // A second round (rare without tools) starts a new paragraph.
        text += '\n\n';
      } else if (xu?.sessionUpdate === 'retry_state' && xu.type === 'failed') {
        apiError = typeof xu.message === 'string' ? xu.message : 'grok reported a failed attempt';
      } else if (xu?.sessionUpdate === 'turn_completed' && xu.stop_reason === 'error') {
        if (typeof xu.agent_result === 'string' && xu.agent_result) apiError = xu.agent_result;
      }
    }
    await promptDone.catch(() => undefined);
    // Chunks that landed together with the answer.
    for (let note = await client.next(0); note; note = await client.next(0)) {
      const xu = (note.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update;
      if (note.method === 'session/update' && xu?.sessionUpdate === 'agent_message_chunk' && xu.content?.text) text += xu.content.text;
    }
    if (args.signal?.aborted) throw new Error('grok one-shot call aborted');
    text = text.trim();
    if (!text) {
      const why = apiError ?? (Date.now() - started >= args.timeoutMs ? `timed out after ${args.timeoutMs}ms` : client.lastError ?? 'no answer');
      throw new Error(`grok-cli one-shot call failed (model ${args.model.modelId}): ${why}`);
    }
    logger.info({ msg: 'engine.grok_oneshot_response', ...logCtx, durationMs: Date.now() - started, chars: text.length, tokensIn: usage?.inputTokens, tokensOut: usage?.outputTokens });
    return {
      text,
      ...(usage?.inputTokens !== undefined ? { tokensIn: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { tokensOut: usage.outputTokens } : {}),
    };
  } finally {
    args.signal?.removeEventListener('abort', onAbort);
    client.kill();
    if (sessionId) {
      const file = grokUpdatesFile(somoraGrokHome(), sessionId);
      if (file) {
        // Grok writes its files from a background task: let the process go first.
        for (let i = 0; i < 20 && !client.isClosed; i++) await new Promise((r) => setTimeout(r, 50));
        try {
          rmSync(dirname(file), { recursive: true, force: true });
          // Grok also appends every prompt, in full, to a history file per
          // working folder (up to 10,000 entries, no setting to stop it).
          // For a worker that is whole conversations copied again: gone.
          rmSync(join(dirname(dirname(file)), 'prompt_history.jsonl'), { force: true });
        } catch (err) {
          logger.warn({ msg: 'engine.grok_oneshot_cleanup_failed', ...logCtx, err: String(err) });
        }
      }
    }
  }
}
