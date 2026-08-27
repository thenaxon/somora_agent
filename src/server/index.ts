import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSEH2Safe } from './sse-h2-safe.ts';
import { bridgeMcpTools } from '../mcp/hub/bridge.ts';
import { writeCatalog } from '../mcp/hub/catalog.ts';
import { McpHubManager } from '../mcp/hub/manager.ts';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSecureServer as createHttp2SecureServer } from 'node:http2';
import {
  homedir,
  cpus as osCpus,
  freemem as osFreemem,
  loadavg as osLoadavg,
  totalmem as osTotalmem,
} from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { WebSocketServer } from 'ws';
import { applyClaudeCliSdkEnv, applyCodexCliEnv, configPath, loadConfig } from '../config/loader.ts';
import { workerChain, type Config, resolveAnyRef, type ThinkingLevel } from '../config/types.ts';
import { storeAttachment } from '../attachments/store.ts';
import { generateImage, ImageGenError } from '../imagegen/generate.ts';
import { referenceFromBase64 } from '../imagegen/references.ts';
import {
  listCatalogModels as listImageCatalogModels,
  resolveCapabilities as resolveImageCapabilities,
} from '../imagegen/capabilities.ts';
import {
  deleteRecord as deleteImageRecord,
  listRecords as listImageRecords,
  readRecord as readImageRecord,
  totalBytes as imageTotalBytes,
} from '../imagegen/records.ts';
import { detectMimeFromPath } from '../multimodal/mime.ts';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile, stat as statFs, readFile as readFileFs } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { checkReadAllowed, expandHome, realpathSafeAncestor } from '../tools/file/policy.ts';
import {
  buildTree,
  extractLinkTargets,
  getPage,
  getWikiIndex,
  globalGraph,
  invalidateWikiIndex,
  localGraph,
  readPageContent,
  resolveLinkTargets,
} from '../wiki/explorer.ts';
import { listTmuxSessions } from '../tmux/list.ts';
import {
  ensureMemoryDirs,
  getMemoryManager,
  shutdownMemoryRegistry,
} from '../memory/registry.ts';
import { setupClaudeConfigDir } from './claude-config-dir.ts';
import { paginateHistory } from './history-page.ts';
import {
  configureClaudeCredentialSync,
  credentialSyncStatus,
  reconcileClaudeCredentials,
  startClaudeCredentialSyncWatcher,
  stopClaudeCredentialSyncWatcher,
} from './claude-credential-sync.ts';
import { getEffectiveEnv } from './env.ts';
import { loadSomoraEnvFile } from './env-file.ts';
import { SOMORA_HOME_DIR } from './logger.ts';
import { shortToolName } from './tool-format.ts';
import { ensureWorkspaceDirs } from './workspace.ts';
import {
  ensureDefaultAgent,
  listAgents,
  loadPersona,
  type Persona,
} from '../persona/loader.ts';
import {
  createSession,
  getHistory,
  listSessions,
  archiveSession,
  unarchiveSession,
  resetSession,
  resolveSessionId,
  sessionMetaStore,
} from '../storage/sessions.ts';
import { configureLongTaskTimeouts } from '../tools/agents/long-task-timeouts.ts';
import { focusProject } from '../projects/focus.ts';
import {
  listProjects,
  projectExists,
  readProject,
  writeProject,
} from '../projects/store.ts';
import { validatePathRef } from '../projects/scheme.ts';
import { PROJECT_SLUG_RE, ProjectFrontmatterSchema } from '../projects/types.ts';
import { seedBuiltinSkills } from '../skills/bootstrap.ts';
import * as sentinelStore from '../sentinel/store.ts';
import * as sentinelSchedule from '../sentinel/schedule.ts';
import * as sentinelScheduler from '../sentinel/scheduler.ts';
import { configureSentinel, startSentinel } from '../sentinel/scheduler.ts';
import {
  configureTmuxAttention,
  startTmuxAttentionWatcher,
} from '../tmux/attention-watcher.ts';
import { writeAttentionMirror } from '../tmux/attention.ts';
import { cacheFileStat, negotiateFormat, synthesize } from '../tts/service.ts';
import { installTtsCacheGc } from '../tts/cache-gc.ts';
import { prepareForTts } from '../tts/prepare-for-tts.ts';
import { appendEvent } from '../storage/sessions.ts';
import {
  markSeen,
  subscribeActivity,
  tapPublish,
} from './activity-stream.ts';
import {
  configureDreamRunTool,
  configureExecConcurrencyCaps,
  configureSpawnTools,
  logExecCaps,
  recoverOrphanedJobs,
  registerAllTools,
  ToolRegistry,
} from '../tools/index.ts';
import type { ToolContext } from '../tools/types.ts';
import { isToolAllowed } from '../tools/gating.ts';
import { writeAgentToolGating } from '../persona/tool-gating-store.ts';
import { shutdownSshPool } from '../ssh/index.ts';
import {
  archiveEmptyCompletedDreams,
  consolidateStalePausedDreams,
  listDreams,
  recoverOrphanRunningDreams,
} from '../dream/storage.ts';
import { runDream } from '../dream/rem-runner.ts';
import { RemWorker } from '../dream/rem-worker.ts';
import { DeepWorker } from '../dream/deep-worker.ts';
import { LucidWorker } from '../dream/lucid-worker.ts';
import { getLoopState, setMaxWikiCallsPerTurn } from '../dream/loop-state.ts';
import { pendingLucidSummary } from '../dream/lucid-storage.ts';
import { resolveObsidianSource } from '../memory/registry.ts';
import type { SseEvent } from '../types/events.ts';
import { logger } from './logger.ts';
import { runChatTurn } from './run-turn.ts';
import { registerChatAbort, triggerChatAbort } from './chat-aborts.ts';
import { acquireSessionLock, listAllSessionLockStates } from './session-queue.ts';
import { findWaitCycle, registerWait } from './ask-wait-graph.ts';
import { readLockfile } from './lockfile.ts';
import { acquireLockfile, LockfileBusy, releaseLockfile } from './lockfile.ts';
import { SOMORA_VERSION } from '../version.ts';
import {
  cancelTaskCascade,
  completeTask,
  configureSubagentAttention,
  failTask,
  getTask,
  listTasksForAgent,
  markResultFetched,
  newTaskId,
  registerTask,
  waitForTaskCompletion,
} from './async-tasks.ts';
import { reserveSpawnSlot, releaseSpawnSlot } from '../tools/agents/spawn.ts';
import { readSessionJsonlRaw, renderSessionMarkdown } from './session-export.ts';

type Subscriber = (e: SseEvent) => Promise<void>;
interface StreamSub {
  send: Subscriber;
  /** Called when publish() evicts this subscriber (write timeout /
   *  error). MUST tear the underlying HTTP stream down — before this
   *  hook existed, eviction only removed the callback from the set
   *  while the per-connection heartbeat kept flowing, so the client
   *  looked healthy but silently received no more events until a
   *  manual reload (Juni-Audit 2026-06). Closing the stream gives the
   *  client a clean EOF and its auto-reconnect kicks in. */
  evict: () => void;
}
const streams = new Map<string, Set<StreamSub>>();

/**
 * Compose the pubsub key from (agent, session). Every persona has a
 * `main` session by default, so keying by session-id alone caused
 * cross-agent leaks for any client that opened multiple SSE
 * subscriptions in parallel — observed in the web client with
 * multiple chat windows: events for one agent's main session arrived
 * in another agent's main stream because both subscribed to bare
 * "main".
 */
function streamKey(agent: string, session: string): string {
  return `${agent}::${session}`;
}

function subscribe(
  agent: string,
  session: string,
  sub: Subscriber,
  evict: () => void,
): () => void {
  const key = streamKey(agent, session);
  let set = streams.get(key);
  if (!set) {
    set = new Set();
    streams.set(key, set);
  }
  const entry: StreamSub = { send: sub, evict };
  set.add(entry);
  return () => {
    set?.delete(entry);
    if (set && set.size === 0) streams.delete(key);
  };
}

// Track the last SSE event we published per (agent, session). The
// `/health` endpoint surfaces "seconds since last engine activity" so
// an operator can tell at a glance whether a session is silently
// wedged. Cheap: a single Map.set per published event.
const lastEngineEventAt = new Map<string, number>();
// Last successful publish (at least one subscriber acknowledged, OR no
// subscribers at all). Distinct from lastEngineEventAt which fires on
// every publish attempt; this one only advances when the broadcast
// actually went through. Diagnostic surface for /health.
const lastPublishOkAt = new Map<string, number>();

async function publish(agent: string, session: string, event: SseEvent): Promise<void> {
  const key = streamKey(agent, session);
  lastEngineEventAt.set(key, Date.now());
  const subs = streams.get(key);
  if (!subs || subs.size === 0) {
    lastPublishOkAt.set(key, Date.now());
    return;
  }
  // Per-subscriber write budget. A healthy writeSSE finishes in
  // microseconds; backpressure on a wedged HTTP/2 stream (mobile-
  // backgrounded, dead TLS, lost-WiFi-without-RST) can otherwise stall
  // every turn on this (agent, session). Bug 2026-05-19 driver.
  const timeoutMs = config.sse.publishTimeoutMs;
  const parallel = config.sse.publishParallel;
  const snapshot = [...subs];
  const dead: StreamSub[] = [];
  type Outcome = { sub: StreamSub; ok: boolean; reason?: 'timeout' | 'error'; err?: unknown };

  const runOne = async (sub: StreamSub): Promise<Outcome> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const result = await Promise.race([
        sub.send(event).then(() => 'ok' as const),
        timeoutPromise,
      ]);
      if (result === 'timeout') {
        return { sub, ok: false, reason: 'timeout' };
      }
      return { sub, ok: true };
    } catch (err) {
      return { sub, ok: false, reason: 'error', err };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let outcomes: Outcome[];
  if (parallel) {
    outcomes = await Promise.all(snapshot.map(runOne));
  } else {
    outcomes = [];
    for (const sub of snapshot) {
      outcomes.push(await runOne(sub));
    }
  }

  let okCount = 0;
  for (const o of outcomes) {
    if (o.ok) {
      okCount += 1;
      continue;
    }
    dead.push(o.sub);
    if (o.reason === 'timeout') {
      logger.warn({
        msg: 'sse.publish_timeout',
        agent,
        session,
        ageMs: timeoutMs,
        eventKind: event.event,
        hint: 'subscriber did not ack write within budget — evicting (likely backgrounded mobile / dead TCP)',
      });
    } else {
      logger.warn({
        msg: 'sse.publish_fail',
        agent,
        session,
        eventKind: event.event,
        err: String(o.err),
      });
    }
  }

  if (okCount > 0 || snapshot.length === 0) {
    lastPublishOkAt.set(key, Date.now());
  }

  if (dead.length > 0) {
    const set = streams.get(key);
    if (set) {
      for (const d of dead) set.delete(d);
      if (set.size === 0) streams.delete(key);
      logger.info({
        msg: 'sse.publish_evict_dead',
        agent,
        session,
        count: dead.length,
        remaining: set?.size ?? 0,
      });
    }
    // Tear the evicted connections down so the client sees EOF and
    // reconnects instead of idling on a zombie stream that still
    // heartbeats but never delivers events (Juni-Audit 2026-06).
    for (const d of dead) {
      try {
        d.evict();
      } catch (err) {
        logger.debug({ msg: 'sse.evict_close_failed', agent, session, err: String(err) });
      }
    }
  }

  // Side-channel: forward to the cross-agent activity hub so the mobile
  // AvatarRow + web AgentDock + TUI status can render per-agent
  // streaming dots and unread badges. Fire-and-forget — failures in
  // the activity hub must not break the per-session broadcast that
  // just succeeded above. See src/server/activity-stream.ts.
  void tapPublish(agent, session, event);
}

// Resolve the effective model for a turn: a per-session override (set via
// /model) wins over the persona's default. Either way: resolveAnyRef handles
// the alias → provider/id → bare id lookup chain.
// First-known-agent fallback for endpoints that legacy clients may
// hit without specifying ?agent=. Returns alphabetically-first
// registered agent name; null if no agents exist. Resolves via
// listAgents() each call to stay current with hot-loaded personas.
async function defaultAgentFallback(): Promise<string | null> {
  const list = await listAgents();
  const sorted = list.map((a) => a.name).sort();
  return sorted[0] ?? null;
}

function resolveEffectiveModel(
  config: Config,
  persona: Persona,
  sessionMeta: Record<string, unknown>,
) {
  const override = sessionMeta.modelOverride;
  const ref = (typeof override === 'string' && override.length > 0 ? override : persona.model);
  if (!ref) return null;
  return resolveAnyRef(config, ref);
}

// Resolve effective thinking depth: per-session override beats persona
// default. Returns undefined if neither set — engines treat that as
// "use whatever the model defaults to".
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high']);
function resolveEffectiveThinking(
  persona: Persona,
  sessionMeta: Record<string, unknown>,
): ThinkingLevel | undefined {
  const override = sessionMeta.thinkingOverride;
  if (typeof override === 'string' && VALID_THINKING_LEVELS.has(override as ThinkingLevel)) {
    return override as ThinkingLevel;
  }
  return persona.thinking;
}

// Runs the primary engine. If the primary fails before yielding any
// assistant content (delta or message), AND the persona has a fallback
// configured, transparently switches to the fallback and resumes the turn
// from there. On success, on partial-success-then-fail, or no fallback —
// behaves like a plain engine.runTurn() pass-through.
//
// The fallback path emits its own turn_start/turn_end, so the JSONL ends
// up with two turn_starts and one set of assistant content. That's
// intentional — the audit log shows we tried twice.
// runTurnWithFallback + createTurnSerializer extracted to separate
// modules so spawn_subagent can reuse them via runChatTurn without
// pulling all of server/index.ts.

// Load ~/.somora/somora.env BEFORE config so secrets/per-host env
// (GOG_KEYRING_PASSWORD, GOG_ACCOUNT, …) reach every agent's server
// regardless of how it was launched (shell, systemd, tmux). The file
// is a default-provider — values already in process.env win, matching
// the "env-as-override" policy. Existing process.env takes precedence;
// only missing keys are filled in.
const envFileResult = loadSomoraEnvFile();
if (envFileResult.exists) {
  logger.info({
    msg: 'env_file.loaded',
    path: envFileResult.path,
    loaded: envFileResult.loaded,
    skipped: envFileResult.skipped,
  });
  if (envFileResult.permissionWarning) {
    logger.warn({ msg: 'env_file.permissions', warning: envFileResult.permissionWarning });
  }
}

// Bootstrap the isolated claude-cli config dir BEFORE any engine code
// loads. resolveClaudeBin() etc. are module-level consts that snapshot
// process.env at import time; we need CLAUDE_CONFIG_DIR to be present
// before those imports trigger.
setupClaudeConfigDir();

let config: Config;
try {
  config = await loadConfig();
} catch (err) {
  // pino's worker transport can swallow the error during fast crash; print
  // directly to stderr so the operator sees what's wrong with their config.
  console.error('\n\x1b[31m[!] somora could not load ~/.somora/config.yaml:\x1b[0m\n');
  console.error((err as Error).message);
  console.error(`\nFile: ${configPath()}`);
  console.error('Fix the YAML / schema and restart the server.\n');
  process.exit(1);
}
logger.info({
  msg: 'config.loaded',
  providers: Object.keys(config.providers).join(','),
  port: config.server.port,
});

// Credential-drift self-healing (claude-cli shared login). Config-gated,
// so it runs AFTER loadConfig — setupClaudeConfigDir() above only did
// the config-independent bootstrap. Boot-time reconcile covers drift
// that happened while the server was down; the runtime watcher (+60s
// poll) covers drift while it's up — token refreshes happen mid-run and
// killed the shared login daily before this existed (2026-07-24/25
// reports). The claude-cli adapter additionally reconciles pre-turn and
// on auth failures.
configureClaudeCredentialSync({
  enabled: config.claudeCli.sharedUserCredentials,
  log: {
    info: (data) => logger.info(data),
    warn: (data) => logger.warn(data),
  },
});
reconcileClaudeCredentials();
startClaudeCredentialSyncWatcher();

// Validate vision worker config — warn-and-degrade rather than hard-
// fail so an image-only worker (e.g., a local omlx model) is still
// usable, but PDF tools will surface a clear error per call. Missing
// `vision.worker` entirely is fine — analyze_file just errors at
// call time. Reference resolution failures ARE hard-fails (a config
// pointing at a nonexistent model is broken either way).
{
  const { resolveAnyRef } = await import('../config/types.ts');
  const checkWorker = (label: string, ref: string | undefined, requirePdf: boolean) => {
    if (!ref) return;
    const m = resolveAnyRef(config, ref);
    if (!m) {
      throw new Error(
        `config.vision.${label} '${ref}' is not a known model — fix config.yaml`,
      );
    }
    if (m.provider.engine !== 'openai-compatible') {
      logger.warn({
        msg: 'vision.worker.engine_mismatch',
        label,
        worker: ref,
        engine: m.provider.engine,
        hint: 'analyze_file will fail at call time — only openai-compatible workers supported in v1',
      });
    }
    if (!m.model.capabilities.includes('image')) {
      logger.warn({
        msg: 'vision.worker.no_image_capability',
        label,
        worker: ref,
      });
    }
    if (requirePdf && !m.model.capabilities.includes('pdf')) {
      logger.warn({
        msg: 'vision.worker.no_pdf_capability',
        label,
        worker: ref,
        hint: 'set config.vision.pdfWorker to a pdf-capable model, or analyze_file on PDFs will error',
      });
    }
  };
  try {
    // Every entry of a chain is validated, not just the first — a
    // typo in the fallback would otherwise only surface on the day the
    // primary is down, which is the worst possible moment to find it.
    for (const ref of workerChain(config.vision.worker)) {
      checkWorker('worker', ref, !config.vision.pdfWorker);
    }
    for (const ref of workerChain(config.vision.pdfWorker)) {
      checkWorker('pdfWorker', ref, true);
    }
  } catch (err) {
    console.error('\n\x1b[31m[!] somora vision config invalid:\x1b[0m\n');
    console.error((err as Error).message);
    process.exit(1);
  }
}

// Push claude-cli SDK tunables into process.env so the subprocess
// inherits them. Must run before the first engine call.
applyClaudeCliSdkEnv(config);
// Same for codex-cli — bridges config.codexCli into a process.env var
// that somoraMemoryCodexFlags() reads when building -c TOML overrides.
applyCodexCliEnv(config);

logger.info({
  msg: 'somora.env',
  env: getEffectiveEnv(),
});

// Seed built-in skills into ~/.somora/skills/. Idempotent; on each start the
// content-hash matrix decides whether to seed-fresh, silently update an
// unedited copy, or leave a user-edited copy untouched. State is recorded in
// ~/.somora/.skill-seed-state.json. Failures here are logged but never block
// server start — agents fall back to the user's existing skills directory.
try {
  await seedBuiltinSkills();
} catch (err) {
  logger.warn({
    msg: 'skills.bootstrap_unhandled_error',
    err: (err as Error).message,
  });
}

