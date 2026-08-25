// MCP-Hub: the ONE MCP client in the somora deployment (design:
// private/mcp-hub-design.md §4.1). Lives in the main server only. Holds
// a single long-lived connection per configured external server,
// discovers tools, and executes tools/call for every engine — the
// in-process registry dispatches here directly, the per-turn MCP child
// forwards here via POST /mcp/call.
//
// Lifecycle rules (ported from claude-code + hermes-agent + OpenClaw
// research, see design doc §1):
//   - lazy connect: nothing blocks server boot; first use (or an
//     explicit warmup call) connects.
//   - failure classification: permanent (auth, DNS, non-MCP endpoint,
//     missing env var) parks the server with a slow 5-min re-probe;
//     transient (network, timeout) gets jittered exponential backoff
//     with a circuit breaker (3 consecutive fails → 60s cooldown).
//   - keepalive: MCP ping on idle connections every 180s — idle HTTP
//     streams die silently otherwise (same lesson as the PTY-WS
//     heartbeat).
//   - HTTP 404 on a streamable-http call = expired MCP session. Recycle
//     the transport but NEVER replay the (possibly mutating) call —
//     re-throw and let the model retry (OpenClaw rule).
//   - calls are SERIAL per server unless the config opts into
//     supportsParallelToolCalls — many servers mishandle concurrency.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfig, McpServerConfig } from '../../config/types.ts';
import { logger } from '../../server/logger.ts';
import { argsHead, auditMcpCall } from './audit.ts';
import {
  applyMcpPreset,
  assertHasUrl,
  buildCredentialProvider,
  type CredentialProvider,
} from './credentials.ts';
import { expandEnvString, MissingEnvVarError } from './env-expand.ts';
import {
  buildToolNames,
  capDescription,
  normalizeInputSchema,
  sanitizeUnicodeDeep,
  scrubCredentials,
} from './normalize.ts';

export type McpServerState = 'pending' | 'connected' | 'failed' | 'needs-auth' | 'disabled';

export interface DiscoveredTool {
  /** Upstream name — what tools/call expects. */
  rawName: string;
  /** Model-visible name `mcp__<server>__<tool>`. */
  fullName: string;
  description: string;
  /** Normalized JSON Schema, safe to hand to any provider. */
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  state: McpServerState;
  toolCount: number;
  transport?: 'streamable-http' | 'sse';
  lastError?: string;
  lastConnectedAt?: number;
  consecutiveFailures: number;
}

/** Result of a hub call, shaped for easy mapping into ToolResult /
 *  MCP-child content arrays. */
export interface HubCallResult {
  isError: boolean;
  /** Concatenated text blocks (or stringified structuredContent). */
  text: string;
  /** Base64 images forwarded natively. */
  images: Array<{ data: string; mimeType: string }>;
}

const KEEPALIVE_INTERVAL_MS = 180_000;
const KEEPALIVE_SWEEP_MS = 60_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
const PARKED_REPROBE_MS = 300_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
/** Retry window after a LIVE connection drops (keepalive fail / upstream
 *  close). Short on purpose — the next 60s sweep picks it up. */
const RECONNECT_DELAY_MS = 5_000;

interface ServerRuntime {
  name: string;
  cfg: McpServerConfig;
  /** Resolved endpoint URL (after preset expansion). */
  url: string;
  /** Auth/header provider (static or self-refreshing OAuth). */
  credentials: CredentialProvider;
  state: McpServerState;
  client: Client | null;
  transportKind?: 'streamable-http' | 'sse';
  tools: DiscoveredTool[];
  lastError?: string;
  lastConnectedAt?: number;
  lastActivityAt: number;
  consecutiveFailures: number;
  /** Not before this timestamp may a new connect attempt start. */
  retryNotBefore: number;
  /** Permanent-failure park: reprobe slowly instead of backing off. */
  parked: boolean;
  /** In-flight connect, deduped. */
  connectPromise: Promise<void> | null;
  /** Serial-call chain (per-server, unless supportsParallelToolCalls). */
  callChain: Promise<unknown>;
}

