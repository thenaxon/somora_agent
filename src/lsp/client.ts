// A minimal Language Server Protocol client over stdio.
//
// JSON-RPC 2.0 with the LSP base-protocol framing (`Content-Length:`
// header, blank line, JSON body). About a hundred lines — no dependency,
// no capability we would not use. The manager (manager.ts) owns the
// lifecycle; this file only speaks the wire protocol.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../server/logger.ts';

export interface RpcError {
  code: number;
  message: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (params: unknown) => void>();
  private exited = false;
  /** Resolves when the process ends, with its exit code or signal. */
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private resolveExit!: (v: { code: number | null; signal: NodeJS.Signals | null }) => void;

  constructor(
    readonly label: string,
    readonly command: string,
    readonly args: string[],
    readonly cwd: string,
  ) {
    this.exit = new Promise((r) => {
      this.resolveExit = r;
    });
  }

  get alive(): boolean {
    return this.proc !== null && !this.exited;
  }

  start(): void {
    const proc = spawn(this.command, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) logger.debug({ msg: 'lsp.stderr', server: this.label, text: text.slice(0, 400) });
    });
    proc.on('error', (err) => {
      logger.warn({ msg: 'lsp.spawn_error', server: this.label, command: this.command, err: err.message });
      this.failAll(new Error(`language server '${this.label}' could not start: ${err.message}`));
    });
    proc.on('exit', (code, signal) => {
      this.exited = true;
      this.failAll(new Error(`language server '${this.label}' exited (${code ?? signal})`));
      this.resolveExit({ code, signal });
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.handlers.set(method, handler);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`language server '${this.label}': ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Polite stop: shutdown request, exit notification, then SIGTERM after a grace period. */
  async stop(graceMs = 2000): Promise<void> {
    if (!this.proc || this.exited) return;
    try {
      await this.request('shutdown', null, graceMs);
      this.notify('exit', null);
    } catch {
      /* the kill below handles it */
    }
    const killer = setTimeout(() => {
      if (!this.exited) this.proc?.kill('SIGTERM');
    }, graceMs);
    await this.exit;
    clearTimeout(killer);
  }

  kill(): void {
    if (this.proc && !this.exited) this.proc.kill('SIGKILL');
  }

  private send(msg: unknown): void {
    if (!this.proc || this.exited) throw new Error(`language server '${this.label}' is not running`);
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseFrame(this.buffer);
      if (!parsed) return;
      this.buffer = this.buffer.subarray(parsed.consumed);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(parsed.body) as Record<string, unknown>;
      } catch {
        logger.warn({ msg: 'lsp.bad_json', server: this.label, head: parsed.body.slice(0, 120) });
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as RpcError;
        p.reject(new Error(`language server '${this.label}': ${e.message} (${e.code})`));
      } else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        // A request from the server (workspace/configuration, client/registerCapability,
        // window/workDoneProgress/create): answer so it never waits on us.
        const method = msg.method;
        const result =
          method === 'workspace/configuration' ? ((msg.params as { items?: unknown[] })?.items ?? []).map(() => null) : null;
        this.send({ jsonrpc: '2.0', id: msg.id, result });
        return;
      }
      const h = this.handlers.get(msg.method);
      if (h) {
        try {
          h(msg.params);
        } catch (err) {
          logger.warn({ msg: 'lsp.handler_failed', server: this.label, method: msg.method, err: (err as Error).message });
        }
      }
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

/** One framed message from the front of `buf`, or null when incomplete. */
export function parseFrame(buf: Buffer): { body: string; consumed: number } | null {
  const headerEnd = buf.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const header = buf.subarray(0, headerEnd).toString('ascii');
  const m = /Content-Length:\s*(\d+)/i.exec(header);
  if (!m) {
    // Unknown header block: skip it rather than hang forever.
    return { body: '', consumed: headerEnd + 4 };
  }
  const length = Number(m[1]);
  const start = headerEnd + 4;
  if (buf.length < start + length) return null;
  return { body: buf.subarray(start, start + length).toString('utf8'), consumed: start + length };
}