// Construct the process-wide tool registry. Built once at startup,
// shared by HTTP debug endpoints + the in-process openai-compatible
// agent-loop. The MCP-child-process registry (src/mcp/server.ts) is
// built from the same `registerAllTools()` so the two engine paths
// can't drift — that drift is exactly what bit Phase X scaffold
// (commit 23be832 / `feedback_dual_tool_registries.md`).
const tools = new ToolRegistry();
registerAllTools(tools);
logger.info({
  msg: 'tools.registered',
  count: tools.list().length,
  names: tools.list().map((t) => t.name).join(','),
});

// MCP hub — the SINGLE MCP client for external servers (design:
// private/mcp-hub-design.md). Discovered tools bridge into the registry
// above (openai-compat path); the per-turn MCP children in proxy mode
// read the catalog snapshot and forward calls to POST /mcp/call.
// Lazy: warmup() fires the connects in the background, boot never
// blocks on an external server.
const mcpHub = new McpHubManager(config.mcp);
if (mcpHub.enabled) {
  bridgeMcpTools(mcpHub, tools);
  let snapshotTimer: NodeJS.Timeout | null = null;
  mcpHub.addCatalogListener(() => {
    // Debounce: a connect burst at warmup would otherwise write the
    // snapshot once per server.
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => {
      writeCatalog(mcpHub.status(), mcpHub.connectedTools()).catch((err) =>
        logger.warn({ msg: 'mcp.hub.catalog_write_failed', err: (err as Error).message }),
      );
    }, 250);
    snapshotTimer.unref();
  });
  mcpHub.warmup();
  logger.info({ msg: 'mcp.hub.enabled', servers: mcpHub.serverNames() });
}

const app = new Hono();

app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  logger.info({
    msg: 'http',
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - start,
  });
});

app.get('/healthz', (c) => c.text('ok'));

// Server startup wall-clock — used by /health to compute uptime.
const SERVER_BOOTED_AT = Date.now();

// Diagnostic endpoint. Read-only snapshot of per-session lock state +
// queue depth + last SSE/engine event timestamp. Designed for the
// "morning incident" scenario where a single session has wedged: a
// curl against /health shows which (agent,session) is busy, for how
// long, when its last engine event arrived, and how many turns are
// queued behind it — no restart needed to diagnose.
app.get('/health', (c) => {
  const now = Date.now();
  const lockfile = readLockfile();
  const sessions = listAllSessionLockStates().map((s) => {
    const key = streamKey(s.agent, s.session);
    const lastEvent = lastEngineEventAt.get(key);
    const lastOk = lastPublishOkAt.get(key);
    const subCount = streams.get(key)?.size ?? 0;
    return {
      agent: s.agent,
      session: s.session,
      busy: s.busy,
      activePriority: s.activePriority,
      activeSince: s.activeSince,
      activeAgeMs: s.activeSince ? now - s.activeSince : null,
      activeCallId: s.activeCallId ?? null,
      activeTurnId: s.activeTurnId ?? null,
      queueLength: s.queueLength,
      userWaiting: s.userWaiting,
      agentWaiting: s.agentWaiting,
      lastEngineEventAt: lastEvent ?? null,
      lastEngineEventAgoMs: lastEvent ? now - lastEvent : null,
      // SSE-broadcast diagnostics (added 2026-05-19). Helps spot a wedged
      // subscriber pattern at a glance: subscriberCount > 0 but
      // lastPublishOkAgoMs growing without bound = at least one stuck
      // client. After the publish() timeout fix, this auto-heals; the
      // counters are the canary that signals it's happening.
      subscriberCount: subCount,
      lastPublishOkAt: lastOk ?? null,
      lastPublishOkAgoMs: lastOk ? now - lastOk : null,
    };
  });
  const busySessions = sessions.filter((s) => s.busy);
  return c.json({
    ok: true,
    serverPid: process.pid,
    serverBootedAt: SERVER_BOOTED_AT,
    serverUptimeMs: now - SERVER_BOOTED_AT,
    lockfilePid: lockfile?.pid ?? null,
    lockfileStartedAt: lockfile?.startedAt ?? null,
    activeSessions: busySessions.length,
    totalKnownSessions: sessions.length,
    // Shared-login credential sync (claude-cli). `identical: false` with
    // both sides present means the stores have diverged and the watcher
    // hasn't caught up — if that state persists, auth is about to break.
    // Expiry values only, never token material.
    claudeAuth: credentialSyncStatus(),
    sessions,
  });
});

// FileView: read-only viewer for filesystem artefacts that agents
// reference by absolute path in chat messages (feedback reports, logs,
// generated docs, ...). Returns the file contents + a coarse `kind`
// hint the web client uses to pick a renderer (markdown / text /
// code). Policy is reused 1:1 from file_read — what the agent can read,
// the user can view in the FileView window.
//
// Web-only concept: TUI users see the raw path in chat output and use
// `cat`/`less` directly; the link rewrite that opens this endpoint
// lives in the web client's Markdown renderer.
const FILEVIEW_HARD_CAP = 200_000; // chars, mirrors file_read
// Media and everything else are classified from the BYTES (see
// FILEVIEW media branch below); this table only decides how a TEXT file
// is highlighted. `.svg` is deliberately listed as code rather than as
// an image: it is markup that can carry script, and the safe way to
// show it is as its own source plus a download button.
const FILEVIEW_EXT_KIND: Record<string, 'markdown' | 'text' | 'code'> = {
  '.svg': 'code',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.json': 'code',
  '.jsonl': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.toml': 'code',
};
// ─── Wiki explorer (read-only) ───────────────────────────────────────
//
// Slug-addressed, never path-addressed. A request can only name pages
// the index already found under the configured wiki root, so `../`,
// symlink escapes and non-markdown files are rejected by construction
// rather than by a filter someone has to keep correct.
//
// All routes 503 when the wiki is off — the same gate the dock tile
// uses to hide itself (opt-in features need every gate, not one).

/** Absolute wiki root, or null when wiki/vault aren't both configured. */
function wikiRootOrNull(): string | null {
  if (!config.wiki.enabled) return null;
  const vault = config.obsidian?.vault;
  if (typeof vault !== 'string' || vault.length === 0) return null;
  return resolvePath(expandHome(vault), config.wiki.vaultSubfolder);
}

function wikiDisabled(c: Context) {
  return c.json(
    {
      error:
        'wiki is not enabled — set wiki.enabled and obsidian.vault in ~/.somora/config.yaml',
    },
    503,
  );
}

app.get('/wiki/status', (c) => {
  const root = wikiRootOrNull();
  return c.json({ enabled: root !== null, ...(root ? { root } : {}) });
});

app.get('/wiki/tree', async (c) => {
  const root = wikiRootOrNull();
  if (!root) return wikiDisabled(c);
  const index = await getWikiIndex(root);
  return c.json({
    root,
    pages: index.pages.size,
    builtAt: index.builtAt,
    nodes: buildTree(index),
  });
});

app.post('/wiki/refresh', async (c) => {
  const root = wikiRootOrNull();
  if (!root) return wikiDisabled(c);
  invalidateWikiIndex();
  const index = await getWikiIndex(root);
  return c.json({ pages: index.pages.size, builtAt: index.builtAt });
});

app.get('/wiki/page', async (c) => {
  const root = wikiRootOrNull();
  if (!root) return wikiDisabled(c);
  const slug = c.req.query('slug');
  if (typeof slug !== 'string' || slug.length === 0) {
    return c.json({ error: 'missing slug query' }, 400);
  }
  const index = await getWikiIndex(root);
  const hit = getPage(index, slug);
  if (!hit) return c.json({ error: `no wiki page '${slug}'` }, 404);
  let content: Awaited<ReturnType<typeof readPageContent>>;
  try {
    content = await readPageContent(hit.meta);
  } catch (err) {
    return c.json({ error: `read failed: ${(err as Error).message}` }, 500);
  }
  const { markdown, frontmatter } = content;
  // Resolve every wikilink in the body so the reader can turn them into
  // in-window navigation without reimplementing Obsidian's matching.
  const targets = extractLinkTargets(markdown);
  return c.json({
    slug: hit.meta.slug,
    title: hit.meta.title,
    folder: hit.meta.folder,
    mtimeMs: hit.meta.mtimeMs,
    markdown,
    frontmatter,
    links: hit.meta.links.map((s) => ({ slug: s, title: index.pages.get(s)?.title ?? s })),
    unresolved: hit.meta.unresolved,
    backlinks: hit.backlinks.map((p) => ({ slug: p.slug, title: p.title })),
    linkTargets: resolveLinkTargets(index, targets),
  });
});

app.get('/wiki/graph', async (c) => {
  const root = wikiRootOrNull();
  if (!root) return wikiDisabled(c);
  const index = await getWikiIndex(root);
  const scope = c.req.query('scope') === 'global' ? 'global' : 'local';
  if (scope === 'global') return c.json({ scope, ...globalGraph(index) });
  const slug = c.req.query('slug');
  if (typeof slug !== 'string' || slug.length === 0) {
    return c.json({ error: 'local scope needs a slug' }, 400);
  }
  const g = localGraph(index, slug);
  if (!g) return c.json({ error: `no wiki page '${slug}'` }, 404);
  return c.json({ scope, ...g });
});

app.get('/files/view', async (c) => {
  const raw = c.req.query('path');
  if (typeof raw !== 'string' || raw.length === 0) {
    return c.json({ error: 'missing path query' }, 400);
  }
  // Web only sends absolute paths emitted by agents (e.g.
  // `/home/<user>/somoraworkspace/...`). Relative paths have no
  // meaning here — there is no agent-context cwd to resolve them
  // against.
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    return c.json({ error: 'path must be absolute' }, 400);
  }
  const absolute = normalize(expanded);
  // Two-pass policy check matches file_read: raw path first, then
  // realpath of the closest existing ancestor so a symlink can't
  // escape a blocked root.
  const policy = checkReadAllowed(absolute);
  if (!policy.ok) {
    return c.json({ error: policy.reason }, 403);
  }
  const real = await realpathSafeAncestor(absolute);
  const policyReal = checkReadAllowed(real);
  if (!policyReal.ok) {
    return c.json({ error: policyReal.reason }, 403);
  }
  // Stat first to give a clean 404 before reading; also rejects
  // directories with a meaningful message.
  let st: Awaited<ReturnType<typeof statFs>>;
  try {
    st = await statFs(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return c.json({ error: 'file not found' }, 404);
    }
    throw err;
  }
  if (st.isDirectory()) {
    return c.json({ error: 'path is a directory' }, 400);
  }
  if (!st.isFile()) {
    return c.json({ error: 'path is not a regular file' }, 400);
  }
  const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase();
  let kind = FILEVIEW_EXT_KIND[ext] ?? null;
  if (!kind) {
    // Not a known text extension — ask the bytes what this is. Anything
    // that isn't text gets described rather than returned: the client
    // renders it from /files/raw, which can stream and seek. Nothing is
    // refused outright any more, because "here is the name, the size
    // and a download button" beats a 415 for a file the user can see
    // sitting in their workspace.
    const detected = await detectMimeFromPath(absolute);
    if (detected.kind !== 'text') {
      const mediaKind =
        detected.kind === 'image' || detected.kind === 'video' ||
        detected.kind === 'audio' || detected.kind === 'pdf'
          ? detected.kind
          : 'binary';
      return c.json({
        path: absolute,
        kind: mediaKind,
        ext,
        bytes: st.size,
        mime: detected.mimeType,
        url: `/files/raw?path=${encodeURIComponent(absolute)}`,
        downloadUrl: `/files/raw?download=1&path=${encodeURIComponent(absolute)}`,
      });
    }
    kind = 'text';
  }
  const buf = await readFileFs(absolute);
  let content = buf.toString('utf8');
  let truncated = false;
  let truncatedReason: string | undefined;
  if (content.length > FILEVIEW_HARD_CAP) {
    content = content.slice(0, FILEVIEW_HARD_CAP) + '\n[…content truncated at 200k chars]';
    truncated = true;
    truncatedReason = `byte cap (${FILEVIEW_HARD_CAP} chars)`;
  }
  return c.json({
    path: absolute,
    kind,
    ext,
    bytes: st.size,
    content,
    truncated,
    downloadUrl: `/files/raw?download=1&path=${encodeURIComponent(absolute)}`,
    ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
  });
});

// Raw bytes for the FileView. Split from /files/view because the two
// answer different questions: that route says WHAT a file is, this one
// hands over the bytes. Same policy, same two passes — what an agent
// may read, the user may view.
//
// Range requests are not optional here. A browser seeking inside a
// video issues them, and an endpoint that ignores Range makes seeking
// either fail or re-download the whole file per scrub.
//
// Every file type is downloadable, including the ones the viewer cannot
// render: `?download=1` forces the attachment disposition. Inline
// display is limited to media types — anything else would let a crafted
// file execute on somora's own origin.
const FILEVIEW_INLINE_KINDS = new Set(['image', 'video', 'audio', 'pdf']);

