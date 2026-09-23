// The language servers of this somora: one per (root, server), started
// when a builder first touches a matching file, stopped after ten idle
// minutes or at shutdown. `diagnosticsAfterWrite` is what file_write and
// file_patch call: send the new text, wait for the server's verdict on
// that file, return the errors — and the errors of other files whose
// verdict changed since the last delivery (a rename breaks its callers).

import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { logger } from '../server/logger.ts';
import { LspClient } from './client.ts';
import { formatFileErrors, MAX_OTHER_FILES, type LspDiagnostic } from './format.ts';
import { findBinary, rootFor, serverForFile, type LspServerDef } from './registry.ts';

export const LSP_IDLE_MS = 10 * 60_000;
export const LSP_DEBOUNCE_MS = 150;
const INIT_TIMEOUT_MS = 20_000;

export interface LspConfigLike {
  enabled: boolean;
  waitMs: number;
  servers: Record<string, { enabled?: boolean; command?: string }>;
}

interface Instance {
  key: string;
  def: LspServerDef;
  root: string;
  client: LspClient;
  ready: Promise<void>;
  docs: Map<string, number>; // uri -> version
  diags: Map<string, LspDiagnostic[]>; // uri -> latest
  /** Version of diags per uri that were already delivered to the model. */
  delivered: Map<string, string>;
  waiters: Set<(uri: string) => void>;
  lastUsed: number;
  firstDiagnosticsSeen: boolean;
}

export interface WriteDiagnostics {
  server: string;
  errors: string[];
  errors_in_other_files: Record<string, string[]>;
}

