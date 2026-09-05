// JSON-RPC 2.0 client for `codex app-server --listen stdio://`.
//
// One process per somora turn (design: private/codex-app-server-design.md
// §3.1). Newline-delimited JSON on stdout/stdin; stderr is Codex's
// diagnostics channel and only kept as a bounded tail for error messages.
//
// Three message shapes arrive on stdout:
//   - responses  {id, result|error}            → settle a pending request
//   - requests   {id, method, params}          → server→client (item/tool/call,
//                                                approval prompts); answered via
//                                                the onServerRequest handler
//   - notifications {method, params}           → onNotification
//
// The client knows nothing about threads or turns — the engine adapter
// (codex-cli.ts) and the compaction summariser drive it.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '../server/logger.ts';
import { SOMORA_VERSION } from '../version.ts';

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export type CodexServerRequestHandler = (req: CodexServerRequest) => Promise<unknown>;
export type CodexNotificationHandler = (method: string, params: unknown) => void;

export interface CodexAppServerStartOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onNotification: CodexNotificationHandler;
  onServerRequest: CodexServerRequestHandler;
  /** Log context (agent/session) merged into every log line. */
  logCtx?: Record<string, unknown>;
  /** initialize round-trip budget. */
  initTimeoutMs?: number;
}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CodexRpcError';
  }
}

const STDERR_TAIL_MAX = 4000;
const KILL_GRACE_MS = 2_000;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTailBuf = '';
  private closed = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly exitWaiters: Array<() => void> = [];
  private readonly logCtx: Record<string, unknown>;

  private constructor(
    private readonly child: ChildProcess,
    private readonly opts: CodexAppServerStartOptions,
  ) {
    this.logCtx = opts.logCtx ?? {};
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this.handleLine(line));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => {
      this.stderrTailBuf = (this.stderrTailBuf + text).slice(-STDERR_TAIL_MAX);
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      this.closed = true;
      const err = new Error(
        `codex app-server exited (code ${code}, signal ${signal ?? 'none'})${this.stderrHint()}`,
      );
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      for (const w of this.exitWaiters.splice(0)) w();
    });
    child.on('error', (err) => {
      logger.error({ msg: 'engine.codex_app_server_spawn_error', ...this.logCtx, err: err.message });
    });
  }

  /** Spawn the process and complete the initialize handshake. */
  static async start(opts: CodexAppServerStartOptions): Promise<CodexAppServerClient> {
    const child = spawn(opts.command, opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    const client = new CodexAppServerClient(child, opts);
    const spawnFailed = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(new Error(`codex app-server spawn failed: ${err.message}`)));
    });
    const init = client.request(
      'initialize',
      {
        clientInfo: { name: 'somora', title: 'somora', version: SOMORA_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
      { timeoutMs: opts.initTimeoutMs ?? 30_000 },
    );
    const result = (await Promise.race([init, spawnFailed])) as { userAgent?: string; codexHome?: string };
    client.notify('initialized', undefined);
    logger.debug({
      msg: 'engine.codex_app_server_initialized',
      ...client.logCtx,
      userAgent: result?.userAgent,
      codexHome: result?.codexHome,
    });
    return client;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get stderrTail(): string {
    return this.stderrTailBuf;
  }

  private stderrHint(): string {
    const t = this.stderrTailBuf.trim();
    return t ? `: ${t.slice(-600)}` : '';
  }

  request<T = unknown>(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`codex app-server already closed (${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        method,
        resolve: (v) => resolve(v as T),
        reject,
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`codex app-server request timed out after ${opts.timeoutMs}ms (${method})`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch (err) {
      logger.warn({ msg: 'engine.codex_app_server_write_failed', ...this.logCtx, err: String(err) });
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string; data?: unknown };
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      logger.warn({ msg: 'engine.codex_app_server_nonjson', ...this.logCtx, line: trimmed.slice(0, 200) });
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (!p) {
        logger.debug({ msg: 'engine.codex_app_server_orphan_response', ...this.logCtx, id: msg.id });
        return;
      }
      this.pending.delete(msg.id as number);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        p.reject(
          new CodexRpcError(p.method, msg.error.code, msg.error.message ?? 'unknown error', msg.error.data),
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      const req: CodexServerRequest = { id: msg.id, method: msg.method, params: msg.params };
      void this.opts
        .onServerRequest(req)
        .then((result) => this.respond(req.id, result ?? {}))
        .catch((err: unknown) => {
          logger.error({
            msg: 'engine.codex_app_server_request_handler_failed',
            ...this.logCtx,
            method: req.method,
            err: String(err),
          });
          this.respondError(req.id, -32000, (err as Error).message ?? String(err));
        });
      return;
    }
    if (msg.method) {
      try {
        this.opts.onNotification(msg.method, msg.params);
      } catch (err) {
        logger.warn({
          msg: 'engine.codex_app_server_notification_handler_failed',
          ...this.logCtx,
          method: msg.method,
          err: String(err),
        });
      }
    }
  }

  /** Resolves when the process has exited. */
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => {
      this.exitWaiters.push(() => resolve(this.exitInfo!));
    });
  }

  /** SIGTERM now, SIGKILL if still alive after the grace period. */
  close(): void {
    if (this.exitInfo) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (!this.exitInfo) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, KILL_GRACE_MS).unref();
  }
}