app.get('/files/raw', async (c) => {
  const raw = c.req.query('path');
  if (typeof raw !== 'string' || raw.length === 0) {
    return c.json({ error: 'missing path query' }, 400);
  }
  const expanded = expandHome(raw);
  if (!isAbsolute(expanded)) {
    return c.json({ error: 'path must be absolute' }, 400);
  }
  const absolute = normalize(expanded);
  const policy = checkReadAllowed(absolute);
  if (!policy.ok) return c.json({ error: policy.reason }, 403);
  const real = await realpathSafeAncestor(absolute);
  const policyReal = checkReadAllowed(real);
  if (!policyReal.ok) return c.json({ error: policyReal.reason }, 403);

  let st: Awaited<ReturnType<typeof statFs>>;
  try {
    st = await statFs(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return c.json({ error: 'file not found' }, 404);
    }
    throw err;
  }
  if (!st.isFile()) return c.json({ error: 'path is not a regular file' }, 400);

  const detected = await detectMimeFromPath(absolute);
  const download = c.req.query('download') === '1';
  const inline = !download && FILEVIEW_INLINE_KINDS.has(detected.kind);
  const filename = absolute.slice(absolute.lastIndexOf('/') + 1);
  const headers: Record<string, string> = {
    'content-type': detected.mimeType,
    // The type is declared from the bytes; never let a browser second-
    // guess it into something executable.
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"`,
    'cache-control': 'private, max-age=60',
  };

  const { createReadStream } = await import('node:fs');
  const { Readable } = await import('node:stream');

  const rangeHeader = c.req.header('range');
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (match && st.size > 0) {
    const startRaw = match[1];
    const endRaw = match[2];
    let start: number;
    let end: number;
    if (startRaw) {
      start = Number(startRaw);
      end = endRaw ? Number(endRaw) : st.size - 1;
    } else if (endRaw) {
      // `bytes=-500` means the LAST 500 bytes, not "up to 500".
      start = Math.max(0, st.size - Number(endRaw));
      end = st.size - 1;
    } else {
      start = 0;
      end = st.size - 1;
    }
    end = Math.min(end, st.size - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${st.size}`, 'accept-ranges': 'bytes' },
      });
    }
    const stream = Readable.toWeb(createReadStream(absolute, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: { ...headers, 'content-length': String(st.size) },
  });
});

// Tmux session listing for the web tmux-app. Joins live `tmux ls`
// output with somora's origin store. Empty list when no tmux server
// is running — that's a normal state, not an error.
app.get('/tmux/sessions', async (c) => {
  const sessions = await listTmuxSessions();
  return c.json({ sessions });
});

// ─────────────────────────────────────────────────────────────────────
// Sentinel — proactive trigger management for the web-UI sentinel tab.
// All actions reuse the in-process sentinel store + scheduler (no extra
// HTTP roundtrip). The same surface is also exposed through the
// `sentinel` tool that agents can call.
// ─────────────────────────────────────────────────────────────────────

app.get('/sentinel/triggers', async (c) => {
  await sentinelStore.loadTriggers();
  const owner = c.req.query('owner');
  const status = c.req.query('status');
  let triggers = sentinelStore.listTriggers();
  if (owner) triggers = triggers.filter((t) => t.ownerAgent === owner);
  if (status) triggers = triggers.filter((t) => t.status === status);
  triggers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ count: triggers.length, triggers });
});

app.get('/sentinel/triggers/:id', async (c) => {
  await sentinelStore.loadTriggers();
  const t = sentinelStore.getTrigger(c.req.param('id'));
  if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
  return c.json({ trigger: t });
});

app.get('/sentinel/triggers/:id/history', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);
  const entries = await sentinelStore.getHistory(c.req.param('id'), limit);
  return c.json({ count: entries.length, entries });
});

app.post('/sentinel/triggers/:id/pause', async (c) => {
  await sentinelStore.loadTriggers();
  const t = sentinelStore.getTrigger(c.req.param('id'));
  if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
  await sentinelStore.saveTrigger({ ...t, status: 'paused', statusReason: 'paused via web-UI' });
  sentinelScheduler.reschedule();
  return c.json({ ok: true });
});

app.post('/sentinel/triggers/:id/resume', async (c) => {
  await sentinelStore.loadTriggers();
  const t = sentinelStore.getTrigger(c.req.param('id'));
  if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
  // Recompute nextFireAt; old one may have drifted past while paused.
  let nextFireAt: string | undefined;
  if (t.source.type === 'time') {
    try {
      const next = sentinelSchedule.computeNextFire(t.source.spec);
      if (next) nextFireAt = next.toISOString();
    } catch (err) {
      return c.json({ error: `cannot resume: ${(err as Error).message}` }, 400);
    }
  }
  const updated = {
    ...t,
    status: 'active' as const,
    errorStreak: 0,
    ...(nextFireAt ? { nextFireAt } : {}),
  };
  delete updated.statusReason;
  await sentinelStore.saveTrigger(updated);
  sentinelScheduler.reschedule();
  return c.json({ ok: true });
});

app.delete('/sentinel/triggers/:id', async (c) => {
  const removed = await sentinelStore.deleteTrigger(c.req.param('id'));
  if (removed) sentinelScheduler.reschedule();
  return removed ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
});

app.post('/sentinel/triggers/:id/test', async (c) => {
  await sentinelStore.loadTriggers();
  const t = sentinelStore.getTrigger(c.req.param('id'));
  if (!t) return c.json({ error: `trigger '${c.req.param('id')}' not found` }, 404);
  await sentinelScheduler.fireTrigger(t, { catchUp: false, testMode: true });
  return c.json({ ok: true, hint: `Test-fire dispatched. See history + the target agent's session '${t.dispatch.session}'.` });
});

app.get('/sentinel/status', (c) => {
  return c.json(sentinelScheduler.schedulerStatus());
});

// --- External MCP servers (hub) — design private/mcp-hub-design.md §4.5.
// Loopback-only posture like /tools (DECISION #31): no auth header, the
// network boundary is the trust boundary.

function mcpDisabled(c: Context) {
  return c.json(
    { error: 'no external MCP servers configured — add mcp.servers to ~/.somora/config.yaml' },
    503,
  );
}

app.get('/mcp/status', (c) => {
  if (!mcpHub.enabled) return mcpDisabled(c);
  return c.json({ enabled: true, servers: mcpHub.status() });
});

// Internal dispatch endpoint for the MCP-child proxy mode (and curl
// debugging). Body: { server, tool (raw upstream name), args, timeoutMs? }.
app.post('/mcp/call', async (c) => {
  if (!mcpHub.enabled) return mcpDisabled(c);
  const body = (await c.req.json().catch(() => null)) as {
    server?: string;
    tool?: string;
    args?: Record<string, unknown>;
    timeoutMs?: number;
  } | null;
  if (!body?.server || !body.tool) {
    return c.json({ error: 'server and tool are required' }, 400);
  }
  try {
    const result = await mcpHub.callTool(
      body.server,
      body.tool,
      body.args ?? {},
      typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
    );
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

app.post('/mcp/servers/:name/reconnect', async (c) => {
  if (!mcpHub.enabled) return mcpDisabled(c);
  try {
    const status = await mcpHub.reconnect(c.req.param('name'));
    return c.json({ ok: true, status });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// --- Per-agent tool visibility (web UI Agents×Tools matrix — design
// §4.6). GET reads registry + persona gating; PUT splices the tools:
// block into agent.yaml server-side (thin-client rule: the UI never
// touches files itself).

app.get('/agents/:agent/tools', async (c) => {
  const agent = c.req.param('agent');
  const persona = await loadPersona(agent);
  if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
  const gating = persona.toolGating ?? null;
  // Toggling in the matrix only manipulates exact-name denies. Pattern
  // rules (globs, toolset:, allow-lists) are hand-written policy — the
  // UI shows them read-only instead of guessing how to edit them.
  const hasPatternRules =
    gating !== null &&
    (gating.allow.length > 0 ||
      gating.deny.some((p) => p.includes('*') || p.startsWith('toolset:')));
  const ctx: ToolContext = {
    agent,
    getMemoryManager: () =>
      getMemoryManager(agent, {
        config: config.memory,
        obsidian: config.obsidian,
        wiki: config.wiki,
      }),
    config,
  };
  // Only tools this agent could actually use are listed. A tool whose
  // config doesn't exist has nothing to configure, and offering a
  // switch that changes nothing is worse than offering none: flipping
  // it looks like it did something.
  //
  // `listConfigured`, not `listAvailable` — this screen is a persistent
  // setting, and the loop-holder narrowing that listAvailable applies
  // is a state of this minute. Tools must not vanish from the settings
  // because the agent is mid-wiki-loop.
  const configured = await tools.listConfigured(ctx);
  return c.json({
    agent,
    gating,
    hasPatternRules,
    tools: configured.map((t) => ({
      name: t.name,
      toolset: t.toolset,
      ...(t.origin ? { mcpServer: t.origin.mcpServer } : {}),
      description: t.description.slice(0, 140),
      visible: isToolAllowed(t.name, t.toolset, gating ?? undefined),
      availableNow: true,
    })),
  });
});

app.put('/agents/:agent/tools', async (c) => {
  const agent = c.req.param('agent');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const body = (await c.req.json().catch(() => null)) as {
    deny?: string[];
    allow?: string[];
  } | null;
  if (!body || !Array.isArray(body.deny) || !Array.isArray(body.allow)) {
    return c.json({ error: 'body must be { deny: string[], allow: string[] }' }, 400);
  }
  try {
    await writeAgentToolGating(agent, { deny: body.deny, allow: body.allow });
    logger.info({
      msg: 'agents.tool_gating_updated',
      agent,
      deny: body.deny.length,
      allow: body.allow.length,
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Heartbeat for the PTY-bridge WebSockets (/terminal/attach +
// /tmux/attach). An idle pane moves zero bytes in either direction, so
// a silently dead path (Tailscale idle drop, laptop sleep, network
// switch) leaves the browser-side socket looking open forever — the
// pane just freezes. The server sends an app-level `{"type":"ping"}`
// text frame every TERMINAL_WS_PING_MS; the web client (XTermBridge)
// answers `{"type":"pong"}`, uses the ping as its own liveness signal,
// and auto-reconnects when pings stop arriving. If the client stops
// answering for TERMINAL_WS_DEAD_MS the server terminates the socket,
// which kills the PTY via onClose — no zombie shells.
const TERMINAL_WS_PING_MS = 25_000;
const TERMINAL_WS_DEAD_MS = 80_000;

interface PtyWsBag {
  __pty?: { write(s: string): void; resize(cols: number, rows: number): void; kill(): void };
  __hbTimer?: ReturnType<typeof setInterval>;
  __lastSeenAt?: number;
}

function armTerminalHeartbeat(
  ws: { send(d: string): void; close(code?: number, reason?: string): void; raw?: unknown },
  bag: PtyWsBag,
  label: string,
): void {
  bag.__lastSeenAt = Date.now();
  bag.__hbTimer = setInterval(() => {
    const idle = Date.now() - (bag.__lastSeenAt ?? 0);
    if (idle > TERMINAL_WS_DEAD_MS) {
      logger.info({ msg: `${label}.heartbeat_timeout`, idleMs: idle });
      try {
        ws.close(4000, 'heartbeat timeout');
      } catch {
        /* already closed */
      }
      // close() needs the peer to answer the closing handshake — a dead
      // peer never does. terminate() drops the socket immediately and
      // fires onClose locally (kills the PTY, clears this timer).
      try {
        (ws.raw as { terminate?: () => void } | undefined)?.terminate?.();
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      ws.send('{"type":"ping"}');
    } catch {
      /* socket closed */
    }
  }, TERMINAL_WS_PING_MS);
}

// Plain shell terminal: WebSocket bridge to a fresh `$SHELL` PTY
// rooted in the configured workspace (`config.workspace.default`,
// usually `~/somoraworkspace`). One terminal per WS connection —
// closing the WS kills the shell, opening multiple windows gets you
// multiple independent shells. No session-id concept; nothing
// persistent to attach to.
app.get(
  '/terminal/attach',
  upgradeWebSocket(() => {
    return {
      async onOpen(_evt, ws) {
        try {
          const pty = await import('node-pty');
          const shell = process.env.SHELL || '/bin/bash';
          const cwdRaw = config.workspace.default;
          const cwd = cwdRaw.startsWith('~/')
            ? resolvePath(homedir(), cwdRaw.slice(2))
            : resolvePath(cwdRaw);
          const term = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
          term.onData((data: string) => {
            try {
              ws.send(Buffer.from(data, 'utf8'));
            } catch {
              /* socket closed */
            }
          });
          term.onExit(({ exitCode }) => {
            try {
              ws.close(1000, `shell exited (${exitCode})`);
            } catch {
              /* ignore */
            }
          });
          const raw = ws.raw as PtyWsBag | undefined;
          if (raw) {
            raw.__pty = term;
            armTerminalHeartbeat(ws, raw, 'terminal.attach');
          }
          logger.info({ msg: 'terminal.attach.open', shell, cwd });
        } catch (err) {
          logger.error({
            msg: 'terminal.attach.spawn_failed',
            err: (err as Error).message,
          });
          ws.close(1011, `failed to spawn shell: ${(err as Error).message}`);
        }
      },
      onMessage(evt, ws) {
        const raw = ws.raw as PtyWsBag | undefined;
        if (raw) raw.__lastSeenAt = Date.now();
        const term = raw?.__pty;
        if (!term) return;
        const data = evt.data;
        if (typeof data === 'string') {
          // Text frame = control message (JSON): resize, or the pong
          // reply to our heartbeat ping (liveness stamped above).
          try {
            const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
            if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
              term.resize(Math.max(2, msg.cols), Math.max(2, msg.rows));
            }
          } catch {
            /* ignore */
          }
        } else if (data instanceof ArrayBuffer) {
          term.write(Buffer.from(data).toString('utf8'));
        } else if (data instanceof Uint8Array) {
          term.write(Buffer.from(data).toString('utf8'));
        } else if (Buffer.isBuffer(data)) {
          term.write((data as Buffer).toString('utf8'));
        }
      },
      onClose(_evt, ws) {
        const raw = ws.raw as PtyWsBag | undefined;
        if (raw?.__hbTimer) clearInterval(raw.__hbTimer);
        try {
          raw?.__pty?.kill();
        } catch {
          /* already dead */
        }
        logger.info({ msg: 'terminal.attach.close' });
      },
    };
  }),
);

// Tmux attach: WebSocket bridge to a `tmux attach-session -d -t <name>`
// PTY. Bidirectional binary frames carry tmux's terminal stream;
// text frames carry control messages (resize). Sessions only —
// remote tmux is not browse-able from here yet.
//
// Flow:
//   1. Client opens WSS .../tmux/attach?session=<name>
//   2. Server spawns `tmux attach-session -d -t <name>` in a PTY
//      sized 80×24 (refined immediately by the first resize msg)
//   3. PTY stdout → WS binary frames
//   4. WS binary frames → PTY stdin
//   5. WS text frames "{type:'resize',cols,rows}" → PTY resize
//   6. PTY exit → WS close, or WS close → kill PTY
app.get(
  '/tmux/attach',
  upgradeWebSocket((c) => {
    const session = c.req.query('session') ?? '';
    return {
      async onOpen(_evt, ws) {
        if (!session || !/^[A-Za-z0-9_./-]+$/.test(session)) {
          ws.close(1008, 'invalid session name');
          return;
        }
        const sessions = await listTmuxSessions();
        if (!sessions.find((s) => s.name === session)) {
          ws.close(1008, `tmux session '${session}' not found`);
          return;
        }
        try {
          const pty = await import('node-pty');
          const term = pty.spawn(
            'tmux',
            ['attach-session', '-d', '-t', session],
            {
              name: 'xterm-256color',
              cols: 80,
              rows: 24,
              cwd: process.env.HOME,
              env: { ...process.env, TERM: 'xterm-256color' },
            },
          );
          // PTY → WS. node-pty data is a string; we send as binary so
          // xterm.js decodes the bytes verbatim (tmux emits UTF-8).
          term.onData((data: string) => {
            try {
              ws.send(Buffer.from(data, 'utf8'));
            } catch {
              /* socket closed mid-write */
            }
          });
          term.onExit(({ exitCode }) => {
            try {
              ws.close(1000, `tmux exited (${exitCode})`);
            } catch {
              /* ignore */
            }
          });
          // Stash the term on the raw ws so onMessage / onClose can
          // reach it — WSContext.raw is the underlying node `ws`
          // instance (via @hono/node-server). Hand-rolled property
          // bag because hono's WSContext doesn't expose its own
          // closure scope.
          const raw = ws.raw as PtyWsBag | undefined;
          if (raw) {
            raw.__pty = term;
            armTerminalHeartbeat(ws, raw, 'tmux.attach');
          }
          logger.info({ msg: 'tmux.attach.open', session });
        } catch (err) {
          logger.error({
            msg: 'tmux.attach.spawn_failed',
            session,
            err: (err as Error).message,
          });
          ws.close(1011, `failed to spawn tmux: ${(err as Error).message}`);
        }
      },
      onMessage(evt, ws) {
        const raw = ws.raw as PtyWsBag | undefined;
        if (raw) raw.__lastSeenAt = Date.now();
        const term = raw?.__pty;
        if (!term) return;
        const data = evt.data;
        if (typeof data === 'string') {
          // Text frame = control message (JSON): resize, or the pong
          // reply to our heartbeat ping (liveness stamped above).
          try {
            const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
            if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
              term.resize(Math.max(2, msg.cols), Math.max(2, msg.rows));
            }
          } catch {
            // unparseable text → ignore; binary path handles real input
          }
        } else if (data instanceof ArrayBuffer) {
          term.write(Buffer.from(data).toString('utf8'));
        } else if (data instanceof Uint8Array) {
          term.write(Buffer.from(data).toString('utf8'));
        } else if (Buffer.isBuffer(data)) {
          term.write((data as Buffer).toString('utf8'));
        }
      },
      onClose(_evt, ws) {
        const raw = ws.raw as PtyWsBag | undefined;
        if (raw?.__hbTimer) clearInterval(raw.__hbTimer);
        try {
          raw?.__pty?.kill();
        } catch {
          /* already dead */
        }
        logger.info({ msg: 'tmux.attach.close', session });
      },
    };
  }),
);

// Version endpoint — surfaced to the web client so the taskbar can
// display the running build. Read once at boot from version.ts (which
// reads package.json), so this is effectively a static snapshot for
// the lifetime of the process. JSON keeps room for future fields
// (build-time, git SHA, env name) without breaking the client.
app.get('/version', (c) => c.json({ version: SOMORA_VERSION }));

app.get('/env', (c) => c.json(getEffectiveEnv()));

// Host machine stats — CPU load + memory usage of the box somora is
// running on. Surfaced to the web taskbar (`cpu` / `mem` widgets) and
// useful for ad-hoc curl when somora lives on a VM you don't otherwise
// have a metrics dashboard for.
//
// CPU: 1-minute load average from `os.loadavg()` divided by core count.
//   `percent` > 100 means the box is overloaded (more runnable
//   processes than CPUs), which is honest signal — we don't cap.
//   On Windows `loadavg` returns zeros, but somora doesn't target
//   Windows so we accept the degraded value.
// Mem: platform-specific because `os.freemem()` is misleading on both
//   Linux (excludes reclaimable page cache) and macOS (excludes
//   inactive + speculative pages that the kernel hands back under
//   pressure). We read each platform's "available memory" notion:
//     - Linux:  /proc/meminfo:MemAvailable
//     - macOS:  `vm_stat` pages: free + inactive + speculative
//     - other:  os.freemem() fallback (degraded but non-erroring)
function readLinuxMemAvailable(): number | null {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}
function readDarwinMemAvailable(): number | null {
  try {
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1000 });
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
    const pages = (label: string): number => {
      const m = out.match(new RegExp(`${label}:\\s+(\\d+)\\.`));
      return m ? Number(m[1]) : 0;
    };
    // Mirrors what macOS Activity Monitor calls "available": free
    // pages plus inactive + speculative (file-backed pages the kernel
    // can hand back under memory pressure without I/O).
    const available = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
    return available * pageSize;
  } catch {
    return null;
  }
}
function readPlatformMemAvailable(): number {
  if (process.platform === 'linux') {
    const v = readLinuxMemAvailable();
    if (v !== null) return v;
  } else if (process.platform === 'darwin') {
    const v = readDarwinMemAvailable();
    if (v !== null) return v;
  }
  return osFreemem();
}
app.get('/host-stats', (c) => {
  const cores = osCpus().length || 1;
  const load1 = osLoadavg()[0] ?? 0;
  const totalBytes = osTotalmem();
  const availableBytes = readPlatformMemAvailable();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return c.json({
    cpu: {
      loadAvg1: load1,
      cores,
      percent: cores > 0 ? (load1 / cores) * 100 : 0,
    },
    mem: {
      totalBytes,
      availableBytes,
      usedBytes,
      percent: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    },
  });
});

// Display preferences for thin clients (TUI, future web). Server is the
// single config reader — clients fetch this rather than parsing config.yaml
// themselves.
app.get('/tui-config', (c) => c.json(config.tui));
app.get('/mobile-config', (c) => c.json(config.mobile));

// Verbose-mode helper: returns the persona's compiled system prompt.
// Used by /verbose system in the TUI to surface what the model is
// actually seeing as instructions. Static per agent (does not change
// per turn — ephemeralContext is per-turn and rides on the memory SSE).
app.get('/agents/:agent/system-prompt', async (c) => {
  const agent = c.req.param('agent');
  const persona = await loadPersona(agent);
  if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
  return c.json({ agent, systemPrompt: persona.systemPrompt });
});

app.get('/agents', async (c) => c.json(await listAgents()));

app.get('/models', (c) => {
  const list: Array<{
    provider: string;
    id: string;
    alias: string | null;
    engine: string;
    contextWindow: number;
    capabilities: string[];
    ref: string;
  }> = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const model of provider.models) {
      list.push({
        provider: providerName,
        id: model.id,
        alias: model.alias ?? null,
        engine: provider.engine,
        contextWindow: model.contextWindow,
        capabilities: model.capabilities,
        ref: model.alias ?? `${providerName}/${model.id}`,
      });
    }
  }
  return c.json(list);
});

// Tool catalog + invocation endpoints (DECISION #31). 127.0.0.1-only,
// useful for poking tools without an LLM in the loop.
//   GET  /tools                                    — list registered tools
//   POST /agents/:agent/tools/:name                — invoke a tool
app.get('/tools', (c) =>
  c.json({
    count: tools.list().length,
    tools: tools.list().map((t) => ({
      name: t.name,
      toolset: t.toolset,
      description: t.description,
      inputSchema: t.jsonSchema,
      maxResultSizeChars: t.maxResultSizeChars ?? null,
      hasAvailabilityCheck: Boolean(t.available),
    })),
  }),
);

app.post('/agents/:agent/tools/:name', async (c) => {
  const agent = c.req.param('agent');
  const name = c.req.param('name');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const input = await c.req.json().catch(() => ({}));
  const result = await tools.invoke(name, input, {
    agent,
    getMemoryManager: () => getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian }),
    config,
  });
  if (!result.ok) {
    return c.json(result, 400);
  }
  return c.json(result);
});

// Memory inspection endpoints. Strictly read-only, useful for debugging
// what's actually in a given agent's memory index without having to chat.
//   GET  /agents/:agent/memory/notes               — list indexed memory notes
//   GET  /agents/:agent/memory/search?q=…&limit=&minScore=
//                                                  — run hybrid retrieval, see hits
app.get('/agents/:agent/memory/notes', async (c) => {
  const agent = c.req.param('agent');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const mgr = await getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian });
  const notes = await mgr.listNotes();
  return c.json({ agent, count: notes.length, notes });
});

app.get('/agents/:agent/memory/search', async (c) => {
  const agent = c.req.param('agent');
  const q = c.req.query('q') ?? '';
  if (!q.trim()) return c.json({ error: 'query parameter "q" required' }, 400);
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') ?? '5')));
  const minScoreRaw = Number(c.req.query('minScore') ?? '0');
  const minScore = Number.isFinite(minScoreRaw) ? Math.max(0, Math.min(1, minScoreRaw)) : 0;
  const mgr = await getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian });
  const hits = await mgr.search(q, { limit, minScore });
  return c.json({
    agent,
    query: q,
    limit,
    minScore,
    count: hits.length,
    hits: hits.map((h) => ({
      slug: h.slug,
      source: h.source,
      score: Number(h.score.toFixed(4)),
      vecScore: Number(h.vecScore.toFixed(4)),
      bm25Score: Number(h.bm25Score.toFixed(4)),
      startLine: h.startLine,
      endLine: h.endLine,
      filePath: h.filePath,
      text: h.text,
    })),
  });
});

app.get('/agents/:agent/sessions', async (c) => {
  const agent = c.req.param('agent');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const includeArchived = c.req.query('include_archived') === 'true';
  return c.json(await listSessions(agent, { includeArchived }));
});

// Cross-agent flat list. Powers the web "Sessions" tool. Each row carries
// the agent color/icon (so the UI can render the agent column without a
// second roundtrip), the live-subscriber count (so a green-dot marker
// reflects "someone is chatting this right now"), and the resolved
// dream-status. Heavy fields (messageCount, byteSize, lastEventTs) are
// served from the per-meta cache when its jsonlMtime still matches.
app.get('/sessions', async (c) => {
  const includeArchived = c.req.query('include_archived') === 'true';
  const agents = await listAgents();
  const rows: Array<Record<string, unknown>> = [];
  let liveByKey: Map<string, number> | null = null;
  for (const agentInfo of agents) {
    const sessions = await listSessions(agentInfo.name, { includeArchived });
    for (const s of sessions) {
      if (!liveByKey) {
        // Built lazily once we know we have at least one session, so the
        // empty-agents case stays cheap.
        liveByKey = new Map<string, number>();
        for (const [key, subs] of streams) {
          liveByKey.set(key, subs.size);
        }
      }
      // Must match streamKey()'s `::` separator — a single `:` here
      // meant the lookup never hit and liveSubscribers was always 0
      // (Juni-Audit 2026-06).
      const liveKey = streamKey(agentInfo.name, s.id);
      const liveSubscribers = liveByKey.get(liveKey) ?? 0;
      const dreamStatus: 'dreamed' | 'partial' | 'never' = s.dreamCoverageTs === null
        ? 'never'
        : s.dreamLagEvents === 0
          ? 'dreamed'
          : 'partial';
      rows.push({
        agent: agentInfo.name,
        agentColor: agentInfo.color,
        agentIcon: agentInfo.icon,
        sessionId: s.id,
        slug: s.slug,
        isMain: s.isMain,
        isArchived: s.isArchived,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        messageCount: s.messageCount,
        byteSize: s.byteSize,
        ...(s.engine !== undefined ? { engine: s.engine } : {}),
        liveSubscribers,
        dream: {
          status: dreamStatus,
          coverageTs: s.dreamCoverageTs,
          lagEvents: s.dreamLagEvents,
        },
        ...(s.archivedAt !== undefined ? { archivedAt: s.archivedAt } : {}),
        ...(s.archiveReason !== undefined ? { archiveReason: s.archiveReason } : {}),
        ...(s.projectSlug !== undefined ? { projectSlug: s.projectSlug } : {}),
        unreadAt: s.unreadAt ?? null,
        seenAt: s.seenAt ?? null,
      });
    }
  }
  return c.json({ sessions: rows });
});

app.post('/agents/:agent/sessions/:session/archive', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  try {
    await archiveSession(agent, session, body.reason);
    logger.info({ msg: 'session.archive', agent, session, reason: body.reason });
    return c.json({ archived: true, agent, session });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Session export. `?format=json` returns the raw JSONL byte-identical
// from disk (canonical source, ideal for backups and cross-host
// transfer). `?format=markdown` renders a human-readable transcript
// with user/assistant turns, code-fenced tool calls, and engine_meta
// items rendered as task lists. Default is markdown.
// Content-Disposition prompts a download in the browser so the web
// SessionsWindow can offer one-click "Download JSON / Markdown" links.
app.get('/agents/:agent/sessions/:session/export', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const format = (c.req.query('format') ?? 'markdown').toLowerCase();
  if (format !== 'json' && format !== 'markdown') {
    return c.json(
      { error: `unknown format '${format}' — supported: json, markdown` },
      400,
    );
  }
  const raw = readSessionJsonlRaw(agent, session);
  if (raw === null) {
    return c.json({ error: `session file not found on disk` }, 404);
  }
  const safeSession = session.replace(/[^A-Za-z0-9._-]/g, '_');
  if (format === 'json') {
    return c.body(raw, 200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${agent}-${safeSession}.jsonl"`,
    });
  }
  const md = renderSessionMarkdown(agent, session, raw);
  return c.body(md, 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="${agent}-${safeSession}.md"`,
  });
});

app.post('/agents/:agent/sessions/:session/unarchive', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  // Resolve against the include_archived view, otherwise an archived
  // session is not addressable by slug lookup. resolveSessionId works on
  // raw file existence so it's already include-archived-aware.
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  try {
    await unarchiveSession(agent, session);
    logger.info({ msg: 'session.unarchive', agent, session });
    return c.json({ archived: false, agent, session });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post('/agents/:agent/sessions', async (c) => {
  const agent = c.req.param('agent');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const body = (await c.req.json().catch(() => ({}))) as { slug?: string };
  if (!body.slug) {
    return c.json({ error: 'body field "slug" required' }, 400);
  }
  if (body.slug === 'main') {
    return c.json({ error: '"main" is reserved — already always available' }, 400);
  }
  try {
    const id = await createSession(agent, body.slug);
    logger.info({ msg: 'session.create', agent, id, slug: body.slug });
    return c.json({ id, slug: body.slug, agent }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get('/agents/:agent/sessions/:session/model', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  const persona = await loadPersona(agent);
  if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const meta = await sessionMetaStore.get(agent, session);
  const resolved = resolveEffectiveModel(config, persona, meta);
  if (!resolved) {
    return c.json({ error: `model for agent '${agent}' cannot be resolved` }, 500);
  }
  const override = typeof meta.modelOverride === 'string' ? meta.modelOverride : null;
  return c.json({
    agent,
    session,
    provider: resolved.providerName,
    modelId: resolved.modelId,
    alias: resolved.model.alias ?? null,
    engine: resolved.provider.engine,
    contextWindow: resolved.model.contextWindow,
    source: override ? 'session-override' : 'persona-default',
    override,
    personaDefault: persona.model ?? null,
  });
});

app.put('/agents/:agent/sessions/:session/model', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { model?: string };
  if (!body.model) return c.json({ error: 'body field "model" required' }, 400);
  const resolved = resolveAnyRef(config, body.model);
  if (!resolved) {
    return c.json({ error: `model '${body.model}' not found in config.yaml` }, 400);
  }
  await sessionMetaStore.update(agent, session, (current) => ({ ...current, modelOverride: body.model }));
  logger.info({ msg: 'session.model_set', agent, session, model: body.model, resolved: `${resolved.providerName}/${resolved.modelId}` });
  return c.json({ agent, session, model: body.model, resolved: `${resolved.providerName}/${resolved.modelId}` });
});

// Reset a session: archive current jsonl + meta, fresh-start the
// session id. The archived copy is resume-able under a timestamped
// name. Used primarily for the magic `main` session, which can't be
// re-created with a new id.
//
// If the agent has Dream-Mode enabled in agent.yaml, /reset also fires
// off an async manual-dream over the just-archived range. Reset returns
// immediately — the dream runs in background and surfaces later via
// dream_list. Failures in the dream do NOT affect the reset itself.
app.post('/agents/:agent/sessions/:session/reset', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  const persona = await loadPersona(agent);
  if (!persona) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  // Hold the session lock across the archive+recreate. Without it a
  // /reset that lands mid-turn renames the JSONL out from under a
  // streaming turn — the turn's tail events recreate the "fresh"
  // session and the engine end-write stamps the old conversation's
  // sdkSessionId into it. The lock makes reset wait for the in-flight
  // turn (and serializes concurrent resets). (Juni-Audit 2026-06.)
  const releaseReset = await acquireSessionLock(agent, session, { priority: 'user' });
  let result: Awaited<ReturnType<typeof resetSession>>;
  try {
    result = await resetSession(agent, session);
  } finally {
    releaseReset();
  }
  if (!result) {
    logger.info({ msg: 'session.reset_noop', agent, session, reason: 'no jsonl to archive' });
    return c.json({ agent, session, archivedId: null, reason: 'session has no content yet — nothing to archive' });
  }
  logger.info({ msg: 'session.reset', agent, session, archivedId: result.archivedId });

  // Spawn REM over the archived range — async, no await, no
  // ramifications for the reset response. If it fails, only the dream
  // file gets a `failed` status; user is otherwise unaffected.
  let dreamSpawned = false;
  if (persona.rem?.enabled) {
    const archivedId = result.archivedId;
    const remConfig = persona.rem;
    void (async () => {
      try {
        const mgr = await getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian });
        await runDream({
          agent,
          sourceSession: archivedId,
          trigger: 'manual',
          rangeFromTs: 0,
          rangeThroughTs: Date.now(),
          rem: remConfig,
          config,
          mgr,
        });
      } catch (err) {
        logger.error({
          msg: 'dream.manual_run_failed',
          agent,
          archivedId,
          err: (err as Error).message,
        });
      }
    })();
    dreamSpawned = true;
  }
  return c.json({
    agent,
    session,
    archivedId: result.archivedId,
    dreamSpawned,
  });
});

app.delete('/agents/:agent/sessions/:session/model', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  await sessionMetaStore.update(agent, session, (current) => {
    const { modelOverride: _drop, ...rest } = current;
    return rest;
  });
  logger.info({ msg: 'session.model_clear', agent, session });
  return c.json({ agent, session, cleared: true });
});

// Thinking endpoints — mirror /model. Effective level = session override
// > persona default > unset (engine-default). modelSupportsReasoning
// flag lets clients show "active vs dormant" honestly.
app.get('/agents/:agent/sessions/:session/thinking', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  const persona = await loadPersona(agent);
  if (!persona) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const meta = await sessionMetaStore.get(agent, session);
  const resolved = resolveEffectiveModel(config, persona, meta);
  const modelSupportsReasoning =
    resolved?.model.capabilities.includes('reasoning') ?? false;
  const override =
    typeof meta.thinkingOverride === 'string' &&
    VALID_THINKING_LEVELS.has(meta.thinkingOverride as ThinkingLevel)
      ? (meta.thinkingOverride as ThinkingLevel)
      : null;
  const effective = resolveEffectiveThinking(persona, meta) ?? null;
  return c.json({
    agent,
    session,
    effective,
    override,
    personaDefault: persona.thinking ?? null,
    source: override ? 'session-override' : effective ? 'persona-default' : 'engine-default',
    modelSupportsReasoning,
  });
});

app.put('/agents/:agent/sessions/:session/thinking', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { level?: string };
  if (!body.level || !VALID_THINKING_LEVELS.has(body.level as ThinkingLevel)) {
    return c.json({ error: `body field "level" must be one of: off, low, medium, high` }, 400);
  }
  await sessionMetaStore.update(agent, session, (current) => ({ ...current, thinkingOverride: body.level }));
  logger.info({ msg: 'session.thinking_set', agent, session, level: body.level });
  return c.json({ agent, session, level: body.level });
});

app.delete('/agents/:agent/sessions/:session/thinking', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  await sessionMetaStore.update(agent, session, (current) => {
    const { thinkingOverride: _drop, ...rest } = current;
    return rest;
  });
  logger.info({ msg: 'session.thinking_clear', agent, session });
  return c.json({ agent, session, cleared: true });
});

// ─── Projects API (Phase Projects v1) ───────────────────────────────
// REST-symmetric to the agent-facing tool surface. Web client uses
// these; TUI slash-commands could also call them (or use the same
// in-process focusProject helper directly — same behavior either way).
//
// All routes return 503 when `config.projects.enabled` is false so the
// UI can detect the feature is off without a separate capability probe.

function requireProjectsEnabled(c: Context): Response | null {
  if (!config.projects?.enabled) {
    return c.json(
      { error: 'projects feature is disabled (config.projects.enabled=false)' },
      503,
    );
  }
  return null;
}

// Feature-flag probe. ALWAYS returns 200 — clients use this to decide
// whether to render project UI surfaces (chip, sessions column, slash
// commands). The other /projects/* routes return 503 when disabled,
// which is fine for tools but creates ambiguity at the UI layer
// ("empty entities array? or feature off?"). One dedicated probe
// removes the doubt.
app.get('/projects/feature', async (c) => {
  return c.json({
    enabled: Boolean(config.projects?.enabled),
    entityCount: config.projects?.entities?.length ?? 0,
  });
});

app.get('/projects/entities', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  return c.json({ entities: config.projects?.entities ?? [] });
});

app.get('/projects', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  const entity = c.req.query('entity');
  const tag = c.req.query('tag');
  const includeArchived = c.req.query('includeArchived') === 'true';
  const all = await listProjects();
  const filtered = all.filter((p) => {
    if (!includeArchived && p.archived) return false;
    if (entity && p.entity !== entity) return false;
    if (tag && !p.tags.includes(tag)) return false;
    return true;
  });
  return c.json({ projects: filtered, total: filtered.length });
});

app.get('/projects/:slug', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  const slug = c.req.param('slug');
  if (!PROJECT_SLUG_RE.test(slug)) {
    return c.json({ error: `invalid slug '${slug}'` }, 400);
  }
  const project = await readProject(slug);
  if (!project) return c.json({ error: `project '${slug}' not found` }, 404);
  return c.json({ project });
});

app.post('/projects', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  type CreateBody = {
    slug?: string;
    name?: string;
    entity?: string;
    description?: string;
    color?: string;
    tags?: string[];
    expires?: string | null;
    paths?: Array<{ ref: string; label?: string }>;
  };
  const body = (await c.req.json().catch(() => ({}))) as CreateBody;
  if (!body.slug || !body.name || !body.entity) {
    return c.json({ error: 'body fields slug, name, entity are required' }, 400);
  }
  if (!PROJECT_SLUG_RE.test(body.slug)) {
    return c.json({ error: `invalid slug '${body.slug}' — must match [a-z0-9_-]+` }, 400);
  }
  const entities = config.projects?.entities ?? [];
  if (!entities.find((e) => e.slug === body.entity)) {
    return c.json(
      {
        error: `unknown entity '${body.entity}' — available: ${entities.map((e) => e.slug).join(', ') || '(none configured)'}`,
      },
      400,
    );
  }
  if (await projectExists(body.slug)) {
    return c.json({ error: `project '${body.slug}' already exists` }, 409);
  }
  // Validate paths.
  const paths = body.paths ?? [];
  for (const p of paths) {
    const r = validatePathRef(p.ref, config);
    if (!r.ok) return c.json({ error: r.error }, 400);
  }
  const now = new Date().toISOString();
  const project = ProjectFrontmatterSchema.parse({
    slug: body.slug,
    name: body.name,
    entity: body.entity,
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.color !== undefined ? { color: body.color } : {}),
    tags: body.tags ?? [],
    created: now,
    updated: now,
    ...(body.expires !== undefined ? { expires: body.expires } : {}),
    archived: false,
    paths,
  });
  await writeProject(project);
  logger.info({
    msg: 'project.created',
    via: 'http',
    slug: project.slug,
    entity: project.entity,
    pathCount: project.paths.length,
  });
  return c.json({ project }, 201);
});

app.patch('/projects/:slug', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  const slug = c.req.param('slug');
  if (!PROJECT_SLUG_RE.test(slug)) {
    return c.json({ error: `invalid slug '${slug}'` }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    ops?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(body.ops) || body.ops.length === 0) {
    return c.json({ error: 'body field "ops" must be a non-empty array' }, 400);
  }
  // Delegate to the same applyOps logic used by the tool. We re-import
  // here rather than re-implementing — the projects/tools.ts module
  // doesn't currently export applyOps publicly, so we re-validate via
  // the project_update Zod schema directly. Simpler path: just invoke
  // the registry tool. But we don't have ctx here. Build a minimal
  // one — projects logic only needs config.
  try {
    const current = await readProject(slug);
    if (!current) return c.json({ error: `project '${slug}' not found` }, 404);

    // We mirror the tool's applyOps inline since exporting it would
    // create a circular dep (tools → projects → tools). Keeping the
    // logic in two places is a maintenance smell — if it grows past
    // this we should refactor applyOps into src/projects/. For v1,
    // both versions are tight and obvious.
    const next = { ...current, tags: [...current.tags], paths: current.paths.map((p) => ({ ...p })) };
    for (const opRaw of body.ops) {
      const opName = String(opRaw.op);
      switch (opName) {
        case 'set_field': {
          const field = String(opRaw.field);
          const value = opRaw.value as string | null;
          if (!['name', 'description', 'color', 'expires'].includes(field)) {
            return c.json({ error: `set_field: unknown field '${field}'` }, 400);
          }
          if (field === 'name') {
            if (typeof value !== 'string' || value.trim().length === 0) {
              return c.json({ error: 'set_field name: value must be non-empty string' }, 400);
            }
            next.name = value;
          } else if (field === 'description') {
            if (value === null) delete next.description;
            else next.description = String(value);
          } else if (field === 'color') {
            if (value === null) delete next.color;
            else next.color = String(value);
          } else if (field === 'expires') {
            next.expires = value;
          }
          break;
        }
        case 'add_path': {
          const ref = String(opRaw.ref ?? '');
          const label = opRaw.label as string | undefined;
          const result = validatePathRef(ref, config);
          if (!result.ok) return c.json({ error: `add_path '${ref}': ${result.error}` }, 400);
          if (next.paths.some((p) => p.ref === ref)) {
            return c.json({ error: `add_path: ref '${ref}' already in paths` }, 400);
          }
          next.paths.push({ ref, ...(label ? { label } : {}) });
          break;
        }
        case 'remove_path': {
          const ref = String(opRaw.ref ?? '');
          const idx = next.paths.findIndex((p) => p.ref === ref);
          if (idx < 0) return c.json({ error: `remove_path: no path with ref '${ref}'` }, 400);
          next.paths.splice(idx, 1);
          break;
        }
        case 'set_tags': {
          if (!Array.isArray(opRaw.tags)) {
            return c.json({ error: 'set_tags: tags must be an array' }, 400);
          }
          next.tags = (opRaw.tags as unknown[]).map((t) => String(t));
          break;
        }
        case 'archive': {
          next.archived = true;
          next.archivedAt = new Date().toISOString();
          if (opRaw.reason !== undefined) next.archiveReason = String(opRaw.reason);
          break;
        }
        case 'unarchive': {
          next.archived = false;
          delete next.archivedAt;
          delete next.archiveReason;
          break;
        }
        default:
          return c.json({ error: `unknown op '${opName}'` }, 400);
      }
    }
    next.updated = new Date().toISOString();
    await writeProject(next);
    logger.info({
      msg: 'project.updated',
      via: 'http',
      slug,
      opCount: body.ops.length,
      opTypes: body.ops.map((o) => String(o.op)),
    });
    return c.json({ project: next });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Session-focus routes — read/set/clear the currently-pinned project
// for an (agent, session) pair. Mirrors the tool path's focusProject
// helper so behavior is identical. Emits an SSE `project` event to
// every subscriber of (agent, session) so the UI updates live.

app.get('/agents/:agent/sessions/:session/project', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const meta = await sessionMetaStore.get(agent, session);
  const slug = typeof meta.projectSlug === 'string' ? meta.projectSlug : null;
  if (!slug) return c.json({ agent, session, slug: null, project: null });
  const project = await readProject(slug);
  if (!project) {
    // Session pin points at a deleted project; surface honestly.
    return c.json({ agent, session, slug, project: null, missing: true });
  }
  return c.json({ agent, session, slug, project });
});

app.post('/agents/:agent/sessions/:session/project', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { slug?: string | null };
  // We treat both `{slug:null}` and `{slug:""}` as "clear" so casual
  // clients don't have to be precise. Missing field is rejected — too
  // ambiguous (could be a typo).
  if (!('slug' in body)) {
    return c.json({ error: 'body field "slug" required (string or null)' }, 400);
  }
  const slugIn = body.slug;
  const targetSlug = slugIn && typeof slugIn === 'string' && slugIn.length > 0 ? slugIn : null;
  try {
    const result = await focusProject({
      agent,
      session,
      slug: targetSlug,
      via: 'slash_command',
      metaStore: sessionMetaStore,
    });
    // Live broadcast for any subscribed UI.
    await publish(agent, session, {
      event: 'project',
      data: {
        from: result.previousSlug,
        to: result.currentSlug,
        via: 'slash_command',
      },
    });
    return c.json({ agent, session, ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete('/agents/:agent/sessions/:session/project', async (c) => {
  const gate = requireProjectsEnabled(c);
  if (gate) return gate;
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' not found` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' not found` }, 404);
  try {
    const result = await focusProject({
      agent,
      session,
      slug: null,
      via: 'slash_command',
      metaStore: sessionMetaStore,
    });
    await publish(agent, session, {
      event: 'project',
      data: {
        from: result.previousSlug,
        to: null,
        via: 'slash_command',
      },
    });
    return c.json({ agent, session, cleared: true, previousSlug: result.previousSlug });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.get('/chat/history', async (c) => {
  const agent = c.req.query('agent');
  const sessionRef = c.req.query('session');
  if (!agent || !sessionRef) {
    return c.json({ error: 'query params "agent" and "session" required' }, 400);
  }
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const id = await resolveSessionId(agent, sessionRef);
  if (!id) {
    return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
  }
  // Pagination (Phase 1 web lazy-load): when `limit` is given the
  // server returns only the LAST `limit` events plus a `hasMore` +
  // `oldestTs` marker; subsequent calls supply `before=<oldestTs>` to
  // pull the next older window. Without `limit` the response is the
  // full session — backwards compatible for older clients (TUI
  // hydrates everything anyway, web only opts into paging when it
  // explicitly asks for it).
  //
  // Tool names are normalized through shortToolName so clients render
  // `memory_search` instead of `mcp__somora-memory__memory_search`
  // (claude-cli + codex-cli wrap MCP tools with that prefix). Live SSE
  // already strips it via the per-turn serializer; this endpoint is
  // the parity for the load-from-JSONL path.
  const rawAll = await getHistory(agent, id);
  const all = rawAll.map((e) =>
    e.kind === 'tool_call' ? { ...e, tool: shortToolName(e.tool) } : e,
  );
  const limitParam = c.req.query('limit');
  const beforeParam = c.req.query('before');
  if (!limitParam && !beforeParam) {
    return c.json({ agent, session: id, events: all, hasMore: false });
  }
  const limit = Math.max(1, Math.min(2000, Number(limitParam) || 200));
  const before = beforeParam ? Number(beforeParam) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(before)) {
    return c.json({ error: 'query param "before" must be a numeric timestamp (ms)' }, 400);
  }
  // Same-ts groups are never split across pages — a strict `ts <
  // before` cursor otherwise loses the group remainder forever
  // (Juni-Audit 2026-06; see history-page.ts).
  const page = paginateHistory(all, limit, before);
  return c.json({
    agent,
    session: id,
    events: page.events,
    hasMore: page.hasMore,
    ...(page.oldestTs !== null ? { oldestTs: page.oldestTs } : {}),
  });
});

app.get('/chat/stream', async (c) => {
  const sessionRef = c.req.query('session') ?? 'main';
  const agent = c.req.query('agent') ?? (await defaultAgentFallback());
  if (!agent) {
    return c.json({ error: 'no agents configured — create one in ~/.somora/agents/' }, 400);
  }
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
  }
  return streamSSEH2Safe(c, async (stream) => {
    logger.info({ msg: 'sse.connect', agent, session });
    // Teardown runs from EITHER side — client abort (onAbort) or
    // server-side eviction after a publish timeout (evict hook). Guard
    // against double-execution; on eviction additionally close the
    // stream so the client's EventSource sees EOF and auto-reconnects
    // instead of idling on heartbeats that carry no events.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let done = false;
    let resolveDone: () => void = () => {};
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve; // executor runs synchronously — safe before any await
    });
    const finish = (reason: 'disconnect' | 'evicted'): void => {
      if (done) return;
      done = true;
      if (heartbeat) clearInterval(heartbeat);
      unsub();
      logger.info({ msg: reason === 'evicted' ? 'sse.evicted_closed' : 'sse.disconnect', agent, session });
      resolveDone();
    };
    const unsub = subscribe(
      agent,
      session,
      async (event) => {
        await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
      },
      () => {
        finish('evicted');
        try {
          stream.close();
        } catch {
          /* already closed */
        }
      },
    );
    await stream.writeSSE({ event: 'status', data: JSON.stringify({ msg: 'connected', session }) });
    // Heartbeat keeps TCP alive past Undici's idle-body timeout (~5 min default)
    // and gives the client a positive signal the link is still healthy.
    heartbeat = setInterval(() => {
      stream
        .writeSSE({ event: 'heartbeat', data: String(Date.now()) })
        .catch((err) => logger.debug({ msg: 'sse.heartbeat_fail', session, err: String(err) }));
    }, 20_000);
    stream.onAbort(() => finish('disconnect'));
    await donePromise;
  });
});

// Cross-agent activity feed. One subscription per client (TUI / web /
// mobile) gives streaming dots for every busy agent + unread badges
// for every session with movement since lastSeenAt. See
// src/server/activity-stream.ts for the event vocabulary.
app.get('/activity/stream', async (c) => {
  return streamSSEH2Safe(c, async (stream) => {
    logger.info({ msg: 'activity.connect' });
    const unsub = subscribeActivity(async (event) => {
      await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
    });
    await stream.writeSSE({ event: 'status', data: JSON.stringify({ msg: 'connected' }) });
    const heartbeat = setInterval(() => {
      stream
        .writeSSE({ event: 'heartbeat', data: String(Date.now()) })
        .catch((err) => logger.debug({ msg: 'activity.heartbeat_fail', err: String(err) }));
    }, 20_000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsub();
        logger.info({ msg: 'activity.disconnect' });
        resolve();
      });
    });
  });
});

