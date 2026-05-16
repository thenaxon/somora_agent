import { serve, upgradeWebSocket } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { streamSSEH2Safe } from './sse-h2-safe.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createSecureServer as createHttp2SecureServer } from 'node:http2';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { WebSocketServer } from 'ws';
import { applyClaudeCliSdkEnv, applyCodexCliEnv, configPath, loadConfig } from '../config/loader.ts';
import { type Config, resolveAnyRef, type ThinkingLevel } from '../config/types.ts';
import { storeAttachment } from '../attachments/store.ts';
import { detectMimeFromPath } from '../multimodal/mime.ts';
import { existsSync } from 'node:fs';
import { readFile as fsReadFile, stat as statFs, readFile as readFileFs } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { checkReadAllowed, expandHome, realpathSafeAncestor } from '../tools/file/policy.ts';
import { listTmuxSessions } from '../tmux/list.ts';
import {
  ensureMemoryDirs,
  getMemoryManager,
  shutdownMemoryRegistry,
} from '../memory/registry.ts';
import { setupClaudeConfigDir } from './claude-config-dir.ts';
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
import {
  configureDreamRunTool,
  configureExecConcurrencyCaps,
  configureSpawnTools,
  logExecCaps,
  recoverOrphanedJobs,
  registerAllTools,
  ToolRegistry,
} from '../tools/index.ts';
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
import { resolveObsidianSource } from '../memory/registry.ts';
import type { SseEvent } from '../types/events.ts';
import { logger } from './logger.ts';
import { runChatTurn } from './run-turn.ts';
import { registerChatAbort, triggerChatAbort } from './chat-aborts.ts';
import { acquireSessionLock, listAllSessionLockStates } from './session-queue.ts';
import { readLockfile } from './lockfile.ts';
import { acquireLockfile, LockfileBusy, releaseLockfile } from './lockfile.ts';
import { SOMORA_VERSION } from '../version.ts';
import {
  completeTask,
  failTask,
  getTask,
  listTasksForAgent,
  newTaskId,
  registerTask,
  waitForTaskCompletion,
} from './async-tasks.ts';
import { reserveSpawnSlot, releaseSpawnSlot } from '../tools/agents/spawn.ts';

type Subscriber = (e: SseEvent) => Promise<void>;
const streams = new Map<string, Set<Subscriber>>();

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

function subscribe(agent: string, session: string, sub: Subscriber): () => void {
  const key = streamKey(agent, session);
  let set = streams.get(key);
  if (!set) {
    set = new Set();
    streams.set(key, set);
  }
  set.add(sub);
  return () => {
    set?.delete(sub);
    if (set && set.size === 0) streams.delete(key);
  };
}

// Track the last SSE event we published per (agent, session). The
// `/health` endpoint surfaces "seconds since last engine activity" so
// an operator can tell at a glance whether a session is silently
// wedged. Cheap: a single Map.set per published event.
const lastEngineEventAt = new Map<string, number>();

async function publish(agent: string, session: string, event: SseEvent): Promise<void> {
  const key = streamKey(agent, session);
  lastEngineEventAt.set(key, Date.now());
  const subs = streams.get(key);
  if (!subs) return;
  // Snapshot — failed subscribers get evicted mid-iteration
  const dead: Subscriber[] = [];
  for (const sub of [...subs]) {
    try {
      await sub(event);
    } catch (err) {
      logger.warn({ msg: 'sse.publish_fail', session, err: String(err) });
      dead.push(sub);
    }
  }
  if (dead.length > 0) {
    const set = streams.get(key);
    if (set) {
      for (const d of dead) set.delete(d);
      if (set.size === 0) streams.delete(key);
      logger.info({ msg: 'sse.publish_evict_dead', agent, session, count: dead.length });
    }
  }
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
  console.error('\n\x1b[31m[!] somora konnte ~/.somora/config.yaml nicht laden:\x1b[0m\n');
  console.error((err as Error).message);
  console.error(`\nDatei: ${configPath()}`);
  console.error('Bitte YAML / Schema fixen und Server neu starten.\n');
  process.exit(1);
}
logger.info({
  msg: 'config.loaded',
  providers: Object.keys(config.providers).join(','),
  port: config.server.port,
});

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
    checkWorker('worker', config.vision.worker, !config.vision.pdfWorker);
    checkWorker('pdfWorker', config.vision.pdfWorker, true);
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
    const lastEvent = lastEngineEventAt.get(streamKey(s.agent, s.session));
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
const FILEVIEW_EXT_KIND: Record<string, 'markdown' | 'text' | 'code'> = {
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
  const kind = FILEVIEW_EXT_KIND[ext] ?? null;
  if (!kind) {
    return c.json({ error: `unsupported file type for FileView (${ext || 'no extension'})` }, 415);
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
    ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
  });
});

