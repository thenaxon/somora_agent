// The live ACP connection to one external agent for one somora session:
// the agent process (local or over ssh), the ACP client on top, and the
// agent's session id. Kept warm between prompts and closed after
// `external.idleMinutes`; a dead process is started again on the next
// prompt and the agent's session is resumed.

import { homedir } from 'node:os';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ContentBlock,
  type Implementation,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { Config } from '../config/types.ts';
import { profileByName, profileFor, type AcpProfile } from '../acp/profiles.ts';
import { getResourceHome } from '../ssh/pool.ts';
import { logger } from '../server/logger.ts';
import { SOMORA_VERSION } from '../version.ts';
import type { ExternalAgent } from './registry.ts';
import { startAgentProcess, type AgentProcess } from './transport.ts';

const INIT_TIMEOUT_MS = 60_000;

export interface PromptHandlers {
  onUpdate(update: SessionUpdate): void;
  onPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

/** What the connection learned about the agent; shown in the UI. */
export interface ExternalAgentInfo {
  agentInfo: Implementation | null;
  capabilities: AgentCapabilities | null;
  profile: AcpProfile;
  where: string;
}

/** When the agent goes away, the ACP connection notices a moment before
 *  the process exit is in: wait briefly for it, so the message carries
 *  the real reason (exit code, what it wrote to stderr). */
async function settleExit(proc: AgentProcess, ms = 800): Promise<void> {
  await Promise.race([proc.exited, new Promise((r) => setTimeout(r, ms))]);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer within ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** The same agent, started the same way — a running connection can be reused. */
function fingerprint(ext: ExternalAgent): string {
  return JSON.stringify([ext.systemConfig.transport, ext.agent.command, ext.agent.cwd ?? '', ext.systemConfig.profile ?? '']);
}

/** Where updates go that arrive between turns: something the agent sends
 *  on its own (a sub-task's result, a reminder). Set by the server
 *  (src/external/unprompted.ts); without it they are dropped as before. */
type UnpromptedSink = (ext: ExternalAgent, session: string, update: SessionUpdate) => void;
let unpromptedSink: UnpromptedSink | null = null;
export function setUnpromptedSink(sink: UnpromptedSink | null, opts: { graceMs?: number } = {}): void {
  unpromptedSink = sink;
  afterTurnGraceMs = opts.graceMs ?? AFTER_TURN_GRACE_MS;
}

/** Updates in the first moments after a turn belong to that turn (Hermes
 *  sends a last piece after a cancel), not to a new message. */
const AFTER_TURN_GRACE_MS = 3_000;
let afterTurnGraceMs = AFTER_TURN_GRACE_MS;

export class ExternalConnection {
  private handlers: PromptHandlers | null = null;
  private turnEndedAt = 0;
  /** The somora session this connection serves. */
  somoraSession = '';
  /** While `session/load` replays history, its updates are not a turn. */
  private replaying = false;
  private dead: string | null = null;
  /** close() was called: what still arrives is not shown. */
  private closed = false;
  /** Prompts and session setups running now: the idle sweeper leaves a
   *  connection in use alone, however long its turn takes. */
  private busy = 0;
  /** The session setup running now: the next waits for it (a setup a
   *  stopped turn left behind still finishes in the background). */
  private settingUp: Promise<unknown> = Promise.resolve();
  info: ExternalAgentInfo;
  sessionId: string | null = null;
  readonly fingerprint: string;
  /** Last activity: a turn's end, an update from the agent. */
  lastUsed = Date.now();

  private constructor(
    readonly ext: ExternalAgent,
    private readonly proc: AgentProcess,
    private readonly conn: ClientSideConnection,
  ) {
    this.fingerprint = fingerprint(ext);
    this.info = { agentInfo: null, capabilities: null, profile: profileByName(ext.systemConfig.profile ?? 'generic'), where: proc.where };
    void proc.exited.then(({ code, signal }) => {
      const tail = proc.stderrTail();
      this.dead = `the external agent's process ended (${signal ? `signal ${signal}` : `exit ${code}`})${tail ? `: ${tail.split('\n').slice(-3).join(' | ').slice(0, 400)}` : ''}`;
      logger.info({ msg: 'external.exit', agent: ext.name, system: ext.system, where: proc.where, code, signal, stderr: tail.slice(-800) });
    });
  }

  get alive(): boolean {
    return this.dead === null && !this.conn.signal.aborted;
  }

  get inUse(): boolean {
    return this.busy > 0;
  }

  get deathReason(): string | null {
    return this.dead ?? (this.conn.signal.aborted ? 'the ACP connection closed' : null);
  }

  /** Start the agent's command and introduce ourselves. */
  static async open(ext: ExternalAgent, config: Config): Promise<ExternalConnection> {
    const started = Date.now();
    const proc = await startAgentProcess(ext.systemConfig.transport, ext.agent.command, config);
    let self: ExternalConnection | null = null;
    const stream = ndJsonStream(proc.input, proc.output);
    const conn = new ClientSideConnection(
      () => ({
        sessionUpdate: async (p) => {
          if (!self || self.replaying || self.closed) return;
          if (self.sessionId && p.sessionId !== self.sessionId) return;
          if (self.handlers) {
            self.lastUsed = Date.now();
            self.handlers.onUpdate(p.update);
            return;
          }
          if (Date.now() - self.turnEndedAt < afterTurnGraceMs || !self.somoraSession) return;
          self.lastUsed = Date.now();
          unpromptedSink?.(self.ext, self.somoraSession, p.update);
        },
        requestPermission: async (p) => {
          if (!self?.handlers) return { outcome: { outcome: 'cancelled' } };
          return self.handlers.onPermission(p);
        },
        // somora offers no file system and no terminal to an external agent.
        readTextFile: async () => {
          throw new Error('somora does not offer file access to external agents');
        },
        writeTextFile: async () => {
          throw new Error('somora does not offer file access to external agents');
        },
      }),
      stream,
    );
    self = new ExternalConnection(ext, proc, conn);
    try {
      const init = await withTimeout(
        Promise.race([
          conn.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'somora', title: 'somora', version: SOMORA_VERSION },
          }),
          proc.exited.then(() => {
            throw new Error(self!.deathReason ?? 'the external agent ended before it answered');
          }),
        ]),
        INIT_TIMEOUT_MS,
        'initialize',
      );
      const profile = ext.systemConfig.profile ? profileByName(ext.systemConfig.profile) : profileFor(init.agentInfo);
      self.info = { agentInfo: init.agentInfo ?? null, capabilities: init.agentCapabilities ?? null, profile, where: proc.where };
      logger.info({
        msg: 'external.initialized',
        agent: ext.name,
        system: ext.system,
        where: proc.where,
        agentInfo: init.agentInfo,
        profile: profile.name,
        protocolVersion: init.protocolVersion,
        ms: Date.now() - started,
      });
      return self;
    } catch (err) {
      await settleExit(proc);
      proc.stop();
      throw new Error(`${ext.name} (${ext.system}, ${proc.where}): ${self.deathReason ?? (err as Error).message}`);
    }
  }

  private async defaultCwd(config: Config): Promise<string> {
    if (this.ext.agent.cwd) return this.ext.agent.cwd;
    const t = this.ext.systemConfig.transport;
    if ('local' in t) return homedir();
    const resource = config.resources[t.resource];
    return resource ? getResourceHome(t.resource, resource) : '/';
  }

  /**
   * Make `known` the agent's current session again (resume, else load),
   * or start a new one. Returns the session id and whether it is new.
   */
  async ensureSession(known: string | undefined, config: Config): Promise<{ sessionId: string; started: boolean; lostPrevious: boolean }> {
    this.busy += 1;
    const run = this.settingUp.catch(() => {}).then(() => this.setUpSession(known, config));
    this.settingUp = run;
    try {
      return await run;
    } finally {
      this.busy -= 1;
      this.lastUsed = Date.now();
    }
  }

  private async setUpSession(known: string | undefined, config: Config): Promise<{ sessionId: string; started: boolean; lostPrevious: boolean }> {
    // The connection belongs to one somora session (closed on its reset):
    // the session it has is that one's, also when the id was not stored
    // yet (a stopped turn's setup finished in the background).
    if (this.sessionId && (this.sessionId === known || known === undefined)) return { sessionId: this.sessionId, started: false, lostPrevious: false };
    const cwd = await this.defaultCwd(config);
    const caps = this.info.capabilities;
    if (known) {
      try {
        if (caps?.sessionCapabilities?.resume) {
          await withTimeout(this.conn.resumeSession({ sessionId: known, cwd, mcpServers: [] }), INIT_TIMEOUT_MS, 'session/resume');
          this.sessionId = known;
          return { sessionId: known, started: false, lostPrevious: false };
        }
        if (caps?.loadSession) {
          this.replaying = true;
          this.sessionId = known;
          try {
            await withTimeout(this.conn.loadSession({ sessionId: known, cwd, mcpServers: [] }), INIT_TIMEOUT_MS, 'session/load');
          } finally {
            this.replaying = false;
          }
          return { sessionId: known, started: false, lostPrevious: false };
        }
      } catch (err) {
        logger.warn({ msg: 'external.resume_failed', agent: this.ext.name, sessionId: known, err: (err as Error).message });
      }
    }
    const res = await withTimeout(this.conn.newSession({ cwd, mcpServers: [] }), INIT_TIMEOUT_MS, 'session/new');
    this.sessionId = res.sessionId;
    logger.info({ msg: 'external.session_new', agent: this.ext.name, sessionId: res.sessionId, replaced: known ?? null });
    return { sessionId: res.sessionId, started: true, lostPrevious: Boolean(known) };
  }

  /** One prompt. `signal` cancels it (ACP `session/cancel`); a signal
   *  already aborted sends nothing. */
  async prompt(blocks: ContentBlock[], handlers: PromptHandlers, signal?: AbortSignal): Promise<PromptResponse> {
    if (!this.sessionId) throw new Error('no session');
    if (!this.alive) throw new Error(this.deathReason ?? 'the external agent is gone');
    if (signal?.aborted) return { stopReason: 'cancelled' };
    this.handlers = handlers;
    this.busy += 1;
    this.lastUsed = Date.now();
    const sessionId = this.sessionId;
    const onAbort = () => {
      void this.conn.cancel({ sessionId }).catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([
        this.conn.prompt({ sessionId, prompt: blocks }),
        this.proc.exited.then(() => {
          throw new Error(this.deathReason ?? 'the external agent ended during the turn');
        }),
      ]);
    } catch (err) {
      if (signal?.aborted) throw err;
      await settleExit(this.proc);
      throw new Error(this.dead ?? (err as Error).message);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.handlers = null;
      this.busy -= 1;
      this.turnEndedAt = Date.now();
      this.lastUsed = Date.now();
    }
  }

  close(): void {
    this.closed = true;
    this.proc.stop();
  }
}