// "I am looking at this session right now" — clears the unread badge
// across every other open client by broadcasting a `seen` event on
// /activity/stream. Body is optional: `{ts?: ISO}` lets a client
// state an older timestamp (e.g. "I scrolled away N seconds ago");
// the default is now. Server clamps to `max(current, ts)` so a late
// arrival can't regress the seen marker.
app.post('/sessions/:agent/:session/seen', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
  }
  let providedTs: string | undefined;
  try {
    const body = (await c.req.json().catch(() => null)) as { ts?: string } | null;
    if (body && typeof body.ts === 'string') providedTs = body.ts;
  } catch {
    /* empty body fine */
  }
  const seenAt = await markSeen(agent, session, providedTs);
  return c.json({ ok: true, agent, session, seenAt });
});

// Phase Y.B — User-attachment upload. Streams the body into a tmp
// file, sniffs MIME via magic-bytes (extensions are untrusted),
// validates against per-kind caps, hashes, and atomically moves into
// content-addressed storage at ~/.somora/attachments/<sha256>.<ext>.
// Returns the metadata the client then references in /chat/send.
//
// Multipart parsing is intentionally avoided — Hono's parseBody pulls
// the whole body into memory as a Buffer, which would defeat the
// streaming caps. Clients send the raw bytes as the request body
// with Content-Type: <mime> (sniffed server-side anyway) and the
// filename via the X-Somora-Filename header.
app.post('/attachments', async (c) => {
  const rawName =
    c.req.header('X-Somora-Filename') ||
    c.req.header('x-somora-filename') ||
    'unnamed';
  // Filenames travel URL-encoded so non-ASCII / spaces survive HTTP
  // header constraints. Decode before storing — display only.
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    name = rawName;
  }
  const body = c.req.raw.body;
  if (!body) {
    return c.json({ error: 'request body required' }, 400);
  }
  try {
    const stored = await storeAttachment({
      body,
      name,
      config: config.attachments,
    });
    logger.info({
      msg: 'attachments.stored',
      hash: stored.hash,
      name: stored.name,
      mime: stored.mime.mimeType,
      kind: stored.mime.kind,
      size: stored.size,
    });
    return c.json({
      hash: stored.hash,
      name: stored.name,
      mime: stored.mime.mimeType,
      kind: stored.mime.kind,
      size: stored.size,
    });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ msg: 'attachments.store_failed', name, err: msg });
    return c.json({ error: msg }, 400);
  }
});