function isPermanentError(err: unknown): boolean {
  // A missing env var (static-header auth) or an unrecoverable oauth
  // state (no refresh token, refresh rejected) can't get better on a
  // hot retry — park.
  if (err instanceof MissingEnvVarError) return true;
  const msg = String((err as Error)?.message ?? err);
  if (/re-login required|no refresh_token|credential file not found|credential key/i.test(msg)) {
    return true;
  }
  return (
    /\b(401|403)\b/.test(msg) ||
    /unauthorized|forbidden/i.test(msg) ||
    /ENOTFOUND|ERR_INVALID_URL/i.test(msg)
  );
}

function isAuthError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /\b401\b/.test(msg) || /unauthorized/i.test(msg);
}

function isSessionExpired(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  // Streamable-http servers invalidate expired MCP sessions with 404;
  // the SDK also maps JSON-RPC -32001 for it.
  return /\b404\b/.test(msg) || /-32001/.test(msg) || /session.*(expired|not found)/i.test(msg);
}

/** Transport-level failure mid-call. Streamable-http has no persistent
 *  socket whose onclose would tell us the peer died — a dead upstream
 *  surfaces ONLY as a failed POST. Without recycling here the server
 *  would stay `connected`-but-broken until the next keepalive sweep
 *  (worst case ~180s of failing calls). */
function isTransportError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|UND_ERR/i.test(msg);
}

export class McpHubManager {
  private servers = new Map<string, ServerRuntime>();
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private catalogListeners = new Set<() => void>();

  constructor(mcpConfig: McpConfig, opts?: { onCatalogChange?: () => void }) {
    if (opts?.onCatalogChange) this.catalogListeners.add(opts.onCatalogChange);
    for (const [name, rawCfg] of Object.entries(mcpConfig.servers)) {
      // Expand known-service presets (claude-design → url/auth/headers).
      const cfg = applyMcpPreset(name, rawCfg);
      let url: string;
      try {
        url = assertHasUrl(name, cfg);
      } catch (err) {
        logger.warn({ msg: 'mcp.hub.config_invalid', server: name, error: (err as Error).message });
        continue;
      }
      this.servers.set(name, {
        name,
        cfg,
        url,
        credentials: buildCredentialProvider(cfg),
        state: cfg.enabled ? 'pending' : 'disabled',
        client: null,
        tools: [],
        lastActivityAt: 0,
        consecutiveFailures: 0,
        retryNotBefore: 0,
        parked: false,
        connectPromise: null,
        callChain: Promise.resolve(),
      });
    }
    if ([...this.servers.values()].some((s) => s.state !== 'disabled')) {
      this.keepaliveTimer = setInterval(() => void this.keepaliveSweep(), KEEPALIVE_SWEEP_MS);
      this.keepaliveTimer.unref();
    }
  }

  get enabled(): boolean {
    return this.servers.size > 0;
  }

  serverNames(): string[] {
    return [...this.servers.keys()];
  }

  serverConfig(name: string): McpServerConfig | undefined {
    return this.servers.get(name)?.cfg;
  }

  /** Subscribe to catalog changes (connect/disconnect/listChanged).
   *  Used by the registry bridge and the catalog-snapshot writer. */
  addCatalogListener(fn: () => void): void {
    this.catalogListeners.add(fn);
  }

  private emitCatalogChange(): void {
    for (const fn of this.catalogListeners) {
      try {
        fn();
      } catch (err) {
        logger.warn({
          msg: 'mcp.hub.catalog_listener_threw',
          error: String((err as Error)?.message ?? err),
        });
      }
    }
  }