// Tmux session listing for the web tmux-app. Joins live `tmux ls`
// output with somora's origin store. Empty list when no tmux server
// is running — that's a normal state, not an error.
app.get('/tmux/sessions', async (c) => {
  const sessions = await listTmuxSessions();
  return c.json({ sessions });
});

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
          const raw = ws.raw as { __pty?: typeof term } | undefined;
          if (raw) raw.__pty = term;
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
        const raw = ws.raw as { __pty?: { write: (s: string) => void; resize: (cols: number, rows: number) => void } } | undefined;
        const term = raw?.__pty;
        if (!term) return;
        const data = evt.data;
        if (typeof data === 'string') {
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
        const raw = ws.raw as { __pty?: { kill: () => void } } | undefined;
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
          const raw = ws.raw as { __pty?: typeof term } | undefined;
          if (raw) raw.__pty = term;
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
        const raw = ws.raw as { __pty?: { write: (s: string) => void; resize: (cols: number, rows: number) => void } } | undefined;
        const term = raw?.__pty;
        if (!term) return;
        const data = evt.data;
        if (typeof data === 'string') {
          // Text frame = control message (JSON). Currently only
          // resize.
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
        const raw = ws.raw as { __pty?: { kill: () => void } } | undefined;
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
  if (!persona) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
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
      const liveKey = `${agentInfo.name}:${s.id}`;
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
      });
    }
  }
  return c.json({ sessions: rows });
});

app.post('/agents/:agent/sessions/:session/archive', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  try {
    await archiveSession(agent, session, body.reason);
    logger.info({ msg: 'session.archive', agent, session, reason: body.reason });
    return c.json({ archived: true, agent, session });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post('/agents/:agent/sessions/:session/unarchive', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  }
  // Resolve against the include_archived view, otherwise an archived
  // session is not addressable by slug lookup. resolveSessionId works on
  // raw file existence so it's already include-archived-aware.
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
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
  if (!persona) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
  const meta = await sessionMetaStore.get(agent, session);
  const resolved = resolveEffectiveModel(config, persona, meta);
  if (!resolved) {
    return c.json({ error: `model für agent '${agent}' kann nicht aufgelöst werden` }, 500);
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
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { model?: string };
  if (!body.model) return c.json({ error: 'body field "model" required' }, 400);
  const resolved = resolveAnyRef(config, body.model);
  if (!resolved) {
    return c.json({ error: `model '${body.model}' nicht gefunden in config.yaml` }, 400);
  }
  const meta = await sessionMetaStore.get(agent, session);
  await sessionMetaStore.set(agent, session, { ...meta, modelOverride: body.model });
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
  const result = await resetSession(agent, session);
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
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
  const meta = await sessionMetaStore.get(agent, session);
  const { modelOverride: _drop, ...rest } = meta;
  await sessionMetaStore.set(agent, session, rest);
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
  if (!persona) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
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
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { level?: string };
  if (!body.level || !VALID_THINKING_LEVELS.has(body.level as ThinkingLevel)) {
    return c.json({ error: `body field "level" must be one of: off, low, medium, high` }, 400);
  }
  const meta = await sessionMetaStore.get(agent, session);
  await sessionMetaStore.set(agent, session, { ...meta, thinkingOverride: body.level });
  logger.info({ msg: 'session.thinking_set', agent, session, level: body.level });
  return c.json({ agent, session, level: body.level });
});

app.delete('/agents/:agent/sessions/:session/thinking', async (c) => {
  const agent = c.req.param('agent');
  const sessionRef = c.req.param('session');
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
  const meta = await sessionMetaStore.get(agent, session);
  const { thinkingOverride: _drop, ...rest } = meta;
  await sessionMetaStore.set(agent, session, rest);
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
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
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
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
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
  if (!(await loadPersona(agent))) return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) return c.json({ error: `session '${sessionRef}' nicht gefunden` }, 404);
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  }
  const id = await resolveSessionId(agent, sessionRef);
  if (!id) {
    return c.json({ error: `session '${sessionRef}' nicht gefunden für agent '${agent}'` }, 404);
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
  const filtered = all.filter((e) => e.ts < before);
  const slice = filtered.slice(-limit);
  const hasMore = filtered.length > slice.length;
  const oldestTs = slice.length > 0 ? slice[0]!.ts : null;
  return c.json({
    agent,
    session: id,
    events: slice,
    hasMore,
    ...(oldestTs !== null ? { oldestTs } : {}),
  });
});