// Serve a stored attachment by hash. Used by the web client to
// display thumbnails of past-turn user-attachments (the bytes never
// re-travel on /chat/send, so the bubble row needs a way to fetch
// them). Loopback-trust same as everything else; sniffs MIME from
// disk so a renamed-on-disk file can't claim a different content
// type than its bytes say.
app.get('/attachments/:hash', async (c) => {
  const hash = c.req.param('hash');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return c.json({ error: 'invalid hash' }, 400);
  }
  const candidates = ['png', 'jpg', 'gif', 'webp', 'pdf', 'txt', 'bin'];
  for (const ext of candidates) {
    const p = `${SOMORA_HOME_DIR}/attachments/${hash}.${ext}`;
    if (existsSync(p)) {
      const bytes = await fsReadFile(p);
      const sniffed = await detectMimeFromPath(p);
      return new Response(bytes, {
        headers: {
          'Content-Type': sniffed.mimeType,
          // Long-cache: content is content-addressed, hash never re-issues different bytes.
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }
  }
  return c.json({ error: 'not found' }, 404);
});

// ─────────────────────────────────────────────────────────────────────
// Image generation
//
// Same core the `image_generate` tool uses (src/imagegen/), so the web
// app and the agents cannot end up with different capabilities.
//
// Files are served by RECORD ID, never by path. The client has no way
// to ask for an arbitrary file: the id is looked up in the metadata
// store and the path comes from there. That's what lets the images
// directory be user-chosen without turning this route into a way to
// read anything on the disk.
// ─────────────────────────────────────────────────────────────────────

function imageGenReady(): { ok: boolean; reason?: string } {
  const cfg = config.imageGen;
  if (!cfg?.enabled) return { ok: false, reason: 'imageGen not enabled in config.yaml' };
  if (cfg.models.length === 0) return { ok: false, reason: 'no models under imageGen.models' };
  return { ok: true };
}

/** Drives the desktop tile's visibility, like /wiki/status does for the
 *  wiki. A tile that opens a window which can only say "not configured"
 *  is worse than no tile. */
app.get('/images/status', (c) => {
  const ready = imageGenReady();
  if (!ready.ok) return c.json({ enabled: false });
  const cfg = config.imageGen!;
  return c.json({
    enabled: true,
    outputDir: expandHome(cfg.outputDir),
    maxImagesPerTurn: cfg.maxImagesPerTurn,
    models: cfg.models.map((m) => ({
      name: m.name,
      label: m.label ?? m.name,
      model: m.model,
      provider: m.provider,
      defaults: m.defaults,
    })),
  });
});

/** Per-model spec vocabulary for the form. Fields the catalog doesn't
 *  pin down come back as null, and the UI then offers a free-text input
 *  rather than an empty dropdown — unknown must not read as "nothing
 *  allowed". */
app.get('/images/models/:name/capabilities', async (c) => {
  const ready = imageGenReady();
  if (!ready.ok) return c.json({ error: ready.reason }, 503);
  const name = c.req.param('name');
  const entry = config.imageGen!.models.find((m) => m.name === name);
  if (!entry) return c.json({ error: `unknown image model '${name}'` }, 404);
  const provider = config.providers[entry.provider];
  if (!provider || provider.engine !== 'openai-compatible') {
    return c.json({ error: `provider '${entry.provider}' is not openai-compatible` }, 500);
  }
  const caps = await resolveImageCapabilities(entry.provider, provider, entry);
  return c.json({
    model: entry.name,
    source: caps.source,
    known: caps.known,
    values: caps.values,
    // null ⇒ unknown, and the client should offer every field as free
    // input. A list ⇒ authoritative, and anything not in it is a field
    // this model does not take.
    supported: caps.supported ?? null,
    maxN: caps.maxN ?? null,
    maxReferences: caps.maxReferences ?? null,
    defaults: entry.defaults,
  });
});

/** What the provider offers, so configuring a new model doesn't mean
 *  hunting for the exact wire id on a website. Read-only: config stays
 *  the source of truth for what somora will actually call. */
app.get('/images/catalog', async (c) => {
  const ready = imageGenReady();
  if (!ready.ok) return c.json({ error: ready.reason }, 503);
  const providerName = c.req.query('provider') ?? config.imageGen!.models[0]?.provider;
  const provider = providerName ? config.providers[providerName] : undefined;
  if (!provider || provider.engine !== 'openai-compatible') {
    return c.json({ error: `unknown or incompatible provider '${providerName}'` }, 400);
  }
  const endpoint =
    config.imageGen!.models.find((m) => m.provider === providerName)?.capabilitiesEndpoint ??
    '/images/models';
  const models = await listImageCatalogModels(providerName!, provider, endpoint);
  return c.json({ provider: providerName, models });
});

app.get('/images', async (c) => {
  const ready = imageGenReady();
  if (!ready.ok) return c.json({ error: ready.reason }, 503);
  const q = c.req.query();
  const limit = Math.min(Number(q.limit) || 60, 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const result = await listImageRecords({
    ...(q.query ? { query: q.query } : {}),
    ...(q.model ? { model: q.model } : {}),
    ...(q.agent ? { agent: q.agent } : {}),
    ...(q.since ? { since: q.since } : {}),
    ...(q.until ? { until: q.until } : {}),
    limit,
    offset,
  });
  return c.json({
    total: result.total,
    offset,
    images: result.images,
    totalBytes: await imageTotalBytes(),
  });
});

app.get('/images/:id', async (c) => {
  const record = await readImageRecord(c.req.param('id'));
  if (!record) return c.json({ error: 'not found' }, 404);
  return c.json(record);
});

app.get('/images/:id/file', async (c) => {
  const record = await readImageRecord(c.req.param('id'));
  if (!record) return c.json({ error: 'not found' }, 404);
  if (!existsSync(record.path)) {
    // The file was moved or deleted outside somora. Say so plainly —
    // a bare 404 reads like a broken gallery.
    return c.json({ error: 'file missing on disk', path: record.path }, 410);
  }
  const bytes = await fsReadFile(record.path);
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': record.mime,
      'Content-Disposition': `inline; filename="${encodeURIComponent(record.filename)}"`,
      // Records are immutable once written; a re-generation gets a new
      // id, so the bytes behind an id never change.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
});

app.post('/images/generate', async (c) => {
  const ready = imageGenReady();
  if (!ready.ok) return c.json({ error: ready.reason }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'body must be JSON' }, 400);
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return c.json({ error: 'prompt is required' }, 400);

  const specs: Record<string, unknown> = {};
  for (const key of [
    'resolution',
    'aspect_ratio',
    'size',
    'quality',
    'output_format',
    'background',
    'output_compression',
    'seed',
    'n',
    'steps',
    'cfg',
    'guidance',
  ]) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') specs[key] = body[key];
  }

  // The browser is the user's own agent here — no write-policy gate,
  // same as any other place the user names a path in their own UI.
  const saveTo = typeof body.save_to === 'string' && body.save_to.trim() ? body.save_to.trim() : undefined;

  try {
    const result = await generateImage(
      {
        prompt,
        ...(typeof body.model === 'string' ? { model: body.model } : {}),
        specs: specs as Parameters<typeof generateImage>[0]['specs'],
        ...(saveTo ? { saveTo } : {}),
        // The browser has bytes, not a server path — see
        // src/imagegen/references.ts on why the two entrances differ.
        ...(Array.isArray(body.reference_images)
          ? {
              references: body.reference_images
                .filter((r): r is string => typeof r === 'string')
                .map((r, i) => referenceFromBase64(r, i)),
            }
          : {}),
        ...(typeof body.session === 'string' ? { session: body.session } : {}),
      },
      config,
    );
    return c.json({
      images: result.images,
      costUsd: result.costUsd ?? null,
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.fellBackFrom ? { fellBackFrom: result.fellBackFrom } : {}),
    });
  } catch (err) {
    if (err instanceof ImageGenError) {
      // 400 for anything the caller can fix, 502 for an upstream that
      // misbehaved — the UI shows the message either way, but the
      // status tells it whether to blame the form or the provider.
      const status =
        err.kind === 'unavailable' ? 503 : err.kind === 'upstream' ? 502 : 400;
      return c.json({ error: err.message, kind: err.kind }, status);
    }
    logger.error({ msg: 'images.generate_failed', err: (err as Error).message });
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.delete('/images/:id', async (c) => {
  const id = c.req.param('id');
  const record = await readImageRecord(id);
  if (!record) return c.json({ error: 'not found' }, 404);
  // Only the metadata goes; the file stays. Deleting user files from a
  // gallery button is not something to do on one click, and hardlinks
  // mean somora couldn't reliably reach every name for it anyway.
  const ok = await deleteImageRecord(id);
  return c.json({ ok, path: record.path, fileKept: true });
});

// Speech-to-Text. Web mic button POSTs multipart with `file` (audio
// blob); we forward to the configured OpenAI-compatible STT endpoint
// (oMLX `/v1/audio/transcriptions`, faster-whisper-server, OpenAI, …)
// and return `{text}`. Standalone surface so the STT model never leaks
// into chat-model registries.
app.get('/stt/config', (c) => {
  const stt = config.stt;
  if (!stt?.enabled) return c.json({ enabled: false });
  const provider = config.providers[stt.provider];
  const ok = provider?.engine === 'openai-compatible';
  return c.json({
    enabled: ok,
    language: stt.language ?? null,
  });
});

app.post('/stt/transcribe', async (c) => {
  const stt = config.stt;
  if (!stt?.enabled) {
    return c.json({ error: 'stt not enabled in config.yaml' }, 503);
  }
  const provider = config.providers[stt.provider];
  if (!provider) {
    return c.json({ error: `stt.provider '${stt.provider}' not found in providers` }, 500);
  }
  if (provider.engine !== 'openai-compatible') {
    return c.json({ error: `stt.provider '${stt.provider}' is engine '${provider.engine}', needs openai-compatible` }, 500);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data with a `file` field' }, 400);
  }
  const audio = form.get('file');
  if (!(audio instanceof Blob)) {
    return c.json({ error: "missing or invalid `file` field" }, 400);
  }
  const language = (form.get('language') as string | null) || stt.language;

  // Re-encode multipart for the upstream so we don't depend on Hono's
  // boundary surviving the proxy. The audio Blob is re-attached with a
  // sensible filename (upstream sniffs format from bytes, not name —
  // but mlx-audio routes some video containers via the extension).
  const fwd = new FormData();
  const filename = audio instanceof File && audio.name ? audio.name : guessAudioFilename(audio.type);
  fwd.append('file', audio, filename);
  fwd.append('model', stt.model);
  if (language) fwd.append('language', language);

  const url = provider.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

  const startedAt = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: fwd });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ msg: 'stt.upstream_unreachable', url, err: msg });
    return c.json({ error: `STT upstream unreachable: ${msg}` }, 502);
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    logger.warn({ msg: 'stt.upstream_error', status: upstream.status, body: text.slice(0, 500) });
    return c.json({ error: `STT upstream returned ${upstream.status}` }, 502);
  }
  let data: { text?: string };
  try {
    data = (await upstream.json()) as { text?: string };
  } catch (err) {
    return c.json({ error: `STT upstream returned non-JSON: ${(err as Error).message}` }, 502);
  }
  if (typeof data.text !== 'string') {
    return c.json({ error: 'STT upstream JSON missing `text` field' }, 502);
  }
  logger.info({
    msg: 'stt.transcribed',
    provider: stt.provider,
    model: stt.model,
    language: language ?? null,
    audioBytes: audio.size,
    chars: data.text.length,
    ms: Date.now() - startedAt,
  });
  return c.json({ text: data.text });
});