  /** Snapshot for /mcp/status and the catalog file. */
  status(): Record<string, McpServerStatus> {
    const out: Record<string, McpServerStatus> = {};
    for (const s of this.servers.values()) {
      out[s.name] = {
        state: s.state,
        toolCount: s.tools.length,
        ...(s.transportKind ? { transport: s.transportKind } : {}),
        ...(s.lastError ? { lastError: s.lastError } : {}),
        ...(s.lastConnectedAt ? { lastConnectedAt: s.lastConnectedAt } : {}),
        consecutiveFailures: s.consecutiveFailures,
      };
    }
    return out;
  }

  /** Discovered tools of all connected servers (for the registry bridge
   *  and the catalog snapshot). */
  connectedTools(): Map<string, DiscoveredTool[]> {
    const out = new Map<string, DiscoveredTool[]>();
    for (const s of this.servers.values()) {
      if (s.state === 'connected') out.set(s.name, s.tools);
    }
    return out;
  }

  /** Connect every enabled server (fire-and-forget warmup — used at boot
   *  so the catalog fills without blocking, and by tests). */
  warmup(): void {
    for (const s of this.servers.values()) {
      if (s.state === 'pending') {
        void this.ensureConnected(s.name).catch(() => {});
      }
    }
  }

  async reconnect(name: string): Promise<McpServerStatus> {
    const s = this.mustGet(name);
    if (s.state === 'disabled') throw new Error(`MCP server "${name}" is disabled in config`);
    await this.teardown(s, 'manual reconnect');
    s.parked = false;
    s.consecutiveFailures = 0;
    s.retryNotBefore = 0;
    s.state = 'pending';
    await this.ensureConnected(name).catch(() => {});
    return this.status()[name]!;
  }