app.get('/chat/stream', async (c) => {
  const sessionRef = c.req.query('session') ?? 'main';
  const agent = c.req.query('agent') ?? (await defaultAgentFallback());
  if (!agent) {
    return c.json({ error: 'no agents configured — create one in ~/.somora/agents/' }, 400);
  }
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    return c.json({ error: `session '${sessionRef}' nicht gefunden für agent '${agent}'` }, 404);
  }
  return streamSSEH2Safe(c, async (stream) => {
    logger.info({ msg: 'sse.connect', agent, session });
    const unsub = subscribe(agent, session, async (event) => {
      await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
    });
    await stream.writeSSE({ event: 'status', data: JSON.stringify({ msg: 'connected', session }) });
    // Heartbeat keeps TCP alive past Undici's idle-body timeout (~5 min default)
    // and gives the client a positive signal the link is still healthy.
    const heartbeat = setInterval(() => {
      stream
        .writeSSE({ event: 'heartbeat', data: String(Date.now()) })
        .catch((err) => logger.debug({ msg: 'sse.heartbeat_fail', session, err: String(err) }));
    }, 20_000);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsub();
        logger.info({ msg: 'sse.disconnect', agent, session });
        resolve();
      });
    });
  });
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
    return c.json({ error: `agent '${agent}' nicht gefunden — lege ~/.somora/agents/${agent}/AGENTS.md an` }, 404);
  }

  const session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    return c.json(
      {
        error: `session '${sessionRef}' nicht gefunden für agent '${agent}' — neue Session via POST /agents/${agent}/sessions { "slug": "${sessionRef}" }`,
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

  return c.json({ ok: true }, 202);
});

// /chat/abort — cancel an in-flight turn for (agent, session). Triggered
// by TUI ESC while streaming. Idempotent: returns aborted=false when no
// turn is running. Doesn't block — the engine adapter sees the signal
// and bails out, then runChatTurn's finally releases the controller.
app.post('/chat/abort', async (c) => {
  const agent = c.req.query('agent') ?? (await defaultAgentFallback());
  if (!agent) {
    return c.json({ error: 'no agents configured' }, 400);
  }
  const session = c.req.query('session') ?? 'main';
  const result = triggerChatAbort(agent, session);
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
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
  }
  const session = await resolveSessionId(agent, sessionRef);
  if (!session) {
    return c.json({ error: `session '${sessionRef}' nicht gefunden für agent '${agent}'` }, 404);
  }

  // Acquire the session lock. A from_agent caller (agent_ask, sub-spawn)
  // queues with priority='agent' and yields to any human user turn that
  // arrives in parallel. A direct user-side caller of /chat/send-sync
  // (rare — TUI uses /chat/send) gets priority='user'.
  //
  // Sub-spawn destinations are fresh sessions (sub-xxx-yyy), so the lock
  // is uncontended in that path; cost is one Map lookup + a Promise.
  const priority: 'user' | 'agent' = fromAgent ? 'agent' : 'user';
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
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  } finally {
    release();
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
  };
  const agent = body.agent;
  const session = body.session;
  const text = body.text ?? '';
  if (!agent || !session) {
    return c.json({ error: 'agent + session required' }, 400);
  }
  if (!(await loadPersona(agent))) {
    return c.json({ error: `agent '${agent}' nicht gefunden` }, 404);
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
  const slotErr = reserveSpawnSlot(agent);
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
    try {
      const result = await runChatTurn({
        agent,
        session,
        text,
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
    entry = (await waitForTaskCompletion(task_id, timeoutMs)) ?? entry;
  }
  if (entry.state === 'running') {
    return c.json({ error: `task '${task_id}' still running`, state: 'running' }, 409);
  }
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
  return c.json({
    rem,
    deep: { active: deepWorker.isRunning() },
    lucid: {
      active: lucidWorker.isRunning(),
      ...(lucidLoop ? { loopHolder: lucidLoop.agent } : {}),
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
process.env.SOMORA_HOST ??= '127.0.0.1';
const bindHost = process.env.SOMORA_HOST ?? '127.0.0.1';
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
  remWorker.shutdown();
  deepWorker.shutdown();
  lucidWorker.shutdown();
  releaseLockfile();
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