function guessAudioFilename(mime: string): string {
  if (mime.includes('webm')) return 'recording.webm';
  if (mime.includes('ogg')) return 'recording.ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'recording.m4a';
  if (mime.includes('wav')) return 'recording.wav';
  if (mime.includes('mpeg')) return 'recording.mp3';
  return 'recording.bin';
}

// ─────────────────────────────────────────────────────────────────────
// TTS — text → audio synthesis. Mirrors the /stt/* surface: proxy +
// content-addressed cache. See docs/voice.md.
// ─────────────────────────────────────────────────────────────────────

app.get('/tts/config', (c) => {
  const tts = config.tts;
  if (!tts?.enabled) return c.json({ enabled: false });
  const provider = config.providers[tts.provider];
  const ok = provider?.engine === 'openai-compatible';
  if (!ok) return c.json({ enabled: false });
  // Match what /tts/synthesize will actually deliver. If reencode is
  // off, only WAV is advertised; otherwise the negotiator can produce
  // opus and mp4.
  const formats = ['audio/wav'];
  if (tts.reencode.enabled) {
    formats.push('audio/opus', 'audio/mp4');
  }
  return c.json({
    enabled: true,
    formats,
    language: tts.language ?? null,
    voice: tts.voice ?? null,
    clients: {
      web: tts.clients.web,
      mobile: tts.clients.mobile,
    },
  });
});

app.post('/tts/synthesize', async (c) => {
  const tts = config.tts;
  if (!tts?.enabled) {
    return c.json({ error: 'tts not enabled in config.yaml' }, 503);
  }
  let body: { text?: string; voice?: string; language?: string; agent?: string };
  try {
    body = (await c.req.json()) as {
      text?: string;
      voice?: string;
      language?: string;
      agent?: string;
    };
  } catch {
    return c.json({ error: 'expected JSON body with `text`' }, 400);
  }
  if (!body.text || typeof body.text !== 'string' || body.text.trim().length === 0) {
    return c.json({ error: 'missing or empty `text`' }, 400);
  }
  if (body.text.length > 4000) {
    return c.json({ error: 'text exceeds 4000-char hard cap' }, 400);
  }

  const accept = c.req.header('accept');
  const spec = negotiateFormat(accept, tts.reencode.enabled);

  try {
    const result = await synthesize(
      {
        text: body.text,
        ...(body.voice ? { voice: body.voice } : {}),
        ...(body.language ? { language: body.language } : {}),
        ...(body.agent ? { agent: body.agent } : {}),
        format: spec.fmt,
      },
      config,
    );
    return c.body(new Uint8Array(result.bytes), 200, {
      'content-type': result.mime,
      'content-length': String(result.bytes.length),
      'x-tts-cache': result.cacheHit ? 'hit' : 'miss',
      'x-tts-cache-key': result.cacheKey,
      ...(result.durationMs !== undefined ? { 'x-tts-duration-ms': String(result.durationMs) } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message;
    logger.warn({ msg: 'tts.synthesize_failed', err: msg, chars: body.text.length });
    return c.json({ error: msg }, 502);
  }
});

app.get('/tts/cache/:filename', async (c) => {
  const filename = c.req.param('filename');
  // Strict filename validation: must be `<64-hex>.<ext>` where ext is
  // one of the known formats. Prevents `..` traversal + arbitrary
  // path reads via the cache route.
  const match = /^([0-9a-f]{64})\.(wav|opus|m4a)$/.exec(filename);
  if (!match) {
    return c.json({ error: 'invalid cache filename' }, 400);
  }
  const cacheKey = match[1]!;
  const ext = match[2]!;
  const fmt: 'wav' | 'opus' | 'mp4' = ext === 'm4a' ? 'mp4' : (ext as 'wav' | 'opus');
  const stat = cacheFileStat(cacheKey, fmt);
  if (!stat) {
    return c.json({ error: 'cache miss' }, 404);
  }
  // Stream the file with the right content-type. Hono's c.body
  // accepts a ReadableStream; node:fs createReadStream works.
  const { createReadStream } = await import('node:fs');
  const mime = fmt === 'wav' ? 'audio/wav' : fmt === 'opus' ? 'audio/opus' : 'audio/mp4';
  // Range support — basic single-range parser for mobile <audio>
  // seek/scrub. Returns full 200 when no Range header, 206 when
  // valid range, 416 on parse error.
  const range = c.req.header('range');
  if (range && range.startsWith('bytes=')) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range);
    if (m) {
      const start = parseInt(m[1]!, 10);
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start <= end && end < stat.size) {
        const stream = createReadStream(stat.path, { start, end });
        return c.body(stream as unknown as ReadableStream, 206, {
          'content-type': mime,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
        });
      }
      return c.body(null, 416, { 'content-range': `bytes */${stat.size}` });
    }
  }
  const stream = createReadStream(stat.path);
  return c.body(stream as unknown as ReadableStream, 200, {
    'content-type': mime,
    'content-length': String(stat.size),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  });
});

// ─────────────────────────────────────────────────────────────────────
// /voice/turn — audio in → STT → run turn → TTS → audio out.
// Independent of the chat-window auto-play toggle: this endpoint
// always synthesizes audio for display-less / integration clients
// (panels, voice satellites, bridges). See docs/voice.md.
// ─────────────────────────────────────────────────────────────────────

app.post('/voice/turn', async (c) => {
  const stt = config.stt;
  const tts = config.tts;
  if (!stt?.enabled) {
    return c.json({ error: 'stt not enabled in config.yaml' }, 503);
  }
  if (!tts?.enabled) {
    return c.json({ error: 'tts not enabled in config.yaml' }, 503);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data' }, 400);
  }

  const agent = (form.get('agent') as string | null) ?? (await defaultAgentFallback());
  if (!agent) {
    return c.json({ error: 'agent required (and no fallback configured)' }, 400);
  }
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }

  const sessionRef = (form.get('session') as string | null) ?? 'main';
  const audio = form.get('audio');
  if (!(audio instanceof Blob)) {
    return c.json({ error: 'missing or invalid `audio` field' }, 400);
  }
  const voice = (form.get('voice') as string | null) || tts.voice || undefined;
  const language = (form.get('language') as string | null) || tts.language || undefined;
  const acceptHeader = c.req.header('accept');

  // ── Session resolver (same shape as /spawn-async fix) ──
  let session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    const isExactId = /^\d{8}-\d{6}_[A-Za-z0-9_-]+$/.test(sessionRef);
    if (isExactId) {
      return c.json({ error: `session '${sessionRef}' not found` }, 404);
    }
    if (sessionRef === 'main') {
      session = 'main';
    } else {
      try {
        session = await createSession(agent, sessionRef);
      } catch (err) {
        return c.json({ error: `session create failed: ${(err as Error).message}` }, 400);
      }
    }
  }

  const turnId = randomUUID();
  const startedAt = Date.now();
  logger.info({
    msg: 'voice.turn.start',
    turnId,
    agent,
    session,
    audioBytes: audio.size,
    audioType: audio.type,
  });

  // ── 1. STT via existing upstream ──
  const sttProvider = config.providers[stt.provider];
  if (!sttProvider || sttProvider.engine !== 'openai-compatible') {
    return c.json({ error: 'stt provider misconfigured' }, 500);
  }
  const sttFwd = new FormData();
  const sttName = audio instanceof File && audio.name ? audio.name : guessAudioFilename(audio.type);
  sttFwd.append('file', audio, sttName);
  sttFwd.append('model', stt.model);
  if (stt.language) sttFwd.append('language', stt.language);
  const sttUrl = sttProvider.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const sttHeaders: Record<string, string> = {};
  if (sttProvider.apiKey) sttHeaders.Authorization = `Bearer ${sttProvider.apiKey}`;
  let transcript: string;
  try {
    const r = await fetch(sttUrl, { method: 'POST', headers: sttHeaders, body: sttFwd });
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      logger.warn({ msg: 'voice.turn.stt_failed', status: r.status, body: errBody.slice(0, 300) });
      return c.json({ error: `stt upstream returned ${r.status}` }, 502);
    }
    const j = (await r.json()) as { text?: string };
    if (typeof j.text !== 'string' || j.text.trim().length === 0) {
      return c.json({ error: 'stt produced empty transcript' }, 502);
    }
    transcript = j.text;
  } catch (err) {
    return c.json({ error: `stt unreachable: ${(err as Error).message}` }, 502);
  }
  logger.info({ msg: 'voice.turn.stt_done', turnId, chars: transcript.length });

  // ── 2. Run normal agent turn (under the session lock) ──
  let assistantText = '';
  const release = await acquireSessionLock(agent, session, { priority: 'user', turnId });
  const abort = registerChatAbort(agent, session);
  try {
    const collected: string[] = [];
    await runChatTurn({
      agent,
      session,
      text: transcript,
      turnId,
      signal: abort.signal,
      inputModality: 'voice',
      sttProvider: stt.provider,
      // autoPlayRequested intentionally OFF — /voice/turn synthesizes
      // synchronously below; we don't want the run-turn hook to fire
      // a duplicate background TTS too.
      publishSse: async (event) => {
        if (event.event === 'chat' && event.data.state === 'final') {
          collected.push(event.data.text);
        }
        // Live broadcast — without this, open web/mobile clients on
        // the same session see the turn ONLY after a hard refresh.
        // Same pattern as the sentinel-trigger SSE fix in .17.07.
        await publish(agent, session, event);
      },
      deps: chatTurnDeps,
    });
    assistantText = collected.join('').trim();
  } finally {
    abort.release();
    release();
  }

  if (!assistantText) {
    return c.json({ error: 'agent produced empty reply' }, 502);
  }

  // ── 3. Sanitize + synthesize ──
  const prepared = prepareForTts(assistantText);
  if (prepared.skipped) {
    // Voice clients still want SOMETHING. Fall back to a brief
    // spoken summary marker so the panel/bridge knows it was
    // intentional, not silence.
    prepared.text =
      'The reply contains structured content and will not be read aloud. Please check the chat history.';
    prepared.skipped = false;
  }

  const spec = negotiateFormat(acceptHeader, tts.reencode.enabled);
  let synth;
  try {
    synth = await synthesize(
      {
        text: prepared.text,
        ...(voice ? { voice } : {}),
        ...(language ? { language } : {}),
        format: spec.fmt,
        agent,
      },
      config,
    );
  } catch (err) {
    return c.json({ error: `tts failed: ${(err as Error).message}` }, 502);
  }
  const audioUrl = `/tts/cache/${synth.cacheKey}.${synth.ext}`;

  // ── 4. Append assistant_audio + SSE broadcast (for live watchers) ──
  await appendEvent(agent, session, {
    kind: 'assistant_audio',
    ts: Date.now(),
    engine: 'voice-turn',
    turnId,
    audio: {
      url: audioUrl,
      mime: synth.mime,
      ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
      cacheKey: synth.cacheKey,
    },
  });
  await publish(agent, session, {
    event: 'assistant_audio',
    data: {
      turnId,
      url: audioUrl,
      mime: synth.mime,
      ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
      cacheKey: synth.cacheKey,
    },
  });

  logger.info({
    msg: 'voice.turn.done',
    turnId,
    agent,
    session,
    transcriptChars: transcript.length,
    replyChars: assistantText.length,
    audioBytes: synth.bytes.length,
    cacheHit: synth.cacheHit,
    totalMs: Date.now() - startedAt,
  });

  return c.json({
    ok: true,
    agent,
    session,
    transcript,
    text: assistantText,
    audio: {
      url: audioUrl,
      mime: synth.mime,
      ...(synth.durationMs !== undefined ? { durationMs: synth.durationMs } : {}),
      cacheKey: synth.cacheKey,
    },
  });
});

app.post('/chat/send', async (c) => {
  const body = (await c.req.json()) as {
    agent?: string;
    session?: string;
    text?: string;
    /**
     * A2A attribution. When set, this turn's user_message is treated
     * as written by the named somora agent (not by the human user).
     * Used by the `agent_ask` tool to post a question into another
     * agent's session. Persists in JSONL as user_message.from_agent.
     */
    from_agent?: string;
    /** A2A correlation UUID. Persisted on user_message.agent_ask_call_id. */
    agent_ask_call_id?: string;
    /** Sub-agent nesting depth (0 = top-level). Reserved for future spawn flow. */
    subagent_depth?: number;
    /** Phase Y.B — files the user attached to this turn. Each entry is
     *  the response shape returned by POST /attachments. Bytes are NOT
     *  inline; the server resolves hash → ~/.somora/attachments path. */
    attachments?: Array<{ hash: string; name: string; mime: string; size: number }>;
    /** Voice — set when the client filled the input via STT (mic-button
     *  on web/mobile). Persists on user_message.input.modality and
     *  unlocks the auto-TTS hook (in concert with autoPlayRequested). */
    input_modality?: 'text' | 'voice';
    /** Voice — provider tag for the STT path used (e.g. "omlx"). */
    stt_provider?: string;
    /** Voice — does the client want a spoken reply for this turn?
     *  Driven by the per-session "auto-play" toggle in the chat header.
     *  Only honored together with `input_modality === 'voice'`. */
    auto_play_requested?: boolean;
  };
  const agent = body.agent ?? (await defaultAgentFallback());
  if (!agent) {
    return c.json({ error: 'no agents configured — create one in ~/.somora/agents/' }, 400);
  }
  const sessionRef = body.session ?? 'main';
  const text = body.text ?? '';
  const fromAgent =
    typeof body.from_agent === 'string' && body.from_agent.length > 0 ? body.from_agent : undefined;
  const agentAskCallId =
    typeof body.agent_ask_call_id === 'string' && body.agent_ask_call_id.length > 0
      ? body.agent_ask_call_id
      : undefined;
  const subagentDepth =
    typeof body.subagent_depth === 'number' && body.subagent_depth > 0 ? body.subagent_depth : 0;

  if (!(await loadPersona(agent))) {
    logger.warn({ msg: 'chat.send.unknown_agent', agent });
    return c.json({ error: `agent '${agent}' not found — create ~/.somora/agents/${agent}/AGENTS.md` }, 404);
  }

  const session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    return c.json(
      {
        error: `session '${sessionRef}' not found for agent '${agent}' — create one via POST /agents/${agent}/sessions { "slug": "${sessionRef}" }`,
      },
      404,
    );
  }

  // Generate the turn-lifecycle id up here so the HTTP-layer log line
  // already carries it. runChatTurn re-uses this same id for every
  // subsequent stage log (turn.started / .engine_init / .first_event /
  // .completed / .failed). Forensic chain from HTTP acceptance through
  // engine completion.
  const turnId = randomUUID();
  logger.info({
    msg: 'chat.send',
    turnId,
    agent,
    session,
    ref: sessionRef,
    len: text.length,
  });

  // Fire-and-forget. Acquire the per-session lock with priority='user'
  // (default for /chat/send unless from_agent is set, in which case the
  // call is acting as A2A and yields to actual user turns). Release in
  // the finally block — forgetting deadlocks future turns on the session.
  const priority: 'user' | 'agent' = fromAgent ? 'agent' : 'user';
  void (async () => {
    logger.info({ msg: 'turn.queued', turnId, agent, session, priority });
    const release = await acquireSessionLock(agent, session, {
      priority,
      turnId,
      ...(agentAskCallId ? { callId: agentAskCallId } : {}),
      // When the lock is busy and we have to wait, broadcast a
      // turn_queued SSE so any client that already accepted this
      // turn's optimistic user-bubble (matched by turnId from the
      // HTTP response below) can tag the bubble with a "queued"
      // marker until runChatTurn actually fires the user_message
      // event a few seconds later.
      onQueued: (ahead) => {
        void publish(agent, session, {
          event: 'turn_queued',
          data: { turnId, ahead },
        });
      },
    });
    // Register the per-session AbortController. /chat/abort looks this
    // up to cancel the in-flight turn — typically from TUI ESC.
    const abort = registerChatAbort(agent, session);
    try {
      await runChatTurn({
        agent,
        session,
        text,
        turnId,
        signal: abort.signal,
        ...(fromAgent ? { fromAgent } : {}),
        ...(agentAskCallId ? { agentAskCallId } : {}),
        ...(subagentDepth > 0 ? { subagentDepth } : {}),
        ...(body.attachments && body.attachments.length > 0
          ? { attachments: body.attachments }
          : {}),
        ...(body.input_modality === 'voice' ? { inputModality: 'voice' as const } : {}),
        ...(body.stt_provider ? { sttProvider: body.stt_provider } : {}),
        ...(body.auto_play_requested ? { autoPlayRequested: true } : {}),
        publishSse: (event) => publish(agent, session, event),
        deps: chatTurnDeps,
      });
    } catch (err) {
      logger.error({
        msg: 'chat.send.run_failed',
        turnId,
        agent,
        session,
        err: (err as Error).message,
      });
      void publish(agent, session, { event: 'status', data: { msg: `turn failed: ${(err as Error).message}` } });
    } finally {
      abort.release();
      release();
    }
  })();

  // User just spoke → cancel any in-flight auto-dream for this agent
  // and reset the idle countdown. (resetActivity is also called inside
  // runChatTurn, but doing it here ensures the cancel happens BEFORE
  // the turn even starts processing.)
  remWorker.resetActivity(agent);

  // turnId is echoed back so clients can pair the optimistic bubble
  // they just rendered with future SSE events (turn_queued while
  // waiting, user_message once the lock is acquired and the turn
  // actually starts). Used by the queue-indicator UX added with
  // 2026.05.23.x.
  return c.json({ ok: true, turnId }, 202);
});

// /chat/abort — cancel an in-flight turn for (agent, session). Triggered
// by TUI ESC while streaming. Idempotent: returns aborted=false when no
// turn is running. Doesn't block — the engine adapter sees the signal
// and bails out, then runChatTurn's finally releases the controller.
//
// The session ref MUST be resolved the same way /chat/send resolves it:
// the abort registry is keyed by the canonical session id, so a raw
// slug here silently missed the registry and the abort was a no-op
// (aborted:false, no log — Rene's 2026-07-22 report, live-reproduced
// 2026-07-27: slug → false while the turn ran, canonical id → clean
// abort). Falls back to the raw ref when resolution fails so turns
// registered under non-canonical ids (spawn-async bypass sessions)
// stay abortable.
app.post('/chat/abort', async (c) => {
  const agent = c.req.query('agent') ?? (await defaultAgentFallback());
  if (!agent) {
    return c.json({ error: 'no agents configured' }, 400);
  }
  const sessionRef = c.req.query('session') ?? 'main';
  const session = (await resolveSessionId(agent, sessionRef)) ?? sessionRef;
  const result = triggerChatAbort(agent, session);
  if (!result.aborted) {
    logger.info({
      msg: 'chat.abort.no_active_turn',
      agent,
      session,
      ref: sessionRef,
      hint: 'nothing registered under this session — turn already finished, or the ref does not match the running turn',
    });
  }
  return c.json({ agent, session, ...result });
});