  /**
   * Execute one upstream tool call. `rawName` is the upstream tool name.
   * Serial per server unless the config opts out. Timeout: per-call
   * override > per-server config.
   */
  async callTool(
    serverName: string,
    rawName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<HubCallResult> {
    const s = this.mustGet(serverName);
    const run = () => this.callToolInner(s, rawName, args, timeoutMs ?? s.cfg.timeoutMs);
    if (s.cfg.supportsParallelToolCalls) return run();
    const chained = s.callChain.then(run, run);
    // Keep the chain alive regardless of this call's outcome.
    s.callChain = chained.catch(() => {});
    return chained;
  }

  private async callToolInner(
    s: ServerRuntime,
    rawName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<HubCallResult> {
    await this.ensureConnected(s.name);
    if (s.state !== 'connected' || !s.client) {
      void auditMcpCall({
        ts: Date.now(),
        server: s.name,
        tool: rawName,
        args_head: argsHead(args),
        kind: 'server_unavailable',
        detail: `state=${s.state}${s.lastError ? ` (${s.lastError})` : ''}`,
      });
      throw new Error(
        `MCP server "${s.name}" is ${s.state}${s.lastError ? ` (${s.lastError})` : ''}`,
      );
    }
    const started = Date.now();
    try {
      const result = await s.client.callTool({ name: rawName, arguments: args }, undefined, {
        timeout: timeoutMs,
      });
      s.lastActivityAt = Date.now();
      s.consecutiveFailures = 0;
      logger.info({
        msg: 'mcp.hub.call',
        server: s.name,
        tool: rawName,
        ms: Date.now() - started,
        ok: result.isError !== true,
      });
      if (result.isError === true) {
        void auditMcpCall({
          ts: Date.now(),
          server: s.name,
          tool: rawName,
          args_head: argsHead(args),
          kind: 'is_error',
          detail: 'upstream tool reported isError',
          ms: Date.now() - started,
        });
      }
      return this.mapResult(result as Record<string, unknown>);
    } catch (err) {
      const scrubbed = scrubCredentials(String((err as Error)?.message ?? err));
      logger.warn({
        msg: 'mcp.hub.call_failed',
        server: s.name,
        tool: rawName,
        ms: Date.now() - started,
        error: scrubbed,
      });
      void auditMcpCall({
        ts: Date.now(),
        server: s.name,
        tool: rawName,
        args_head: argsHead(args),
        kind: 'call_failed',
        detail: scrubbed,
        ms: Date.now() - started,
      });
      if (isSessionExpired(err) || isTransportError(err)) {
        // Expired upstream session or dead transport: recycle so the
        // NEXT call gets a fresh handshake — but never replay this one.
        await this.teardown(s, isSessionExpired(err) ? 'session expired (404)' : 'transport error');
        s.state = 'pending';
        this.emitCatalogChange();
      }
      throw new Error(`MCP call ${s.name}/${rawName} failed: ${scrubbed}`);
    }
  }

  private mapResult(result: Record<string, unknown>): HubCallResult {
    const images: Array<{ data: string; mimeType: string }> = [];
    const texts: string[] = [];
    // Precedence per claude-code: structuredContent wins over content.
    if (result.structuredContent !== undefined) {
      texts.push(JSON.stringify(result.structuredContent, null, 2));
    } else if (Array.isArray(result.content)) {
      for (const block of result.content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        } else if (block.type === 'image' && typeof block.data === 'string') {
          images.push({ data: block.data, mimeType: String(block.mimeType ?? 'image/png') });
        } else if (block.type === 'resource' && typeof (block.resource as Record<string, unknown>)?.text === 'string') {
          const res = block.resource as Record<string, unknown>;
          texts.push(`[Resource ${String(res.uri ?? '')}] ${String(res.text)}`);
        } else if (block.type === 'resource_link') {
          texts.push(`[Resource link: ${String(block.name ?? '')}] ${String(block.uri ?? '')}`);
        }
        // Unknown block types (audio, blobs) are dropped in Phase 1 —
        // logged at discovery time via the server capabilities.
      }
    }
    return {
      isError: result.isError === true,
      text: texts.join('\n'),
      images,
    };
  }

  /** Deduped lazy connect. */
  ensureConnected(name: string): Promise<void> {
    const s = this.mustGet(name);
    if (s.state === 'connected') return Promise.resolve();
    if (s.state === 'disabled') return Promise.resolve();
    if (s.connectPromise) return s.connectPromise;
    const now = Date.now();
    if (now < s.retryNotBefore) {
      logger.debug({
        msg: 'mcp.hub.retry_skipped',
        server: s.name,
        state: s.state,
        retryInMs: s.retryNotBefore - now,
      });
      return Promise.resolve();
    }
    s.connectPromise = this.connectInner(s).finally(() => {
      s.connectPromise = null;
    });
    return s.connectPromise;
  }

  private async connectInner(s: ServerRuntime): Promise<void> {
    s.state = 'pending';
    try {
      const url = new URL(s.url);
      // Provider resolves auth+static headers fresh — an oauth-refresh
      // provider refreshes the token here if it's near expiry. Header
      // names are already lowercased by the provider (avoids duplicate
      // Authorization on the wire, OpenClaw lesson).
      const headers = await s.credentials.resolveHeaders();

      const { client, kind } = await this.handshake(s, url, headers);
      s.client = client;
      s.transportKind = kind;

      // listChanged only when the server declares the capability.
      const caps = client.getServerCapabilities();
      if (caps?.tools?.listChanged) {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          logger.info({ msg: 'mcp.hub.list_changed', server: s.name });
          try {
            s.tools = await this.discoverTools(s, client);
            this.emitCatalogChange();
          } catch (err) {
            logger.warn({
              msg: 'mcp.hub.list_changed_refetch_failed',
              server: s.name,
              error: scrubCredentials(String((err as Error)?.message ?? err)),
            });
          }
        });
      }
      client.onclose = () => {
        if (s.state === 'connected') {
          logger.warn({ msg: 'mcp.hub.connection_closed', server: s.name });
          this.scheduleReconnect(s);
          this.emitCatalogChange();
        }
      };

      s.tools = await this.discoverTools(s, client);
      s.state = 'connected';
      s.lastConnectedAt = Date.now();
      s.lastActivityAt = Date.now();
      s.consecutiveFailures = 0;
      s.parked = false;
      delete s.lastError;
      logger.info({
        msg: 'mcp.hub.connected',
        server: s.name,
        transport: kind,
        tools: s.tools.length,
      });
      this.emitCatalogChange();
    } catch (err) {
      const scrubbed = scrubCredentials(String((err as Error)?.message ?? err));
      s.client = null;
      s.consecutiveFailures += 1;
      s.lastError = scrubbed;
      const permanent = isPermanentError(err);
      s.state = permanent && isAuthError(err) ? 'needs-auth' : 'failed';
      if (permanent) {
        s.parked = true;
        s.retryNotBefore = Date.now() + PARKED_REPROBE_MS;
      } else {
        const backoff = Math.min(
          BACKOFF_BASE_MS * 2 ** Math.max(0, s.consecutiveFailures - 1),
          BACKOFF_CAP_MS,
        );
        const jitter = backoff * 0.2 * (Math.random() * 2 - 1);
        const cooldown =
          s.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD ? CIRCUIT_BREAKER_COOLDOWN_MS : 0;
        s.retryNotBefore = Date.now() + Math.max(backoff + jitter, cooldown);
      }
      logger.warn({
        msg: 'mcp.hub.connect_failed',
        server: s.name,
        state: s.state,
        permanent,
        failures: s.consecutiveFailures,
        error: scrubbed,
      });
      this.emitCatalogChange();
      throw err instanceof Error ? err : new Error(scrubbed);
    }
  }

  /** Streamable-http first, SSE-legacy fallback (result remembered via
   *  s.transportKind for the next reconnect). */
  private async handshake(
    s: ServerRuntime,
    url: URL,
    headers: Record<string, string>,
  ): Promise<{ client: Client; kind: 'streamable-http' | 'sse' }> {
    const mkClient = () =>
      new Client({ name: 'somora-mcp-hub', version: '1' }, { capabilities: {} });
    const order: Array<'streamable-http' | 'sse'> =
      s.transportKind === 'sse' ? ['sse'] : ['streamable-http', 'sse'];
    let lastErr: unknown;
    for (const kind of order) {
      const client = mkClient();
      try {
        const transport =
          kind === 'streamable-http'
            ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
            : new SSEClientTransport(url, { requestInit: { headers } });
        await withTimeout(
          client.connect(transport),
          s.cfg.connectTimeoutMs,
          `connect (${kind}) timed out after ${s.cfg.connectTimeoutMs}ms`,
        );
        return { client, kind };
      } catch (err) {
        lastErr = err;
        await client.close().catch(() => {});
        // Auth/permanent errors won't get better on the other transport.
        if (isPermanentError(err)) throw err;
      }
    }
    throw lastErr;
  }

  /** tools/list WITH pagination (claude-code gap: nextCursor never read
   *  → servers silently lose page 2+). Import hygiene per normalize.ts. */
  private async discoverTools(s: ServerRuntime, client: Client): Promise<DiscoveredTool[]> {
    const caps = client.getServerCapabilities();
    if (!caps?.tools) return [];
    const rawTools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      rawTools.push(...(page.tools as unknown as Array<Record<string, unknown>>));
      cursor = page.nextCursor;
    } while (cursor);

    const include = new Set(s.cfg.tools.include);
    const exclude = new Set(s.cfg.tools.exclude);
    const filtered = rawTools.filter((t) => {
      const n = String(t.name ?? '');
      if (exclude.has(n)) return false;
      if (include.size > 0 && !include.has(n)) return false;
      return true;
    });

    const names = buildToolNames(
      s.name,
      filtered.map((t) => String(t.name ?? '')),
    );
    for (const skip of names.skipped) {
      logger.warn({
        msg: 'mcp.hub.tool_skipped',
        server: s.name,
        tool: skip.rawName,
        reason: skip.reason,
      });
    }

    const out: DiscoveredTool[] = [];
    for (const named of names.accepted) {
      const raw = filtered.find((t) => t.name === named.rawName);
      if (!raw) continue;
      const sanitized = sanitizeUnicodeDeep(raw);
      const schema = normalizeInputSchema(sanitized.inputSchema);
      if (schema === null) {
        logger.warn({
          msg: 'mcp.hub.tool_skipped',
          server: s.name,
          tool: named.rawName,
          reason: 'input schema structurally unusable after normalization',
        });
        continue;
      }
      out.push({
        rawName: named.rawName,
        fullName: named.fullName,
        description: capDescription(
          typeof sanitized.description === 'string' ? sanitized.description : '',
        ),
        inputSchema: schema,
      });
    }
    logger.info({
      msg: 'mcp.hub.discovered',
      server: s.name,
      upstream: rawTools.length,
      imported: out.length,
      skipped: names.skipped.length,
    });
    return out;
  }

  private async keepaliveSweep(): Promise<void> {
    const now = Date.now();
    for (const s of this.servers.values()) {
      // Every enabled-but-disconnected server gets a reconnect attempt
      // once its backoff window elapses: parked ones on the slow
      // PARKED_REPROBE_MS cadence, failed ones on the exponential
      // backoff, and servers torn down by a failed keepalive / an
      // upstream close on the short scheduleReconnect() window. Before
      // 2026-08-25 only parked servers were re-probed here — a server
      // that lost its connection mid-life sat in `pending` until a
      // restart or a manual /mcp/servers/<name>/reconnect (parallel
      // stranded 47 min, claude-design 84 min after an OAuth expiry).
      if (s.state !== 'connected') {
        if (s.state !== 'disabled' && now >= s.retryNotBefore) {
          void this.ensureConnected(s.name).catch(() => {});
        }
        continue;
      }
      if (!s.client) continue;
      if (now - s.lastActivityAt < KEEPALIVE_INTERVAL_MS) continue;
      try {
        await s.client.ping();
        s.lastActivityAt = Date.now();
      } catch (err) {
        logger.warn({
          msg: 'mcp.hub.keepalive_failed',
          server: s.name,
          error: scrubCredentials(String((err as Error)?.message ?? err)),
        });
        await this.teardown(s, 'keepalive failed');
        this.scheduleReconnect(s);
        this.emitCatalogChange();
      }
    }
  }

  /** A live connection went away (keepalive ping failed, upstream
   *  closed the stream). Drop to `pending` and arm a SHORT retry window
   *  so the next sweep reconnects — this is not a connect failure, so
   *  the exponential backoff / park logic in connectInner doesn't apply
   *  yet; if the reconnect itself fails, connectInner takes over. */
  private scheduleReconnect(s: ServerRuntime): void {
    s.client = null;
    s.state = 'pending';
    s.parked = false;
    s.retryNotBefore = Date.now() + RECONNECT_DELAY_MS;
    logger.info({
      msg: 'mcp.hub.reconnect_scheduled',
      server: s.name,
      retryInMs: RECONNECT_DELAY_MS,
    });
  }

  private async teardown(s: ServerRuntime, reason: string): Promise<void> {
    if (s.client) {
      const c = s.client;
      s.client = null;
      c.onclose = undefined;
      await c.close().catch(() => {});
      logger.info({ msg: 'mcp.hub.teardown', server: s.name, reason });
    }
  }

  async shutdown(): Promise<void> {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    for (const s of this.servers.values()) {
      await this.teardown(s, 'shutdown');
      s.state = s.cfg.enabled ? 'pending' : 'disabled';
    }
  }

  private mustGet(name: string): ServerRuntime {
    const s = this.servers.get(name);
    if (!s) throw new Error(`unknown MCP server "${name}" (not in config.mcp.servers)`);
    return s;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    t.unref();
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