// ── one connection per (agent, somora session) ──────────────────────

const connections = new Map<string, ExternalConnection>();
const opening = new Map<string, Promise<ExternalConnection>>();
const key = (agent: string, session: string) => `${agent}/${session}`;
let sweeper: NodeJS.Timeout | null = null;

function ensureSweeper(config: () => Config): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepExternal(config().external.idleMinutes * 60_000), 30_000);
  sweeper.unref();
}

/** Close dead connections and those unused for `idleMs`. A connection
 *  with a turn or a session setup running is in use, not idle: a turn
 *  may take longer than idleMinutes (a long task, a permission question
 *  waiting for the person). Exported for tests. */
export function sweepExternal(idleMs: number, now = Date.now()): void {
  for (const [k, c] of connections) {
    if (c.alive && (c.inUse || now - c.lastUsed <= idleMs)) continue;
    connections.delete(k);
    logger.info({ msg: 'external.closed', agent: c.ext.name, reason: c.alive ? 'idle' : 'dead' });
    c.close();
  }
}

/** The live connection for this agent and session, opened when needed. */
export async function connectionFor(ext: ExternalAgent, session: string, config: () => Config): Promise<ExternalConnection> {
  ensureSweeper(config);
  const k = key(ext.name, session);
  const have = connections.get(k);
  if (have && have.alive && have.fingerprint === fingerprint(ext)) return have;
  if (have) {
    connections.delete(k);
    have.close();
  }
  const pending = opening.get(k);
  if (pending) return pending;
  const p = ExternalConnection.open(ext, config())
    .then((c) => {
      c.somoraSession = session;
      connections.set(k, c);
      return c;
    })
    .finally(() => opening.delete(k));
  opening.set(k, p);
  return p;
}