// /chat/send-sync — same input as /chat/send, but blocks until the turn
// completes and returns the result as JSON instead of streaming events
// to SSE subscribers. Used by spawn_subagent's MCP-passthrough path so
// that claude-cli/codex-cli MCP-served tools can delegate by HTTPing
// back to the localhost server (the in-process runChatTurn isn't
// reachable from the MCP child process).
//
// 127.0.0.1-only by virtue of how the server is bound; same trust
// posture as the existing debug endpoints.
app.post('/chat/send-sync', async (c) => {
  const body = (await c.req.json()) as {
    agent?: string;
    session?: string;
    text?: string;
    from_agent?: string;
    waiter_agent?: string;
    waiter_session?: string;
    agent_ask_call_id?: string;
    subagent_depth?: number;
    model?: string;
    max_rounds?: number;
  };
  const agent = body.agent ?? (await defaultAgentFallback());
  if (!agent) {
    return c.json({ error: 'no agents configured' }, 400);
  }
  const sessionRef = body.session ?? 'main';
  const text = body.text ?? '';
  const fromAgent =
    typeof body.from_agent === 'string' && body.from_agent.length > 0 ? body.from_agent : undefined;
  // waiter_* identify the CALLER TURN that blocks on this request, for
  // circular-wait detection. Deliberately separate from from_agent:
  // from_agent changes message semantics in the target's session (the
  // user_message is labeled as A2A), while waiter_* is pure wait-graph
  // bookkeeping. agent_ask sends both; spawn_subagent's wait:true HTTP
  // fallback sends only waiter_* (a sub's task text must stay a plain
  // user task, not an A2A message).
  const waiterAgent =
    typeof body.waiter_agent === 'string' && body.waiter_agent.length > 0
      ? body.waiter_agent
      : undefined;
  const waiterSession =
    typeof body.waiter_session === 'string' && body.waiter_session.length > 0
      ? body.waiter_session
      : undefined;
  const agentAskCallId =
    typeof body.agent_ask_call_id === 'string' && body.agent_ask_call_id.length > 0
      ? body.agent_ask_call_id
      : undefined;
  const subagentDepth =
    typeof body.subagent_depth === 'number' && body.subagent_depth > 0 ? body.subagent_depth : 0;
  const modelOverride =
    typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;
  const maxRoundsOverride =
    typeof body.max_rounds === 'number' && body.max_rounds > 0 ? body.max_rounds : undefined;

  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    return c.json({ error: `session '${sessionRef}' not found for agent '${agent}'` }, 404);
  }

  // Acquire the session lock. A from_agent caller (agent_ask, sub-spawn)
  // queues with priority='agent' and yields to any human user turn that
  // arrives in parallel. A direct user-side caller of /chat/send-sync
  // (rare — TUI uses /chat/send) gets priority='user'.
  //
  // Sub-spawn destinations are fresh sessions (sub-xxx-yyy), so the lock
  // is uncontended in that path; cost is one Map lookup + a Promise.
  // Circular-wait (deadlock) guard for blocking A2A calls (agent_ask +
  // spawn_subagent wait:true via HTTP fallback). Only callers that
  // identify their own blocked turn (waiter_*) participate — check +
  // register are synchronous back-to-back so concurrent calls can't
  // both slip past. The edge must be registered BEFORE
  // acquireSessionLock: the caller is already waiting while this
  // request queues on the target's lock. See
  // src/server/ask-wait-graph.ts for the full coverage map.
  let releaseWait: (() => void) | undefined;
  if (waiterAgent && waiterSession) {
    const waitFrom = { agent: waiterAgent, session: waiterSession };
    const waitTo = { agent, session };
    const cycle = findWaitCycle(waitFrom, waitTo);
    if (cycle) {
      logger.warn({
        msg: 'a2a.circular_wait_rejected',
        from: `${waiterAgent}/${waiterSession}`,
        to: `${agent}/${session}`,
        chain: cycle,
      });
      return c.json(
        {
          error:
            `circular A2A wait: ${agent}/${session} is already waiting on ` +
            `${waiterAgent}/${waiterSession} (wait chain: ${cycle.join(' → ')}). ` +
            `This call would deadlock both turns.`,
          circular_wait: true,
          chain: cycle,
        },
        409,
      );
    }
    releaseWait = registerWait(waitFrom, waitTo);
  }

  const priority: 'user' | 'agent' = fromAgent ? 'agent' : 'user';
  try {
    const release = await acquireSessionLock(agent, session, {
      priority,
      ...(agentAskCallId ? { callId: agentAskCallId } : {}),
    });
    try {
      const result = await runChatTurn({
        agent,
        session,
        text,
        ...(fromAgent ? { fromAgent } : {}),
        ...(agentAskCallId ? { agentAskCallId } : {}),
        ...(subagentDepth > 0 ? { subagentDepth } : {}),
        ...(modelOverride ? { modelOverride } : {}),
        ...(maxRoundsOverride
          ? { agentLoopOverride: { maxRounds: maxRoundsOverride } }
          : {}),
        // Publish to SSE subscribers too — a human watching this session
        // sees A2A inbound user_messages and the assistant's reply appear
        // live, not just on session refresh.
        publishSse: (event) => publish(agent, session, event),
        deps: chatTurnDeps,
      });
      return c.json(result);
    } finally {
      release();
    }
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    releaseWait?.();
  }
});

// /spawn-async — fire-and-forget version of /chat/send-sync, used by
// spawn_subagent with wait:false. Returns a task_id immediately; the
// turn runs in the background. Status/result via /spawn-status and
// /spawn-result.
app.post('/spawn-async', async (c) => {
  const body = (await c.req.json()) as {
    agent?: string;
    session?: string;
    text?: string;
    from_agent?: string;
    parent_agent?: string;
    parent_session?: string;
    subagent_depth?: number;
    model?: string;
    max_rounds?: number;
    attention?: boolean;
  };
  const agent = body.agent;
  const sessionRef = body.session;
  const text = body.text ?? '';
  if (!agent || !sessionRef) {
    return c.json({ error: 'agent + session required' }, 400);
  }
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' not found` }, 404);
  }

  // Resolve the session ref through the same path the rest of the
  // server uses. Pre-fix (2026-05-16 audit), this endpoint took the
  // session string verbatim and wrote a JSONL with that as the
  // filename — bypassing createSession's <YYYYMMDD-HHMMSS>_<slug>
  // format. Result: sessions visible in `GET /agents/<a>/sessions`
  // (filesystem scan) but invisible to resolveSessionId, so archive/
  // delete/edit through the UI silently 404'd.
  //
  // Fix policy:
  //   - existing session → use as-is
  //   - exact-id shape (timestamped) but not existing → 404 (caller
  //     asked for a SPECIFIC archived session that's gone — auto-
  //     creating a new one with that name would be confusing)
  //   - slug shape, not existing → auto-create via createSession()
  //     so the JSONL gets the standard timestamped filename. This
  //     covers the common case: a caller (sentinel, test scripts,
  //     external integrations) supplies a logical name like
  //     "morning-routine" and expects somora to manage the file id.
  //   - invalid name → 400 with createSession's error message
  let session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    const isExactId = /^\d{8}-\d{6}_[A-Za-z0-9_-]+$/.test(sessionRef);
    if (isExactId) {
      return c.json({ error: `session '${sessionRef}' not found` }, 404);
    }
    if (sessionRef === 'main') {
      // "main" should always have resolved above; defensive fallback.
      session = 'main';
    } else {
      try {
        session = await createSession(agent, sessionRef);
        logger.info({
          msg: 'spawn_async.session_autocreated',
          agent,
          ref: sessionRef,
          session,
        });
      } catch (err) {
        return c.json(
          {
            error: `session '${sessionRef}' not resolvable and not a valid slug: ${(err as Error).message}`,
          },
          400,
        );
      }
    }
  }

  const fromAgent =
    typeof body.from_agent === 'string' && body.from_agent.length > 0 ? body.from_agent : undefined;
  const subagentDepth =
    typeof body.subagent_depth === 'number' && body.subagent_depth > 0 ? body.subagent_depth : 0;
  const modelOverride =
    typeof body.model === 'string' && body.model.length > 0 ? body.model : undefined;
  const maxRoundsOverride =
    typeof body.max_rounds === 'number' && body.max_rounds > 0 ? body.max_rounds : undefined;
  const parent_agent = body.parent_agent ?? fromAgent ?? agent;
  const parent_session = body.parent_session ?? '?';

  // Concurrency cap — same per-agent / global limits as the in-process
  // spawn tool. Pre-audit 2026-05-16 this endpoint accepted unlimited
  // parallel POSTs, letting an agent fan out way past 4 per-target.
  const slotErr = reserveSpawnSlot(agent, subagentDepth > 0 ? subagentDepth - 1 : 0);
  if (slotErr) {
    return c.json({ error: slotErr }, 429);
  }

  const task_id = newTaskId();
  registerTask({
    task_id,
    parent_agent,
    parent_session,
    target_agent: agent,
    target_session: session,
    started_at: Date.now(),
    ...(typeof body.attention === 'boolean' ? { attention: body.attention } : {}),
  });

  // Fire-and-forget. Errors land in the task entry, not the HTTP
  // response — the caller already got their task_id back. Background
  // acquires the per-session lock so two parallel /spawn-async POSTs
  // on the same (agent, session) serialize like /chat/send does — pre-
  // audit they interleaved JSONL events and corrupted engine state.
  void (async () => {
    const release = await acquireSessionLock(agent, session, {
      priority: 'agent',
      turnId: task_id,
    });
    // Abort controller for subagent_cancel — registered under the
    // sub's (agent, session) like a normal /chat/send turn, so the
    // cancel cascade can cut the in-flight LLM call.
    const abort = registerChatAbort(agent, session);
    try {
      const result = await runChatTurn({
        agent,
        session,
        text,
        signal: abort.signal,
        ...(fromAgent ? { fromAgent } : {}),
        ...(subagentDepth > 0 ? { subagentDepth } : {}),
        ...(modelOverride ? { modelOverride } : {}),
        ...(maxRoundsOverride
          ? { agentLoopOverride: { maxRounds: maxRoundsOverride } }
          : {}),
        deps: chatTurnDeps,
      });
      completeTask(task_id, result);
    } catch (err) {
      failTask(task_id, (err as Error).message);
    } finally {
      abort.release();
      release();
      releaseSpawnSlot(agent);
    }
  })();

  return c.json({ task_id }, 202);
});

app.get('/spawn-status', (c) => {
  const task_id = c.req.query('task_id');
  if (!task_id) return c.json({ error: 'task_id query required' }, 400);
  const entry = getTask(task_id);
  if (!entry) return c.json({ error: `task '${task_id}' not found` }, 404);
  return c.json({
    task_id: entry.task_id,
    state: entry.state,
    parent_agent: entry.parent_agent,
    parent_session: entry.parent_session,
    target_agent: entry.target_agent,
    target_session: entry.target_session,
    started_at: entry.started_at,
    ...(entry.finished_at !== undefined ? { finished_at: entry.finished_at } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  });
});

app.get('/spawn-result', async (c) => {
  const task_id = c.req.query('task_id');
  if (!task_id) return c.json({ error: 'task_id query required' }, 400);
  // Optional wait_until_done=1 + timeout_ms — server-side blocking
  // poll. Lets the caller request "give me the answer or wait up to
  // N ms for it" without burning agent-loop tool-call rounds on the
  // caller side.
  const waitFlag = c.req.query('wait_until_done');
  const wantWait = waitFlag === '1' || waitFlag === 'true';
  // Defaults sourced from agentLoop.{longTaskDefaultTimeoutMs,
  // longTaskMaxTimeoutMs} so the HTTP path matches the in-process tool
  // (status.ts) — both honor the same caller-friendly politik for slow
  // local models.
  const timeoutMs = (() => {
    const def = config.agentLoop.longTaskDefaultTimeoutMs;
    const max = config.agentLoop.longTaskMaxTimeoutMs;
    const raw = c.req.query('timeout_ms');
    if (!raw) return def;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
  })();
  let entry = getTask(task_id);
  if (!entry) return c.json({ error: `task '${task_id}' not found` }, 404);
  if (wantWait && entry.state === 'running') {
    // Circular-wait guard for the blocking wait (MCP-child callers of
    // subagent_result wait_until_done land here; the in-process tool
    // path has the identical guard in src/tools/agents/status.ts).
    // waiter_* identify the caller's blocked turn. On a cycle we do NOT
    // block — the sub is itself waiting on the caller, so blocking
    // guarantees a dual-timeout hang; 409 + circular_wait lets the tool
    // translate into a teaching pending-hint. Otherwise the wait is
    // registered as an edge so OTHER calls see it.
    const waiterAgent = c.req.query('waiter_agent') || undefined;
    const waiterSession = c.req.query('waiter_session') || undefined;
    const waiter =
      waiterAgent && waiterSession ? { agent: waiterAgent, session: waiterSession } : undefined;
    const target = { agent: entry.target_agent, session: entry.target_session };
    if (waiter) {
      const cycle = findWaitCycle(waiter, target);
      if (cycle) {
        logger.warn({
          msg: 'a2a.circular_wait_rejected',
          via: 'spawn-result',
          from: `${waiter.agent}/${waiter.session}`,
          to: `${target.agent}/${target.session}`,
          chain: cycle,
        });
        return c.json(
          {
            task_id,
            error: `task '${task_id}' still running and waiting on the caller`,
            state: 'running',
            circular_wait: true,
            chain: cycle,
          },
          409,
        );
      }
    }
    const releaseWait = waiter ? registerWait(waiter, target) : undefined;
    try {
      entry = (await waitForTaskCompletion(task_id, timeoutMs)) ?? entry;
    } finally {
      releaseWait?.();
    }
  }
  if (entry.state === 'running') {
    return c.json({ task_id, error: `task '${task_id}' still running`, state: 'running' }, 409);
  }
  // Terminal state delivered to the parent (MCP-child subagent_result
  // path) → suppress the pending attention wake.
  markResultFetched(entry.task_id);
  return c.json({
    task_id: entry.task_id,
    state: entry.state,
    target_agent: entry.target_agent,
    target_session: entry.target_session,
    ...(entry.result ? { result: entry.result } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  });
});

app.get('/spawn-list', (c) => {
  const parent = c.req.query('parent_agent');
  if (!parent) return c.json({ error: 'parent_agent query required' }, 400);
  return c.json({ tasks: listTasksForAgent(parent) });
});

// /spawn-cancel — abort a running spawn tree (task + cascaded child
// tasks). HTTP twin of the in-process subagent_cancel path so the MCP
// child (claude-cli/codex-cli tool host) can cancel too. Only the
// spawning agent may cancel its task — same guard as the tool.
app.post('/spawn-cancel', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    task_id?: string;
    requesting_agent?: string;
    reason?: string;
  };
  if (!body.task_id) return c.json({ error: 'task_id required' }, 400);
  const entry = getTask(body.task_id);
  if (!entry) return c.json({ error: `task '${body.task_id}' not found` }, 404);
  if (body.requesting_agent && entry.parent_agent !== body.requesting_agent) {
    return c.json(
      {
        error:
          `task '${body.task_id}' was spawned by '${entry.parent_agent}', ` +
          `not by '${body.requesting_agent}' — only the spawning agent can cancel it`,
      },
      403,
    );
  }
  const reason = body.reason?.trim()
    ? `cancelled by ${body.requesting_agent ?? 'unknown'}: ${body.reason.trim()}`
    : `cancelled by ${body.requesting_agent ?? 'unknown'}`;
  const outcome = cancelTaskCascade(body.task_id, reason);
  if (!outcome) return c.json({ error: `task '${body.task_id}' not found` }, 404);
  return c.json(outcome);
});

// Wiki-Promotion manueller Trigger. Same handler the dream_run tool
// calls in-process; exposed over HTTP so the MCP child (claude-cli /
// codex-cli) can fall back to it when its own ToolRegistry lacks the
// injected deepWorker. See `private/wiki-design.md`.
//
// Body: `{wait?: boolean}` — wait=false (default) returns immediately
// Read-only snapshot of the active dream_review loop, if any. TUI
// polls this for the status-line indicator. Returns 200 with body
// `{active: false}` when no loop is held; `{active: true, agent,
// dreamId, startedAt}` otherwise.
app.get('/dream/loop-state', (c) => {
  const state = getLoopState();
  if (!state) return c.json({ active: false });
  return c.json({
    active: true,
    agent: state.agent,
    dreamId: state.dreamId,
    startedAt: state.startedAt,
    lastActivityAt: state.lastActivityAt,
  });
});

// Snapshot of all three dream phases. AgentDock polls this every 30s for
// per-agent REM activity + pending-review counts, plus the server-global
// DEEP/LUCID running state. REM is filesystem-driven (running/completed
// dream files under .dreams/); DEEP/LUCID expose isRunning() on their
// worker. LUCID also surfaces the active loopHolder when present.
app.get('/dream-states', async (c) => {
  const agents = await listAgents();
  const rem: Record<string, { active: boolean; pendingCount: number }> = {};
  await Promise.all(
    agents.map(async (a) => {
      try {
        const dreams = await listDreams(a.name);
        const active = dreams.some((d) => d.meta.status === 'running');
        const pendingCount = dreams.filter((d) => d.meta.status === 'completed').length;
        rem[a.name] = { active, pendingCount };
      } catch {
        rem[a.name] = { active: false, pendingCount: 0 };
      }
    }),
  );
  const lucidLoop = getLoopState();
  // Lucid review-backlog (additive fields, 2026-07-29 feedback): the
  // only approval-gated phase besides REM was invisible in every
  // client — a completed run with pending findings produced no UI
  // trace at all. Unlike REM this is server-global, not per-agent.
  let lucidPending = { pendingRuns: 0, pendingFindings: 0 } as Awaited<
    ReturnType<typeof pendingLucidSummary>
  >;
  try {
    lucidPending = await pendingLucidSummary();
  } catch {
    // dir unreadable → keep zeros; don't fail the whole snapshot
  }
  return c.json({
    rem,
    deep: { active: deepWorker.isRunning() },
    lucid: {
      active: lucidWorker.isRunning(),
      ...(lucidLoop ? { loopHolder: lucidLoop.agent } : {}),
      pendingRuns: lucidPending.pendingRuns,
      pendingFindings: lucidPending.pendingFindings,
      ...(lucidPending.oldestPendingAt !== undefined
        ? { oldestPendingAt: lucidPending.oldestPendingAt }
        : {}),
    },
  });
});

