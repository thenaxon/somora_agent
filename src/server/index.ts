import { resolveBrowserSession } from '../browser/session.ts';
import { readLogSince, readLogTail } from './logs.ts';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { checkBrowserRequest } from './browser-guard.ts';
import { config, configLoadedMtimeMs, setConfig, setConfigMtime } from './server-state.ts';
import { KeyStore } from './auth-key.ts';
import { serializeSessionEvent } from './sse-serializer.ts';
import { installTransportLiveness } from './sse-liveness.ts';
import { bridgeMcpTools } from '../mcp/hub/bridge.ts';
import { writeCatalog } from '../mcp/hub/catalog.ts';
import { McpHubManager } from '../mcp/hub/manager.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createSecureServer as createHttp2SecureServer } from 'node:http2';
import { TlsKeeper, type SecureContextHolder } from './tls-keeper.ts';
import { UpdateChecker } from './update-check.ts';
import { allowResume, clearRestartIntent, detectedResumeText, readRestartIntent, requestedResumeText } from './restart-intent.ts';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { WebSocketServer } from 'ws';
import { applyClaudeCliSdkEnv, applyCodexCliEnv, configPath, currentConfigProblem, getFreshConfig, loadConfig, primeFreshConfig } from '../config/loader.ts';
import { stat as statFile } from 'node:fs/promises';
import { workerChain, type Config, resolveAnyRef, describeModelRefs } from '../config/types.ts';
import { storeAttachment } from '../attachments/store.ts';
import { videoRequestFromBody, VideoRequestError } from '../videogen/request.ts';
import { checkSlot as checkVideoSlot, listJobs as listVideoJobs } from '../videogen/jobs.ts';
import { configureVideoNotifier, startVideoRunner } from '../videogen/runner.ts';
import { configureVideoWake, wakeForJob } from '../videogen/wake.ts';
import {
  deleteRecord as deleteMediaRecord,
  listRecords as listMediaRecords,
  readRecord as readMediaRecord,
  totalBytes as imageTotalBytes,
} from '../media/records.ts';
import { join as joinPath } from 'node:path';
import { checkReadAllowed, checkWriteAllowed, expandHome, realpathSafeAncestor } from '../tools/file/policy.ts';
import { listTmuxSessions } from '../tmux/list.ts';
import { ensureMemoryDirs, getMemoryManager, shutdownMemoryRegistry, getSharedIndex } from '../memory/registry.ts';
import { warmupEmbedder } from '../memory/embeddings.ts';
import { setupClaudeConfigDir } from './claude-config-dir.ts';
import { configureClaudeCredentialSync, reconcileClaudeCredentials, startClaudeCredentialSyncWatcher, stopClaudeCredentialSyncWatcher } from './claude-credential-sync.ts';
import { getEffectiveEnv } from './env.ts';
import { loadSomoraEnvFile } from './env-file.ts';
import { SOMORA_HOME_DIR } from './logger.ts';
import { ensureWorkspaceDirs } from './workspace.ts';
import {
  ensureDefaultAgent,
  listAgents,
  loadPersona,
  type Persona,
} from '../persona/loader.ts';
import { sessionMetaStore } from '../storage/sessions.ts';
import { configureLongTaskTimeouts } from '../tools/agents/long-task-timeouts.ts';
import {
  listProjects,
  projectExists,
  readProject,
  writeProject,
} from '../projects/store.ts';
import { PROJECT_SLUG_RE, ProjectFrontmatterSchema } from '../projects/types.ts';
import { seedBuiltinSkills } from '../skills/bootstrap.ts';
import * as sentinelStore from '../sentinel/store.ts';
import * as sentinelScheduler from '../sentinel/scheduler.ts';
import { configureSentinel, startSentinel } from '../sentinel/scheduler.ts';
import {
  configureTmuxAttention,
  startTmuxAttentionWatcher,
} from '../tmux/attention-watcher.ts';
import { writeAttentionMirror } from '../tmux/attention.ts';
import { cacheFileStat, negotiateFormat, synthesize } from '../tts/service.ts';
import { installTtsCacheGc } from '../tts/cache-gc.ts';
import { appendEvent } from '../storage/sessions.ts';
import { tapPublish } from './activity-stream.ts';
import {
  configureDreamRunTool,
  configureExecConcurrencyCaps,
  configureSpawnTools,
  logExecCaps,
  recoverOrphanedJobs,
  registerAllTools,
  ToolRegistry,
} from '../tools/index.ts';
import { isToolAllowed, sessionToolDeny, unknownToolRules, withSessionDeny } from '../tools/gating.ts';
import { writeAgentToolGating } from '../persona/tool-gating-store.ts';
import { writeAgentSkillGating } from '../persona/skill-gating-store.ts';
import { loadAvailableSkills } from '../skills/load.ts';
import { shutdownSshPool } from '../ssh/index.ts';
import { archiveEmptyCompletedDreams, consolidateStalePausedDreams, recoverOrphanRunningDreams } from '../dream/storage.ts';
import { RemWorker } from '../dream/rem-worker.ts';
import { syncRemRegistration } from '../dream/dreams.ts';
import { migrateDreamsSwitch } from '../persona/dreams-migrate.ts';
import { DeepWorker } from '../dream/deep-worker.ts';
import { LucidWorker } from '../dream/lucid-worker.ts';
import { setMaxWikiCallsPerTurn } from '../dream/loop-state.ts';
import { pendingLucidSummary } from '../dream/lucid-storage.ts';
import { resolveObsidianSource } from '../memory/registry.ts';
import type { SseEvent } from '../types/events.ts';
import { configureBrowserService } from '../browser/service.ts';
import { ScreencastRegistry } from '../browser/screencast.ts';
import { logger, onLog } from './logger.ts';
import { startToolOutputSweeper } from '../tools/tool-output.ts';
import { reconcileInterruptedTurns, restartParentWakeText, restartWakeText } from './restart-reconcile.ts';
import { shutdownLsp } from '../lsp/index.ts';
import { findBinary, LSP_SERVERS } from '../lsp/registry.ts';
import { configureModelAvailability, listUnavailableModels } from '../engine/model-availability.ts';
import { Inbox } from './inbox.ts';
import { inboxFromLog, inboxFromState } from './inbox-sources.ts';
import { readBuilderState } from './builder-session.ts';
import { sessionToolAllows } from './ask-attended.ts';
import { configureStartTurn, startTurn } from './start-turn.ts';
import type { TurnOrigin } from './turn-origin-kind.ts';
import { VoiceCallManager } from '../voice/realtime/manager.ts';
import type { VoiceCallSnapshot } from '../voice/realtime/call.ts';
import type { RealtimeEvent } from '../voice/realtime/types.ts';
import { DequeuedError, listSessionWaiters, getSessionLockStatus } from './session-queue.ts';
import { readPersonaFiles, writePersonaFile } from '../persona/files.ts';
import { assembleSystemPrompt } from './prompt-assembly.ts';
import { getResolvedTeam, loadTeamFile, teamFilePath } from '../team/store.ts';
import { configureWorkWake, markFetched, onWorkFinished, openWork, getWork, setWaiting } from './work-ledger.ts';
import { sessionSlugOf as a2aSessionSlugOf } from '../engine/a2a.ts';
import { readLockfile } from './lockfile.ts';
import { acquireLockfile, LockfileBusy, releaseLockfile } from './lockfile.ts';
import { SOMORA_VERSION } from '../version.ts';
import { reserveSpawnSlot, releaseSpawnSlot } from '../tools/agents/spawn.ts';
import { registerInboxRoutes } from './routes/inbox.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerFilesRoutes } from './routes/files.ts';
import { registerWikiRoutes } from './routes/wiki.ts';
import { registerTerminalRoutes } from './routes/terminals.ts';
import { registerAbilitiesRoutes } from './routes/abilities.ts';
import { registerMcpRoutes } from './routes/mcp.ts';
import { registerSentinelRoutes } from './routes/sentinel.ts';
import { registerServerRoutes } from './routes/server.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { registerMemoryRoutes } from './routes/memory.ts';
import { registerModelRoutes } from './routes/models.ts';
import { registerDecisionRoutes } from './routes/decisions.ts';
import { registerTeamRoutes } from './routes/team.ts';
import { registerAgentRoutes } from './routes/agents.ts';
import { registerBuilderRoutes } from './routes/builder.ts';
import { registerProjectRoutes } from './routes/projects.ts';
import { registerDreamRoutes } from './routes/dream.ts';
import { registerSpawnRoutes } from './routes/spawn.ts';
import { registerLogRoutes } from './routes/logs.ts';
import { registerMediaRoutes } from './routes/media.ts';
import { registerImageRoutes } from './routes/images.ts';
import { registerAttachmentRoutes } from './routes/attachments.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerVoiceRoutes } from './routes/voice.ts';
import { registerBrowserRoutes } from './routes/browser.ts';
import { registerVideoRoutes } from './routes/video.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerThemeRoutes } from './routes/themes.ts';
import { registerExternalRoutes } from './routes/external.ts';
import { closeAllExternal } from '../external/connection.ts';

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
export const streams = new Map<string, Set<StreamSub>>();