/** What is known about an agent from any of its open connections. */
export function knownInfo(agent: string): ExternalAgentInfo | null {
  for (const c of connections.values()) if (c.ext.name === agent) return c.info;
  return lastInfo.get(agent) ?? null;
}
const lastInfo = new Map<string, ExternalAgentInfo>();
export function rememberInfo(agent: string, info: ExternalAgentInfo): void {
  lastInfo.set(agent, info);
}

/** Close every connection (server shutdown, tests). */
export function closeAllExternal(): void {
  for (const c of connections.values()) c.close();
  connections.clear();
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/** Close one session's connection (archive, delete). */
export function closeExternal(agent: string, session: string): void {
  const k = key(agent, session);
  const c = connections.get(k);
  if (c) {
    connections.delete(k);
    c.close();
  }
}

/** Close every connection of one agent and carry what it said about
 *  itself over to `renamedTo` (agent rename, docs/agents.md). */
export function closeAgentConnections(agent: string, renamedTo?: string): void {
  for (const [k, c] of [...connections]) {
    if (c.ext.name !== agent) continue;
    connections.delete(k);
    c.close();
  }
  const info = lastInfo.get(agent);
  if (info && renamedTo) lastInfo.set(renamedTo, info);
  if (renamedTo) lastInfo.delete(agent);
}

/** For GET /external: open connections per agent. */
export function connectionSnapshot(): Array<{ agent: string; system: string; sessionId: string | null; where: string; idleMs: number }> {
  return [...connections.values()].map((c) => ({ agent: c.ext.name, system: c.ext.system, sessionId: c.sessionId, where: c.info.where, idleMs: Date.now() - c.lastUsed }));
}