// after firing the worker; wait=true awaits the run and returns
// outcome counts.
app.post('/dream/run-deep', async (c) => {
  if (!config.wiki.enabled) {
    return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
  }
  let wait = false;
  let force = false;
  try {
    const body = await c.req.json().catch(() => ({}));
    wait = Boolean((body as { wait?: unknown }).wait);
    force = Boolean((body as { force?: unknown }).force);
  } catch {
    /* empty body is fine */
  }
  if (!wait) {
    void deepWorker.runNow({ force }).catch(() => {
      /* errors logged in worker */
    });
    return c.json({
      started: true,
      wait: false,
      force,
      message:
        'Deep started in background. Tail ~/.somora/logs/ for dream.deep.done.',
    });
  }
  const result = await deepWorker.runNow({ force });
  const counts = result.outcomes.reduce(
    (acc, o) => {
      acc[o.kind] = (acc[o.kind] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  return c.json({
    wait: true,
    force,
    candidatesSeen: result.candidatesSeen,
    cachedSkips: result.cachedSkips,
    durationMs: result.durationMs,
    counts,
    outcomes: result.outcomes,
  });
});

// Lucid manueller Trigger. Mirrors /dream/run-deep
// shape: body {wait?:bool}; default fire-and-forget.
app.post('/dream/run-lucid', async (c) => {
  if (!config.wiki.enabled) {
    return c.json({ error: 'config.wiki.enabled is false — wiki layer not active' }, 400);
  }
  let wait = false;
  try {
    const body = await c.req.json().catch(() => ({}));
    wait = Boolean((body as { wait?: unknown }).wait);
  } catch {
    /* empty body */
  }
  if (!wait) {
    void lucidWorker.runNow().catch(() => {
      /* errors logged */
    });
    return c.json({
      started: true,
      wait: false,
      message: 'Lucid started in background.',
    });
  }
  const result = await lucidWorker.runNow();
  return c.json({
    wait: true,
    runId: result.runId,
    findingsCount: result.findingsCount,
    pagesScanned: result.pagesScanned,
    durationMs: result.durationMs,
    status: result.status,
  });
});

const port = Number(process.env.SOMORA_PORT ?? config.server.port);
// Pin the resolved port back into the env so child processes (MCP
// servers spawned by claude-cli/codex-cli) inherit it for their HTTP
// fallback path back to /chat/send-sync. Same for the bind host so
// localhost vs 127.0.0.1 stays consistent.
process.env.SOMORA_PORT = String(port);
// Bind-host precedence: SOMORA_HOST env override > config.server.host >
// loopback default. config.server.host lives in config.yaml (like
// server.port), so a LAN/Tailscale opt-in of `0.0.0.0` survives
// `somora update` — a SOMORA_HOST env in the systemd unit does NOT (the
// update rebakes the unit from a static template and drops custom env).
const configHost = config.server.host ?? '127.0.0.1';
process.env.SOMORA_HOST ??= configHost;
const bindHost = process.env.SOMORA_HOST ?? configHost;
// Child-process callers (MCP, openai-compat) need a routable host to
// reach back to /chat/send-sync. When the server binds to 0.0.0.0
// for LAN access, that's not a valid client target — substitute
// 127.0.0.1 in the env so children loopback rather than guessing.
if (bindHost === '0.0.0.0') {
  process.env.SOMORA_HOST = '127.0.0.1';
}

// TLS load. config.server.tls is optional; when present, the listener
// is HTTP/2-over-TLS instead of plain HTTP/1.1. The MCP-child fallback
// in spawn.ts honors SOMORA_TLS=1 + SOMORA_HOST=<publicHost> env to
// switch its inner /chat/send-sync caller from http://127.0.0.1 to
// https://<publicHost> — strict TLS verification kicks in once we go
// HTTPS, so the hostname must match the cert SAN/CN.
function expandHomePath(p: string): string {
  return p.startsWith('~/') ? resolvePath(homedir(), p.slice(2)) : resolvePath(p);
}
const tlsConf = config.server.tls;
let tlsCert: Buffer | undefined;
let tlsKey: Buffer | undefined;
if (tlsConf) {
  try {
    tlsCert = readFileSync(expandHomePath(tlsConf.cert));
    tlsKey = readFileSync(expandHomePath(tlsConf.key));
  } catch (err) {
    logger.error({
      msg: 'server.tls.load_failed',
      cert: tlsConf.cert,
      key: tlsConf.key,
      err: (err as Error).message,
      hint: 'check that `tailscale cert <fqdn>` produced both files; see docs/setup.md.',
    });
    process.exit(1);
  }
  process.env.SOMORA_TLS = '1';
  process.env.SOMORA_HOST = tlsConf.publicHost;
}

// Footgun guard: a TLS publicHost means the operator expects remote
// clients, but binding to loopback makes that impossible — the classic
// symptom of a SOMORA_HOST env dropped by a `somora update` unit rebake.
// Warn loudly so a silent "server's up but unreachable" is diagnosable.
if (tlsConf?.publicHost && bindHost === '127.0.0.1') {
  logger.warn({
    msg: 'server.bind_loopback_with_public_host',
    bindHost,
    publicHost: tlsConf.publicHost,
    hint: 'server binds to loopback but tls.publicHost is set — remote (LAN/Tailscale) clients cannot connect. Set `server.host: 0.0.0.0` in ~/.somora/config.yaml.',
  });
}

// Static mount for the web client. Built artifacts live at
// `web/dist/` (vite output, base `/web/`), so mounting them at
// `/web/*` makes the same-origin path work in production. Dev still
// uses vite at :5173 with a proxy to this server.
const webDistDir = new URL('../../web/dist/', import.meta.url).pathname;
app.use(
  '/web/*',
  serveStatic({
    root: webDistDir,
    rewriteRequestPath: (path) => path.replace(/^\/web\/?/, '/'),
  }),
);
app.get('/web', (c) => c.redirect('/web/'));

// Static mount for the mobile PWA client. Same pattern as /web/ —
// vite-built artifacts live at `web-mobile/dist/` with base `/mobile/`,
// served same-origin in production. Dev uses vite at :5174.
//
// The manifest.webmanifest + service-worker.js sit in the dist root
// alongside index.html so they're picked up by the rewriteRequestPath
// passthrough. Service-worker scope is `/mobile/`, manifest start_url
// is `/mobile/` — both match this mount, so "add to home screen"
// from a phone parks the user at the right entry point.
const mobileDistDir = new URL('../../web-mobile/dist/', import.meta.url).pathname;
app.use(
  '/mobile/*',
  serveStatic({
    root: mobileDistDir,
    rewriteRequestPath: (path) => path.replace(/^\/mobile\/?/, '/'),
  }),
);
app.get('/mobile', (c) => c.redirect('/mobile/'));

// Acquire single-active-server lockfile. Refuses to start if another
// somora process is alive (live PID match). Stale locks (process gone)
// are silently reclaimed. See DECISIONS #42.
try {
  const lock = acquireLockfile({
    port,
    host: process.env.SOMORA_HOST ?? '127.0.0.1',
    version: SOMORA_VERSION,
  });
  logger.info({ msg: 'server.lockfile.acquired', pid: lock.pid, port: lock.port });
} catch (err) {
  if (err instanceof LockfileBusy) {
    logger.error({
      msg: 'server.lockfile.busy',
      existing_pid: err.existing.pid,
      existing_port: err.existing.port,
      existing_started: err.existing.startedAt,
    });
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  }
  throw err;
}

await ensureDefaultAgent();
const agentList = await listAgents();
logger.info({ msg: 'agents.loaded', count: agentList.length, names: agentList.map((a) => a.name).join(',') });

// Pre-create memory/notes/ for every known agent. Cheap and lets users
// drop files in before the first chat triggers lazy MemoryManager init.
for (const a of agentList) {
  try {
    await ensureMemoryDirs(a.name);
  } catch (err) {
    logger.warn({ msg: 'memory.ensure_dirs_failed', agent: a.name, err: String(err) });
  }
}

// Workspace dirs — server-global default plus every per-agent override.
// Created idempotently so file_* tools never race a first-write mkdir.
{
  const personasForWs: Persona[] = [];
  for (const a of agentList) {
    const p = await loadPersona(a.name);
    if (p) personasForWs.push(p);
  }
  await ensureWorkspaceDirs(personasForWs, config);
}

// Recover any dreams that were `running` when the server last died.
// Auto-dreams get marked `paused` (will resume next idle); manual dreams
// get marked `failed` (user-initiated, don't auto-retry).
try {
  await recoverOrphanRunningDreams(agentList.map((a) => a.name));
} catch (err) {
  logger.warn({ msg: 'dream.recovery_failed', err: String(err) });
}

// Archive any leftover empty-findings completed dreams (for the case where
// extraction returned [] before phase 2l.3 added the auto-process path).
try {
  await archiveEmptyCompletedDreams(agentList.map((a) => a.name));
} catch (err) {
  logger.warn({ msg: 'dream.empty_housekeep_failed', err: String(err) });
}

// Consolidate stale paused dreams: when multiple paused exist for the same
// source-session (the bug-pattern reported 2026-05-05 — fixed in
// resumeDream() going forward), keep the newest and drop the rest.
// Idempotent; no-op once steady state is reached.
try {
  await consolidateStalePausedDreams(agentList.map((a) => a.name));
} catch (err) {
  logger.warn({ msg: 'dream.consolidate_failed', err: String(err) });
}

// Mark any background exec jobs that were `running` when the previous
// server instance died as `failed` — we can't safely re-attach to a
// possibly-still-alive PID across restarts. Stdout/stderr log files
// persist and remain readable via process({action:"log"}).
try {
  await recoverOrphanedJobs(agentList.map((a) => a.name));
} catch (err) {
  logger.warn({ msg: 'exec.jobs_recovery_failed', err: String(err) });
}

// Auto-Dream-Worker: per-agent idle-trigger that picks up dream-enabled
// agents and runs background extractions. Registers each enabled agent
// once at startup; the first idle timer runs idleMinutes from now,
// which gives any paused-from-crash dreams a quiet window to be picked up.
const remWorker = new RemWorker({
  config,
  getMemoryManager: (agent) => getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian }),
});

// Shared deps object for runChatTurn — server boot wires everything up
// once and chat/send + spawn_subagent both reuse it.
const chatTurnDeps = {
  config,
  sessionMetaStore,
  tools,
  onActivity: (agent: string) => remWorker.resetActivity(agent),
};
configureSpawnTools({ chatTurnDeps });
// Sentinel scheduler — wire deps + boot the trigger loop. Same pattern
// as configureSpawnTools: server boot owns the deps, sentinel imports
// the runtime via the injected reference. `completedRetentionDays`
// controls GC of terminal-state triggers (0 = disabled).
configureSentinel({
  chatTurnDeps,
  completedRetentionDays: config.sentinel.completedRetentionDays,
  // Wire SSE broadcast so sentinel-driven turns stream live to
  // subscribed clients exactly like /chat/send turns do. Without
  // this, the woken agent's reaction shows up in JSONL on disk but
  // not in the live stream — users see nothing until they reload.
  publishEvent: (agent, session, event) =>
    publish(agent, session, event as Parameters<typeof publish>[2]),
});
void startSentinel().catch((err) => {
  logger.error({ msg: 'sentinel.boot_failed', err: (err as Error).message });
});
// tmux attention watcher — wakes an agent when a coding-CLI it started
// in tmux becomes ready and the agent missed it. Main-server-only
// runtime; the tmux TOOL layer talks to it via the two ledger files
// (design: private/tmux-hooks-design.md). When disabled, the mirror
// file is cleared so tool responses carry zero attention traces
// (three-gates rule).
if (config.tmux.attention.enabled) {
  configureTmuxAttention({
    chatTurnDeps,
    publishEvent: (agent, session, event) =>
      publish(agent, session, event as Parameters<typeof publish>[2]),
  });
  startTmuxAttentionWatcher(config.tmux.attention);
} else {
  writeAttentionMirror({});
}
// Subagent attention wake (2026-07-28 feedback): a finished async sub
// whose result nobody fetched wakes its parent — same mechanic as the
// tmux watcher, incl. the SSE publish so open clients see the wake
// turn live (feedback_publishsse_must_broadcast). The wake turn
// queues on the parent's session lock, so it never interrupts an
// active turn.
configureSubagentAttention({
  graceMs: 2_000,
  dispatchWakeTurn: async ({ agent, session, text }) => {
    const release = await acquireSessionLock(agent, session, { priority: 'agent' });
    try {
      await runChatTurn({
        agent,
        session,
        text,
        fromSystem: 'subagent',
        deps: chatTurnDeps,
        publishSse: (event) => publish(agent, session, event as Parameters<typeof publish>[2]),
      });
    } finally {
      release();
    }
  },
});
installTtsCacheGc(config);
configureLongTaskTimeouts(config);
setMaxWikiCallsPerTurn(config.wiki.lucid.maxCallsPerTurn);
configureExecConcurrencyCaps(
  config.agentLoop.execMaxConcurrentPerAgent,
  config.agentLoop.execMaxConcurrentGlobal,
);
logExecCaps();
for (const a of agentList) {
  try {
    const persona = await loadPersona(a.name);
    if (persona?.rem?.enabled) {
      remWorker.register(a.name, persona.rem);
    }
  } catch (err) {
    logger.warn({ msg: 'dream.rem.register_failed', agent: a.name, err: String(err) });
  }
}

// DeepWorker — Memory→Wiki consolidation. Server-global, real-clock-
// scheduled. Only starts if config.wiki.enabled AND wiki.deep.enabled.
// Deep operates on whatever memory files are currently on disk; it
// never triggers REM. New observations land in memory only after the
// user approves REM findings via dream_apply.
const globalVault = resolveObsidianSource(config.obsidian);
const deepWorker = new DeepWorker({
  config,
  getParticipatingAgents: async () => {
    if (!globalVault) return [];
    // Live-listing (not the boot-time `agentList` snapshot) so agents
    // added at runtime are picked up by the next Deep run without
    // a server restart.
    const liveAgents = await listAgents();
    const out: Array<{ name: string; vaultPath: string }> = [];
    for (const a of liveAgents) {
      const persona = await loadPersona(a.name);
      if (persona?.rem?.participate_in_wiki === false) continue;
      out.push({ name: a.name, vaultPath: globalVault.vaultPath });
    }
    return out;
  },
  getMemoryManager: (agent) =>
    getMemoryManager(agent, {
      config: config.memory,
      wiki: config.wiki,
      obsidian: config.obsidian,
    }),
});
void deepWorker.start();
const lucidWorker = new LucidWorker({ config });
void lucidWorker.start();
configureDreamRunTool({ deepWorker, lucidWorker });

// WebSocket upgrade goes through a noServer wss so the same listener
// (HTTPS+H2 or plain HTTP) can route both /chat/stream SSE and
// /tmux/attach WS in one process. ws upgrades land here when the
// Hono route uses upgradeWebSocket(). Browsers happily speak WSS
// over HTTP/2 (RFC 8441) — tested against this server.
const wss = new WebSocketServer({ noServer: true });

// Long A2A turns (agent_ask) and long subagent spawns block on
// /chat/send-sync for up to agentLoop.longTaskMaxTimeoutMs (30 min by
// default). The h2 server and its underlying TCP socket must NOT have
// shorter implicit timeouts than that, or they drop the connection
// mid-turn and the caller sees `fetch failed`. We disable the socket-
// level timeouts and the h2 sessionTimeout explicitly; headersTimeout
// keeps its sensible 60s default as DoS protection (it only governs
// request HEADER receipt, not the response wait).
//
// Equivalent client-side fix lives in src/server/loopback-fetch.ts
// (undici dispatcher with bodyTimeout/headersTimeout=0).
const httpServer = tlsCert && tlsKey && tlsConf
  ? serve(
      {
        fetch: app.fetch,
        port,
        hostname: bindHost,
        // allowHTTP1: true keeps HTTP/1.1 fallback available for legacy
        // tooling (curl, ancient health-check probes, etc.) — modern
        // browsers negotiate HTTP/2 via ALPN and get the multiplex benefit
        // automatically. Cert MUST be valid for `publicHost`.
        createServer: createHttp2SecureServer,
        serverOptions: {
          cert: tlsCert,
          key: tlsKey,
          allowHTTP1: true,
          // 0 = no h2 session inactivity timeout. Default is also 0 in
          // current Node, but we make it explicit so a future Node
          // default change doesn't silently re-introduce the regression.
          sessionTimeout: 0,
        },
        websocket: { server: wss },
      },
      (info) => {
        logger.info({
          msg: 'server.start',
          port: info.port,
          host: bindHost,
          tls: true,
          publicHost: tlsConf.publicHost,
          protocol: 'h2',
        });
      },
    )
  : serve(
      { fetch: app.fetch, port, hostname: bindHost, websocket: { server: wss } },
      (info) => {
        logger.info({ msg: 'server.start', port: info.port, host: bindHost, tls: false });
      },
    );

// Disable socket and request-body timeouts so long A2A / spawn turns
// (up to longTaskMaxTimeoutMs) ride through without server-side
// connection drops. keepAliveTimeout is bumped from Node's 5s default
// to 60s so h1-fallback keep-alive survives normal model thinking
// pauses. headersTimeout (60s default) is left alone — it caps the
// time spent waiting for the request HEADERS, not the response, so
// it doesn't fight long agent turns.
//
// The cast is needed because @hono/node-server's ServerType union
// covers both http.Server and http2.Http2SecureServer; their timeout
// properties differ in the type defs even though both classes carry
// them at runtime via inheritance from net.Server / setTimeout().
httpServer.setTimeout(0);
const tunable = httpServer as unknown as {
  requestTimeout?: number;
  keepAliveTimeout?: number;
};
tunable.requestTimeout = 0;
tunable.keepAliveTimeout = 60_000;

// Best-effort cleanup on signal — keeps embedding processes from lingering
// and SQLite handles closed cleanly. tsx watch tends to send SIGTERM on reload.
async function shutdown(signal: string): Promise<void> {
  logger.info({ msg: 'server.shutdown', signal });
  // Await: aborts in-flight REM runs and waits (bounded, 5s) until the
  // aborted dream lands as `paused` on disk — exiting earlier archived
  // it as empty-processed instead (report 2026-07-25, restart-kills).
  await remWorker.shutdown();
  deepWorker.shutdown();
  lucidWorker.shutdown();
  releaseLockfile();
  stopClaudeCredentialSyncWatcher();
  await shutdownMemoryRegistry();
  await shutdownSshPool();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Safety net: third-party libraries (e.g. @huggingface/transformers' model
// loader) sometimes reject promises in microtasks that aren't tied to our
// await chains. Without a handler, those crash the whole server. We log
// loudly so they're visible in operations but keep the server alive — the
// affected feature (embeddings, etc.) degrades to its fallback (FTS-only
// retrieval) per its own try/catch.
process.on('unhandledRejection', (reason) => {
  logger.error({
    msg: 'process.unhandled_rejection',
    err: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on('uncaughtException', (err) => {
  logger.error({ msg: 'process.uncaught_exception', err: err.message, stack: err.stack });
});