export class LspManager {
  private instances = new Map<string, Instance>();
  private broken = new Map<string, number>(); // key -> until (ms)
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly config: () => LspConfigLike) {}

  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000);
    this.sweeper.unref();
  }

  /** Pre-warm: start the server for this file in the background. */
  touch(workdir: string, file: string): void {
    void this.instanceFor(workdir, file).catch(() => undefined);
  }

  status(): Array<{ id: string; root: string; alive: boolean; docs: number; idleMs: number }> {
    return [...this.instances.values()].map((i) => ({ id: i.def.id, root: i.root, alive: i.client.alive, docs: i.docs.size, idleMs: Date.now() - i.lastUsed }));
  }

  async diagnosticsAfterWrite(workdir: string, file: string): Promise<WriteDiagnostics | null> {
    const inst = await this.instanceFor(workdir, file);
    if (!inst) return null;
    const uri = pathToFileURL(file).href;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return null;
    }
    const version = (inst.docs.get(uri) ?? 0) + 1;
    if (inst.docs.has(uri)) {
      inst.client.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    } else {
      inst.client.notify('textDocument/didOpen', { textDocument: { uri, languageId: inst.def.languageId(file), version, text } });
    }
    inst.docs.set(uri, version);
    inst.lastUsed = Date.now();
    const waitMs = inst.firstDiagnosticsSeen ? this.config().waitMs : Math.max(this.config().waitMs, inst.def.firstWaitMs);
    const got = await this.waitForDiagnostics(inst, uri, waitMs);
    if (!got) {
      logger.info({ msg: 'lsp.no_diagnostics_in_time', server: inst.def.id, file, waitMs });
      return null;
    }
    inst.firstDiagnosticsSeen = true;
    const own = formatFileErrors(inst.diags.get(uri) ?? []);
    inst.delivered.set(uri, own.join('\n'));
    const others: Record<string, string[]> = {};
    for (const [otherUri, diags] of inst.diags) {
      if (otherUri === uri) continue;
      const lines = formatFileErrors(diags, 5);
      const key = lines.join('\n');
      if (lines.length === 0 || inst.delivered.get(otherUri) === key) continue;
      inst.delivered.set(otherUri, key);
      let rel: string;
      try {
        rel = relative(workdir, fileURLToPath(otherUri));
      } catch {
        rel = otherUri;
      }
      others[rel] = lines;
      if (Object.keys(others).length >= MAX_OTHER_FILES) break;
    }
    return { server: inst.def.id, errors: own, errors_in_other_files: others };
  }

  async shutdownAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.instances.values()].map((i) => i.client.stop()));
    this.instances.clear();
  }

  private waitForDiagnostics(inst: Instance, uri: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settle: NodeJS.Timeout | null = null;
      const done = (ok: boolean) => {
        clearTimeout(timer);
        if (settle) clearTimeout(settle);
        inst.waiters.delete(onDiag);
        resolve(ok);
      };
      const onDiag = (u: string) => {
        if (u !== uri) return;
        // The server may publish twice (syntax, then semantics): settle briefly.
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => done(true), LSP_DEBOUNCE_MS);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      inst.waiters.add(onDiag);
    });
  }

  private async instanceFor(workdir: string, file: string): Promise<Instance | null> {
    const cfg = this.config();
    if (!cfg.enabled) return null;
    const def = serverForFile(file);
    if (!def) return null;
    const serverCfg = cfg.servers[def.id] ?? {};
    if (serverCfg.enabled === false) return null;
    const root = await rootFor(def, file, workdir);
    const key = `${def.id}:${root}`;
    const existing = this.instances.get(key);
    if (existing) {
      if (existing.client.alive) {
        await existing.ready;
        return existing;
      }
      this.instances.delete(key);
    }
    const until = this.broken.get(key);
    if (until && until > Date.now()) return null;
    const bin = await findBinary(def, serverCfg.command);
    if (!bin.command) {
      logger.debug({ msg: 'lsp.not_installed', server: def.id });
      this.broken.set(key, Date.now() + LSP_IDLE_MS);
      return null;
    }
    const client = new LspClient(def.id, bin.command, [...def.args], root);
    const inst: Instance = {
      key,
      def,
      root,
      client,
      ready: Promise.resolve(),
      docs: new Map(),
      diags: new Map(),
      delivered: new Map(),
      waiters: new Set(),
      lastUsed: Date.now(),
      firstDiagnosticsSeen: false,
    };
    client.onNotification('textDocument/publishDiagnostics', (params) => {
      const p = params as { uri: string; diagnostics: LspDiagnostic[] };
      if (!p?.uri) return;
      inst.diags.set(p.uri, Array.isArray(p.diagnostics) ? p.diagnostics : []);
      for (const w of inst.waiters) w(p.uri);
    });
    inst.ready = (async () => {
      client.start();
      const rootUri = pathToFileURL(root).href;
      await client.request(
        'initialize',
        {
          processId: process.pid,
          rootUri,
          rootPath: root,
          workspaceFolders: [{ uri: rootUri, name: root.split('/').pop() ?? root }],
          initializationOptions: def.initializationOptions?.(root) ?? {},
          capabilities: {
            workspace: { configuration: false, workspaceFolders: false },
            textDocument: {
              synchronization: { dynamicRegistration: false, didSave: true },
              publishDiagnostics: { relatedInformation: false, versionSupport: false },
            },
            general: { positionEncodings: ['utf-16'] },
          },
        },
        INIT_TIMEOUT_MS,
      );
      client.notify('initialized', {});
      if (def.settings) client.notify('workspace/didChangeConfiguration', { settings: def.settings(root) });
      logger.info({ msg: 'lsp.started', server: def.id, root, command: bin.command, source: bin.source });
    })();
    this.instances.set(key, inst);
    void client.exit.then(({ code, signal }) => {
      if (this.instances.get(key) === inst) this.instances.delete(key);
      logger.info({ msg: 'lsp.exited', server: def.id, root, code, signal });
    });
    try {
      await inst.ready;
    } catch (err) {
      logger.warn({ msg: 'lsp.init_failed', server: def.id, root, err: (err as Error).message });
      this.instances.delete(key);
      this.broken.set(key, Date.now() + LSP_IDLE_MS);
      client.kill();
      return null;
    }
    return inst;
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [key, inst] of this.instances) {
      if (now - inst.lastUsed < LSP_IDLE_MS) continue;
      this.instances.delete(key);
      logger.info({ msg: 'lsp.idle_stop', server: inst.def.id, root: inst.root });
      await inst.client.stop();
    }
  }
}