/**
 * Compose the pubsub key from (agent, session). Every persona has a
 * `main` session by default, so keying by session-id alone caused
 * cross-agent leaks for any client that opened multiple SSE
 * subscriptions in parallel — observed in the web client with
 * multiple chat windows: events for one agent's main session arrived
 * in another agent's main stream because both subscribed to bare
 * "main".
 */
export function streamKey(agent: string, session: string): string {
  return `${agent}::${session}`;
}

export function subscribe(
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
export const lastEngineEventAt = new Map<string, number>();
// Last successful publish (at least one subscriber acknowledged, OR no
// subscribers at all). Distinct from lastEngineEventAt which fires on
// every publish attempt; this one only advances when the broadcast
// actually went through. Diagnostic surface for /health.
export const lastPublishOkAt = new Map<string, number>();

export async function publish(agent: string, session: string, event: SseEvent): Promise<void> {
  const key = streamKey(agent, session);
  lastEngineEventAt.set(key, Date.now());
  const subs = streams.get(key);
  if (!subs || subs.size === 0) {
    lastPublishOkAt.set(key, Date.now());
    // Nobody has this session open — exactly the case the activity
    // hub exists for (running dot + unread badge on a session that is
    // not on screen). Without this the hub only ever heard about
    // sessions some client was already looking at.
    void tapPublish(agent, session, event);
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
export async function defaultAgentFallback(): Promise<string | null> {
  const list = await listAgents();
  const sorted = list.map((a) => a.name).sort();
  return sorted[0] ?? null;
}

export function resolveEffectiveModel(
  config: Config,
  persona: Persona,
  sessionMeta: Record<string, unknown>,
) {
  const override = sessionMeta.modelOverride;
  const ref = (typeof override === 'string' && override.length > 0 ? override : persona.model);
  if (!ref) return null;
  return resolveAnyRef(config, ref);
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

export async function configFileMtime(): Promise<number> {
  try {
    return (await statFile(configPath())).mtimeMs;
  } catch {
    return 0;
  }
}
try {
  setConfig(await loadConfig());
  setConfigMtime(await configFileMtime());
  // The boot config is the first "last valid" one: a broken edit later
  // falls back to it instead of failing every turn.
  primeFreshConfig(config, configLoadedMtimeMs);
  configureModelAvailability(config.fallback.retryUnavailableMinutes);
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
    // A worker without `pdf` still reads a PDF as page images, so only
    // one that has neither can do nothing with a PDF.
    if (requirePdf && !m.model.capabilities.includes('pdf') && !m.model.capabilities.includes('image')) {
      logger.warn({
        msg: 'vision.worker.no_pdf_capability',
        label,
        worker: ref,
        hint: "reads neither PDFs nor images — analyze_file passes it over for PDFs; give it 'pdf' or 'image', or remove it",
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

// Backup workers of Deep and Lucid: a typo would only surface on the day
// the worker is down — refuse it now instead.
for (const phase of ['deep', 'lucid'] as const) {
  const bad = workerChain(config.wiki[phase].fallback).filter((ref) => !resolveAnyRef(config, ref));
  if (bad.length > 0) {
    console.error(`\n\x1b[31m[!] somora config invalid:\x1b[0m wiki.${phase}.fallback names ${bad.map((b) => `'${b}'`).join(', ')}, which is not a configured model.\n${describeModelRefs(config)}\n`);
    process.exit(1);
  }
}

// Push claude-cli SDK tunables into process.env so the subprocess
// inherits them. Must run before the first engine call.
applyClaudeCliSdkEnv(config);
// Same for codex-cli — bridges config.codexCli into a process.env var
// that the codex-cli engine reads (tool timeout, shell env policy, direct tools).
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
export const tools = new ToolRegistry();
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
export const mcpHub = new McpHubManager(config.mcp);
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

// The inbox (src/server/inbox.ts): notices for the person running
// somora. Reads the log from here on; the state check starts below,
// next to the update check it reads.
export const inbox = new Inbox();
onLog((_level, line) => inboxFromLog(inbox, line));

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

// Background requests a foreign website makes through the user's
// browser are refused; programs that are not browsers are not checked.
app.use('*', async (c, next) => {
  const verdict = checkBrowserRequest(
    {
      method: c.req.method,
      host: c.req.header('host') ?? new URL(c.req.url).host,
      origin: c.req.header('origin'),
      secFetchSite: c.req.header('sec-fetch-site'),
      secFetchMode: c.req.header('sec-fetch-mode'),
    },
    { publicHost: config.server.tls?.publicHost, allowedHosts: config.server.allowedHosts },
  );
  if (!verdict.ok) {
    logger.warn({ msg: 'http.browser_refused', method: c.req.method, path: c.req.path, reason: verdict.reason, origin: c.req.header('origin') ?? null, host: c.req.header('host') ?? null });
    return c.text(`refused: ${verdict.reason}. A browser reaching somora under another name: add it to server.allowedHosts in config.yaml.\n`, 403);
  }
  await next();
});

// An SVG is a document that can carry scripts. Whatever route serves
// one (media, /files/raw, the web client's icons), opened on its own it
// renders without running them, so a crafted file cannot act on
// somora's origin. <img> never runs SVG scripts anyway.
app.use('*', async (c, next) => {
  await next();
  if ((c.res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/svg+xml')) {
    c.res.headers.set('content-security-policy', "sandbox; script-src 'none'; object-src 'none'");
  }
});

// The login key (src/server/auth-key.ts, docs/security.md). somora's
// own children (MCP tool hosts, dream workers) inherit SOMORA_KEY; an
// agent's shell has it stripped (tools/exec/internal-env.ts).
export const keyStore = new KeyStore();
process.env.SOMORA_KEY = keyStore.current();
registerAuthRoutes(app, { keyStore });

registerHealthRoutes(app, { lastEngineEventAt, lastPublishOkAt, streamKey, streams });

registerFilesRoutes(app);
registerWikiRoutes(app);

registerTerminalRoutes(app, { get TERMINAL_WS_DEAD_MS() { return TERMINAL_WS_DEAD_MS as typeof TERMINAL_WS_DEAD_MS; }, get TERMINAL_WS_PING_MS() { return TERMINAL_WS_PING_MS as typeof TERMINAL_WS_PING_MS; } });

registerSentinelRoutes(app);

registerMcpRoutes(app, { mcpHub });

registerAbilitiesRoutes(app, { tools });

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
export const TERMINAL_WS_PING_MS = 25_000;
export const TERMINAL_WS_DEAD_MS = 80_000;

// Version endpoint — surfaced to the web client so the taskbar can
// display the running build. Read once at boot from version.ts (which
// reads package.json), so this is effectively a static snapshot for
// the lifetime of the process. JSON keeps room for future fields
// (build-time, git SHA, env name) without breaking the client.
// The daily update check (docs/setup.md → "The daily update check").
export const updateChecker = new UpdateChecker({
  version: SOMORA_VERSION,
  endpoint: config.updateCheck.endpoint,
  statePath: joinPath(SOMORA_HOME_DIR, 'update-check.json'),
  configEnabled: config.updateCheck.enabled,
  surface: 'server',
  log: logger,
});
updateChecker.start();

// subagents.tools.deny entries that name nothing (a typo): logged once
// per change and shown in the inbox; the list still applies.
let subagentDenyUnknown: string[] = [];
export async function refreshSubagentDenyCheck(): Promise<void> {
  const fresh = await getFreshConfig().catch(() => config);
  const defs = tools.list();
  const unknown = unknownToolRules(
    fresh.subagents.tools.deny,
    new Set(defs.map((t) => t.name)),
    new Set(defs.map((t) => t.toolset).filter((s): s is NonNullable<typeof s> => !!s)),
  );
  if (unknown.join('\n') !== subagentDenyUnknown.join('\n') && unknown.length > 0) {
    logger.warn({ msg: 'config.subagents_deny_unknown', unknown, hint: 'these entries in subagents.tools.deny match no tool' });
  }
  subagentDenyUnknown = unknown;
}

export function checkInboxState(): void {
  void refreshSubagentDenyCheck();
  inboxFromState(inbox, {
    version: SOMORA_VERSION,
    update: () => {
      const u = updateChecker.status();
      return { updateAvailable: u.updateAvailable, latestVersion: u.latestVersion, note: u.note, enabled: u.enabled };
    },
    configProblem: () => currentConfigProblem(),
    mcpServers: () => (mcpHub.enabled ? mcpHub.status() : {}),
    unavailableModels: () => listUnavailableModels(),
    subagentDenyUnknown: () => subagentDenyUnknown,
  });
}
void refreshSubagentDenyCheck();
setTimeout(checkInboxState, 30_000).unref();
setInterval(checkInboxState, 5 * 60_000).unref();

registerInboxRoutes(app, { checkInboxState, inbox, refreshSubagentDenyCheck });

registerThemeRoutes(app);

registerServerRoutes(app, { configFileMtime, refreshSubagentDenyCheck, syncDreamers, updateChecker });

registerAgentRoutes(app, { get nextTurnPrompt() { return nextTurnPrompt as typeof nextTurnPrompt; }, syncDreamers });

// The system prompt and tool list the NEXT turn of a session would send.
// Read-only: the wiki snapshot is not persisted. Shared by the prompt
// preview and the manual compaction (which summarises against it).
export async function nextTurnPrompt(
  agent: string,
  session: string,
  persona: NonNullable<Awaited<ReturnType<typeof loadPersona>>>,
  sessionMeta: Awaited<ReturnType<typeof sessionMetaStore.get>>,
) {
  // The preview has to answer with the tools the NEXT TURN would send,
  // so it needs the same active model that turn resolves. Without it a
  // capability-gated tool shows up here and then is not offered — the
  // vision worker is exactly that case since 2026-09-10.
  const previewModel = resolveEffectiveModel(config, persona, sessionMeta);
  const toolCtx = {
    agent,
    session,
    getMemoryManager: () =>
      getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian }),
    config,
    contentBlocks: [],
    ...(previewModel ? { activeModel: previewModel } : {}),
  };
  // The same two filters the turn applies: the persona's gating and, for a
  // builder, the session's mode and phase (ask_user off when unattended,
  // the repository-changing tools off while planning).
  const previewBuilderState = persona.kind === 'builder' ? readBuilderState(sessionMeta as Record<string, unknown>) : null;
  const previewGating = withSessionDeny(persona.toolGating, sessionToolDeny(config, sessionMeta));
  const available = (await tools.listAvailable(toolCtx)).filter(
    (t) => isToolAllowed(t.name, t.toolset, previewGating) && sessionToolAllows(persona.kind, previewBuilderState, sessionMeta as Record<string, unknown>, t.name),
  );
  const assembled = await assembleSystemPrompt({
    agent,
    session,
    persona,
    sessionMeta,
    deps: chatTurnDeps,
    subagentDepth: 0,
    toolCount: available.length,
    toolNames: available.map((t) => t.name),
    persistWikiSnapshot: false,
  });
  return { assembled, available };
}

registerTeamRoutes(app);

registerModelRoutes(app, { tools });

registerDecisionRoutes(app);

registerMemoryRoutes(app);

registerSessionRoutes(app, { nextTurnPrompt, publish, resolveEffectiveModel, streamKey, streams });

registerProjectRoutes(app, { publish });

registerBuilderRoutes(app, { publish });
registerExternalRoutes(app, { publish });

registerChatRoutes(app, { defaultAgentFallback, publish, subscribe, get remWorker() { return remWorker as typeof remWorker; } });

registerAttachmentRoutes(app);

registerImageRoutes(app);

registerMediaRoutes(app);

registerVideoRoutes(app);

registerLogRoutes(app);

registerBrowserRoutes(app, { TERMINAL_WS_DEAD_MS, TERMINAL_WS_PING_MS, get browserService() { return browserService as typeof browserService; }, get screencasts() { return screencasts as typeof screencasts; } });

registerVoiceRoutes(app, { defaultAgentFallback, publish, get voiceCalls() { return voiceCalls as typeof voiceCalls; }, get voiceStateWatchers() { return voiceStateWatchers as typeof voiceStateWatchers; }, get voiceWatchers() { return voiceWatchers as typeof voiceWatchers; } });

registerSpawnRoutes(app);

registerDreamRoutes(app, { get deepWorker() { return deepWorker as typeof deepWorker; }, get lucidWorker() { return lucidWorker as typeof lucidWorker; }, get remWorker() { return remWorker as typeof remWorker; } });

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
// Must be registered BEFORE the static mount: `/web/*` also matches the
// bare `/web`, and the rewrite's optional slash turns it into `/` — so a
// mount-first order serves index.html at `/web` with 200 and the redirect
// below is never reached. The browser then resolves the document's
// relative asset links (e.g. `./favicon.svg`) against `/` instead of
// `/web/`, and they 404.
app.get('/web', (c) => c.redirect('/web/'));
app.use(
  '/web/*',
  serveStatic({
    root: webDistDir,
    rewriteRequestPath: (path) => path.replace(/^\/web\/?/, '/'),
  }),
);

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
// Same ordering requirement as `/web` above.
app.get('/mobile', (c) => c.redirect('/mobile/'));
app.use(
  '/mobile/*',
  serveStatic({
    root: mobileDistDir,
    rewriteRequestPath: (path) => path.replace(/^\/mobile\/?/, '/'),
  }),
);

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
// agent.yaml files from before the `dreams` switch get it once, before
// anything reads it (src/persona/dreams-migrate.ts).
const dreamsMigrated = await migrateDreamsSwitch();
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

// Load the embedding model once at boot. Fire-and-forget: the download
// (first run only) must not delay listen(), but a failure gets ONE loud
// `error` line here instead of a throttled `warn` per agent after the
// first chat turn — and `GET /health` shows it as `memoryEmbedder`.
void warmupEmbedder(config.memory.embedding);
// Open the shared vault/wiki index and start its build now, so the seed
// (first boot after the split) or the catch-up sweep runs before the
// first turn instead of inside it. Agents answer from their own DB until
// it is ready — see src/memory/shared-index.ts.
void getSharedIndex({ config: config.memory, obsidian: config.obsidian, wiki: config.wiki }).init();

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

// Turns the last process died in the middle of: close them with a marker
// now; whoever waited for them is woken further down, once startTurn and
// the work ledger are wired (restart-reconcile.ts).
let interruptedTurns: Awaited<ReturnType<typeof reconcileInterruptedTurns>> = [];
try {
  interruptedTurns = await reconcileInterruptedTurns(agentList.map((a) => a.name));
} catch (err) {
  logger.warn({ msg: 'restart.reconcile_failed', err: String(err) });
}

// Full copies of shortened tool outputs (exec, capped results) live under
// each agent's tool-output/ for seven days — sweep at boot and hourly.
startToolOutputSweeper(async () => (await listAgents()).map((a) => a.name));

// Auto-Dream-Worker: per-agent idle-trigger that picks up dream-enabled
// agents and runs background extractions. Registers each enabled agent
// once at startup; the first idle timer runs idleMinutes from now,
// which gives any paused-from-crash dreams a quiet window to be picked up.
// `config` is a getter everywhere a boot-time object keeps a handle on
// it: POST /config/reload swaps the module variable, and the getter
// makes the workers and the turn pipeline see the new one without a
// restart. A plain `config,` here would pin the boot-time snapshot.
export const remWorker = new RemWorker({
  get config() {
    return config;
  },
  getMemoryManager: (agent) => getMemoryManager(agent, { config: config.memory, wiki: config.wiki, obsidian: config.obsidian }),
});

// Shared deps object for runChatTurn — server boot wires everything up
// once and chat/send + spawn_subagent both reuse it.
const chatTurnDeps = {
  get config() {
    return config;
  },
  sessionMetaStore,
  tools,
  onActivity: (agent: string) => remWorker.resetActivity(agent),
};
configureSpawnTools({ chatTurnDeps });
// Every turn — typed, dictated, asked by an agent, spawned, fired by a
// timer, woken by a watcher — starts through startTurn from here on:
// one lock, one abort registration, one turn id, one SSE wiring.
configureStartTurn({ chatTurnDeps, publish });
{
  const consult = config.realtimeVoice?.consult;
  if (consult && (consult.lockPatienceMs !== undefined || consult.answerPatienceMs !== undefined)) {
    logger.warn({
      msg: 'config.retired_keys',
      keys: ['realtimeVoice.consult.lockPatienceMs', 'realtimeVoice.consult.answerPatienceMs'],
      hint: 'ignored since 2026-09-13 — a spoken question waits realtimeVoice.consult.quickAnswerMs, then is handed over',
    });
  }
}

// Realtime voice — one manager owns every live call. The browser is a
// dumb terminal on this feature (microphone in, speaker out, state on
// screen); agent, session, provider, key and tool execution all live
// here. Design: private/realtime-voice-design.md
// One watcher per live call: the socket that is listening to it.
export const voiceWatchers = new Map<string, (ev: RealtimeEvent, snap: VoiceCallSnapshot) => void>();
export const voiceStateWatchers = new Map<string, (snap: VoiceCallSnapshot) => void>();
export const voiceCalls = new VoiceCallManager({
  get config() {
    return config;
  },
  watcher: (callId) => voiceWatchers.get(callId),
  stateWatcher: (callId) => voiceStateWatchers.get(callId),
  listAgentNames: async () => (await listAgents()).map((a) => a.name),
  // A call writes into a session outside any turn. What it writes has to
  // leave here in the SAME shape a turn produces: an earlier version
  // pushed the raw event through a cast, the SSE writer threw on it, and
  // publish() read the throw as a dead subscriber — so every spoken line
  // disconnected the chat window, the TUI and the phone from that
  // session (85 evictions on 2026-09-12).
  publishEvent: (agent, session, ev) => {
    const sse = serializeSessionEvent(ev);
    if (!sse) return;
    void publish(agent, session, sse);
  },
  sessionStatus: async (agent, session) => {
    const st = getSessionLockStatus(agent, session);
    return {
      busy: st.busy,
      ...(st.activeSince ? { sinceMs: Date.now() - st.activeSince } : {}),
      ...(st.queueLength ? { queued: st.queueLength } : {}),
    };
  },
  runConsult: async ({ agent, session, text, prefix, callId }) => {
    // A conversation cannot wait on a build.
    //
    // Live 2026-09-11: the agent was asked to write a small game in a
    // tmux session; its turn stayed open for minutes and the call had
    // nothing to say for that whole time. Since 2026-09-13 a spoken
    // question is queued like any other turn (no more giving up on a
    // busy session) and the call waits ONE patience for the answer —
    // for the session and for the turn together. Past it the voice
    // says it handed the request over and keeps talking; the ledger
    // brings the answer back to the call when it lands (deliver), or
    // the voice fetches it when the user asks (consultResult).
    const quickAnswerMs = config.realtimeVoice?.consult?.quickAnswerMs ?? 8_000;
    const consultId = randomUUID();
    const origin: TurnOrigin = { kind: 'voice', consultId, ...(callId ? { callId } : {}) };
    openWork({
      id: consultId,
      origin,
      target: { agent, session },
      ...(callId ? { requester: { voiceCall: callId } } : {}),
      text,
      waiting: true,
      // Delivery goes through the call, never through a wake turn.
      wake: 'never',
    });
    const turn = startTurn({
      agent,
      session,
      text,
      turnId: consultId,
      workId: consultId,
      origin,
      // The framing and the last lines of the call travel beside the
      // question, not inside it: the model reads both, the session
      // records only what was asked.
      ...(prefix ? { turnPrefix: prefix } : {}),
      // A human watching the same session sees the question and the
      // answer appear live, exactly like any other turn.
    }).catch((err) => {
      logger.warn({ msg: 'voice.consult_turn_failed', consultId, agent, session, err: (err as Error).message });
      return null;
    });
    const timeout = Symbol('voice-consult-timeout');
    const raced = await Promise.race([
      turn,
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), quickAnswerMs)),
    ]);
    if (raced === timeout) {
      // Deliberately NOT cancelled: the user asked for the work, and it
      // finishes into the session. Only the conversation moves on.
      setWaiting(consultId, false);
      const position = listSessionWaiters(agent, session).find((w) => w.workId === consultId)?.position ?? 0;
      logger.info({ msg: 'voice.consult_handed_over', agent, session, consultId, position, afterMs: quickAnswerMs });
      return { text: 'handed over', pending: true, state: 'handed_over', consultId, position, turnId: consultId };
    }
    if (!raced) throw new Error('consult turn did not start');
    return {
      text: raced.finalText,
      ...(raced.outcome ? { outcome: raced.outcome } : {}),
      turnId: consultId,
      state: 'answered',
      consultId,
    };
  },
  consultResult: async (consultId) => {
    const it = getWork(consultId);
    if (!it || it.origin.kind !== 'voice') return null;
    if (it.state === 'queued' || it.state === 'running') {
      const position = listSessionWaiters(it.target.agent, it.target.session).find((w) => w.workId === consultId)?.position ?? 0;
      return { state: 'pending', ...(position ? { position } : {}) };
    }
    markFetched(consultId);
    if (it.state === 'done') return { state: 'done', text: it.result?.finalText ?? '' };
    return { state: 'failed', error: it.error ?? 'unknown error' };
  },
  markConsultFetched: async (consultId) => {
    markFetched(consultId);
  },
});
// Sentinel scheduler — wire deps + boot the trigger loop. Same pattern
// as configureSpawnTools: server boot owns the deps, sentinel imports
// the runtime via the injected reference. `completedRetentionDays`
// controls GC of terminal-state triggers (0 = disabled).
configureSentinel({
  chatTurnDeps,
  completedRetentionDays: config.sentinel.completedRetentionDays,
  getConfig: () => config,
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
// Video renders run for minutes on a shared GPU, so the turn that asks
// for one is released immediately and the agent is brought back when
// its video is ready — one wake per finished render, so four renders
// don't all wait for the slowest. The loop resumes jobs left in flight
// by a restart: the provider keeps rendering, and keeps the file, so
// picking the poll back up is all it takes.
if (config.videoGen?.enabled) {
  configureVideoWake({
    chatTurnDeps,
    publishEvent: (agent, session, event) =>
      publish(agent, session, event as Parameters<typeof publish>[2]),
  });
  configureVideoNotifier(async (job) => {
    await wakeForJob(job);
  });
  startVideoRunner(() => config);
}

// Subagent attention wake (2026-07-28 feedback): a finished async sub
// whose result nobody fetched wakes its parent — same mechanic as the
// tmux watcher, incl. the SSE publish so open clients see the wake
// turn live (feedback_publishsse_must_broadcast). The wake turn
// queues on the parent's session lock, so it never interrupts an
// active turn.
// Shared browser service — the Chromium processes live here. The wake
// on hand-back goes through the same lock + runChatTurn path as a
// subagent attention wake, so it streams live and respects the queue.
export const browserService = configureBrowserService(config.browser, {
  resolveSession: resolveBrowserSession,
  dispatchWakeTurn: async ({ agent, session, text, prefix, viewId, cause, handoffId }) => {
    session = await resolveBrowserSession(agent, session);
    const origin: TurnOrigin = { kind: 'browser', viewId, cause, ...(handoffId ? { handoffId } : {}) };
    const workId = `browser-${handoffId ?? randomUUID()}`;
    openWork({ id: workId, origin, target: { agent, session }, text, waiting: false, wake: 'never' });
    await startTurn({
      agent,
      session,
      text,
      turnPrefix: prefix,
      workId,
      origin,
      // The lock wait can be long; the session may have been archived
      // meanwhile. Re-check once the lock is held, before anything is
      // written.
      beforeRun: async () => {
        await resolveBrowserSession(agent, session);
        return true;
      },
    });
  },
});
await browserService.init();
export const screencasts = new ScreencastRegistry(browserService);

// An answer nobody is waiting for still has to arrive. Same pattern as
// the sub-agent wake above, for the case that cost a real result on
// 2026-09-12: ada asked bea with the minimum timeout, stopped
// waiting after a second, and never learned that her 208-second answer
// existed.
// One wake for every kind of finished work (Phase 2): a late agent_ask
// answer, a background sub-agent, a rendered video. The grace is one
// config value; the item's own origin says what the wake is about, so
// the reader sees an agent answer as an agent answer and a sub-agent
// as a sub-agent (the operator, 2026-09-12 — "war ja eine agent_ask message
// oder?"). A sub-orchestrator is woken at ITS depth, so it keeps the
// SUBAGENT framing and the depth cap it had when it spawned.
// Queue changes reach the clients from the ledger itself: an entry taken
// back by a person or cancelled by its agent leaves the queue, and the
// badge must follow at once, whoever removed it.
onWorkFinished((it) => {
  if (it.state !== 'dequeued' && it.state !== 'cancelled') return;
  void publish(it.target.agent, it.target.session, { event: 'turn_dequeued', data: { turnId: it.id, workId: it.id } });
});

configureWorkWake({
  graceMs: config.agentLoop.wakeGraceMs,
  dispatchWakeTurn: async ({ agent, session, text, prefix, about, ref, depth, mediaIds, id }) => {
    const origin: TurnOrigin = { kind: 'wake', about, ref, ...(depth > 0 ? { depth } : {}) };
    const workId = id ?? `wake-${ref}`;
    openWork({ id: workId, origin, target: { agent, session }, text, waiting: false, wake: 'never' });
    try {
      await startTurn({
        agent,
        session,
        text,
        ...(prefix ? { turnPrefix: prefix } : {}),
        workId,
        origin,
        ...(mediaIds && mediaIds.length > 0 ? { attachMediaIds: mediaIds } : {}),
      });
    } catch (err) {
      // Withdrawn while it waited (the requester read the result first,
      // work-ledger.ts withdrawQueuedWake) or taken out by a person:
      // nothing to run, nothing to report.
      if (err instanceof DequeuedError) return;
      throw err;
    }
  },
  // A follow-up for an agent that asked (private/turn-dispatch-
  // followup-design.md §2): a normal A2A message from the target's
  // session back to the asker, correlated by the original call id. No
  // requester on the item — nobody waits for it and a take-back of it
  // wakes no one; the receiver treats it like any message from that
  // agent.
  dispatchFollowUpMessage: async ({ from, to, callId, text, prefix, id }) => {
    const origin: TurnOrigin = { kind: 'agent', from: { agent: from.agent, session: from.session }, callId };
    openWork({ id, origin, target: to, text, waiting: false, wake: 'never' });
    logger.info({ msg: 'a2a.follow_up', callId, from_agent: from.agent, from_session: a2aSessionSlugOf(from.session), to_agent: to.agent, to_session: to.session, id });
    await startTurn({ agent: to.agent, session: to.session, text, turnPrefix: prefix, workId: id, origin });
  },
});

// The askers of the turns the last process died in (see boot above).
for (const t of interruptedTurns) {
  // somora itself speaking — not the asked agent's answer and not the
  // helper's result — so these go out as `system` wakes; `what` only
  // says for the log which wait was cut.
  const wakes: Array<{ agent: string; session: string; text: string; ref: string; what: 'a2a' | 'subagent' }> = [];
  if (t.fromAgent && t.fromSession && t.callId) wakes.push({ agent: t.fromAgent, session: t.fromSession, text: restartWakeText(t), ref: t.callId, what: 'a2a' });
  if (t.parent) wakes.push({ agent: t.parent.agent, session: t.parent.session, text: restartParentWakeText(t), ref: t.turnId, what: 'subagent' });
  for (const w of wakes) {
    const origin: TurnOrigin = { kind: 'wake', about: 'system', ref: w.ref, cause: 'restart' };
    const workId = `restart-wake-${w.ref}`;
    openWork({ id: workId, origin, target: { agent: w.agent, session: w.session }, text: w.text, waiting: false, wake: 'never' });
    void startTurn({ agent: w.agent, session: w.session, text: w.text, workId, origin }).catch((err: unknown) => {
      if (err instanceof DequeuedError) return;
      logger.warn({ msg: 'restart.wake_failed', agent: w.agent, session: w.session, err: (err as Error).message });
    });
    logger.info({ msg: 'restart.wake_sent', to: `${w.agent}/${w.session}`, about: w.what, ref: w.ref });
  }
}
// The session that asked for the restart (or caused it from its own
// turn) is woken to check the outcome and carry on — restart-intent.ts.
{
  const resumeMode = config.server.resumeAfterRestart;
  const resumes: Array<{ agent: string; session: string; text: string; why: 'requested' | 'detected' | 'all' }> = [];
  const intent = readRestartIntent();
  if (intent) {
    clearRestartIntent();
    if (resumeMode !== 'off') resumes.push({ agent: intent.agent, session: intent.session, text: requestedResumeText(intent, SOMORA_VERSION), why: 'requested' });
  }
  for (const t of interruptedTurns) {
    if (resumeMode === 'off') break;
    if (resumes.some((r) => r.agent === t.agent && r.session === t.session)) continue;
    // A helper or an asked turn has its asker woken above; resuming it
    // here as well would answer the same question twice.
    if (t.callId || t.parent) continue;
    if (t.selfRestart || resumeMode === 'all') {
      resumes.push({ agent: t.agent, session: t.session, text: detectedResumeText(SOMORA_VERSION), why: t.selfRestart ? 'detected' : 'all' });
    }
  }
  for (const r of resumes) {
    if (!allowResume(r.agent, r.session)) {
      logger.warn({ msg: 'restart.resume_suppressed', to: `${r.agent}/${r.session}`, why: r.why, hint: 'woken twice within ten minutes already — not again, to avoid a restart loop' });
      continue;
    }
    const ref = `restart-${Date.now()}-${r.agent}`;
    const origin: TurnOrigin = { kind: 'wake', about: 'system', ref, cause: 'restart' };
    const workId = `restart-resume-${ref}`;
    openWork({ id: workId, origin, target: { agent: r.agent, session: r.session }, text: r.text, waiting: false, wake: 'never' });
    void startTurn({ agent: r.agent, session: r.session, text: r.text, workId, origin }).catch((err: unknown) => {
      if (err instanceof DequeuedError) return;
      logger.warn({ msg: 'restart.resume_failed', agent: r.agent, session: r.session, err: (err as Error).message });
    });
    logger.info({ msg: 'restart.resume_sent', to: `${r.agent}/${r.session}`, why: r.why });
  }
}
installTtsCacheGc(config);
configureLongTaskTimeouts(config);
setMaxWikiCallsPerTurn(config.wiki.lucid.maxCallsPerTurn);
configureExecConcurrencyCaps(
  config.agentLoop.execMaxConcurrentPerAgent,
  config.agentLoop.execMaxConcurrentGlobal,
);
logExecCaps();
/**
 * Keep the REM worker in step with every agent's `dreams` switch and the
 * central `rem.model`: at start, after a config reload, after the switch
 * is flipped. An agent that dreams but has no REM model anywhere is named
 * in the inbox.
 */
export async function syncDreamers(): Promise<void> {
  const noModel: string[] = [];
  for (const a of await listAgents()) {
    try {
      const persona = await loadPersona(a.name);
      if (!persona) continue;
      const settings = syncRemRegistration(remWorker, a.name, persona, config);
      if (!settings.ok && settings.reason === 'no-model') noModel.push(a.name);
    } catch (err) {
      logger.warn({ msg: 'dream.rem.register_failed', agent: a.name, err: String(err) });
    }
  }
  if (noModel.length > 0) {
    logger.warn({ msg: 'dream.rem.no_model', agents: noModel, hint: 'set rem.model in config.yaml, or rem.model in the agent.yaml' });
    inbox.raise('config:rem-model', {
      kind: 'config',
      level: 'warning',
      title: 'REM has no model',
      text: `${noModel.join(', ')} ${noModel.length === 1 ? 'dreams' : 'dream'}, but no REM model is set, so ${noModel.length === 1 ? 'its' : 'their'} conversations are not read. Set \`rem.model\` in config.yaml (or in the agent.yaml) and reload. See docs/dream-phases.md.`,
    }, { count: false });
  } else {
    inbox.resolve('config:rem-model');
  }
}
await syncDreamers();
if (dreamsMigrated.length > 0) {
  const line = (m: (typeof dreamsMigrated)[number]) => `- ${m.agent}: ${m.dreams ? 'dreams' : 'does not dream'}${m.error ? ` (file not rewritten: ${m.error})` : ''}`;
  inbox.raise('dream:switch', {
    kind: 'dream',
    level: dreamsMigrated.some((m) => m.error) ? 'warning' : 'info',
    title: 'One dreams switch per agent',
    text: `REM, Deep and the dream tools now follow one switch per agent (\`dreams:\` in agent.yaml, or the Agent window). Set from what each agent did before; backups next to each file.\n\n${dreamsMigrated.map(line).join('\n')}`,
  }, { count: false });
}

// DeepWorker — Memory→Wiki consolidation. Server-global, real-clock-
// scheduled. Only starts if config.wiki.enabled AND wiki.deep.enabled.
// Deep operates on whatever memory files are currently on disk; it
// never triggers REM. New observations land in memory only after the
// user approves REM findings via dream_apply.
const globalVault = resolveObsidianSource(config.obsidian);
export const deepWorker = new DeepWorker({
  get config() {
    return config;
  },
  getParticipatingAgents: async () => {
    if (!globalVault) return [];
    // Live-listing (not the boot-time `agentList` snapshot) so agents
    // added at runtime are picked up by the next Deep run without
    // a server restart.
    const liveAgents = await listAgents();
    const out: Array<{ name: string; vaultPath: string }> = [];
    for (const a of liveAgents) {
      const persona = await loadPersona(a.name);
      // Only agents that dream hand their notes to Deep.
      if (!persona?.dreams) continue;
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
export const lucidWorker = new LucidWorker({
  get config() {
    return config;
  },
});
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

if (tlsCert && tlsConf) {
  new TlsKeeper({
    server: httpServer as unknown as SecureContextHolder,
    certPath: expandHomePath(tlsConf.cert),
    keyPath: expandHomePath(tlsConf.key),
    publicHost: tlsConf.publicHost,
    renew: tlsConf.renew,
    log: logger,
    loadedCert: tlsCert,
  }).start();
}

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
// Dead-peer detection on the transport: TCP keepalive on every socket,
// h2 PING per session with a timeout (TLS listener). sessionTimeout
// stays 0 on purpose — an idle-session timeout would cut a long
// /chat/send-sync wait; PING only kills sessions that stop answering.
// Report 2026-09-03: 16 SSE streams of vanished tabs stayed open for
// 25 minutes because nothing on the server ever probed the peer.
const liveness = installTransportLiveness(httpServer, {
  keepAliveDelayMs: config.sse.keepAliveDelayMs,
  h2PingIntervalMs: config.sse.h2PingIntervalMs,
  h2PingTimeoutMs: config.sse.h2PingTimeoutMs,
});
logger.info({ msg: 'transport.liveness', ...liveness, keepAliveDelayMs: config.sse.keepAliveDelayMs, h2PingIntervalMs: config.sse.h2PingIntervalMs, h2PingTimeoutMs: config.sse.h2PingTimeoutMs });

// Best-effort cleanup on signal — keeps embedding processes from lingering
// and SQLite handles closed cleanly. tsx watch tends to send SIGTERM on reload.
async function shutdown(signal: string): Promise<void> {
  logger.info({ msg: 'server.shutdown', signal });
  // Await: aborts in-flight REM runs and waits (bounded, 5s) until the
  // aborted dream lands as `paused` on disk — exiting earlier archived
  // it as empty-processed instead (report 2026-07-25, restart-kills).
  await remWorker.shutdown();
  await shutdownLsp();
  deepWorker.shutdown();
  lucidWorker.shutdown();
  // A standing call is a paid connection. Exiting without closing it
  // leaves the provider to notice the dead socket in its own time, and
  // the meter runs until it does.
  await voiceCalls.stopAll(`server ${signal}`).catch(() => {});
  releaseLockfile();
  stopClaudeCredentialSyncWatcher();
  await shutdownMemoryRegistry();
  await screencasts.shutdown().catch(() => {});
  await browserService.shutdown().catch(() => {});
  closeAllExternal();
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

// SOMORA_DUMP_ROUTES=<file>: write every registered route (method, path,
// in registration order) to that file once the module has run. A test
// seam for moving routes between files — the list and its order must
// stay the same. Nothing happens without it.
if (process.env.SOMORA_DUMP_ROUTES) {
  writeFileSync(
    process.env.SOMORA_DUMP_ROUTES,
    app.routes.map((r) => `${r.method} ${r.path}`).join('\n') + '\n',
  );
}
