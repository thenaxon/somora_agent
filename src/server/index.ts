import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { applyClaudeCliSdkEnv, applyCodexCliEnv, configPath, loadConfig } from '../config/loader.ts';
import { type Config, resolveAnyRef, type ThinkingLevel } from '../config/types.ts';
import {
  ensureMemoryDirs,
  getMemoryManager,
  shutdownMemoryRegistry,
} from '../memory/registry.ts';
import { getEffectiveEnv } from './env.ts';
import { SOMORA_HOME_DIR } from './logger.ts';
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
  resetSession,
  resolveSessionId,
  sessionMetaStore,
} from '../storage/sessions.ts';
import { configureLongTaskTimeouts } from '../tools/agents/long-task-timeouts.ts';
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
  recoverOrphanRunningDreams,
} from '../dream/storage.ts';
import { runDream } from '../dream/rem-runner.ts';
import { RemWorker } from '../dream/rem-worker.ts';
import { DeepWorker } from '../dream/deep-worker.ts';
import { LucidWorker } from '../dream/lucid-worker.ts';
import { resolveObsidianSource } from '../memory/registry.ts';
import type { SseEvent } from '../types/events.ts';
import { logger } from './logger.ts';
import { runChatTurn } from './run-turn.ts';
import { registerChatAbort, triggerChatAbort } from './chat-aborts.ts';
import { acquireSessionLock } from './session-queue.ts';
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

type Subscriber = (e: SseEvent) => Promise<void>;
const streams = new Map<string, Set<Subscriber>>();

function subscribe(session: string, sub: Subscriber): () => void {
  let set = streams.get(session);
  if (!set) {
    set = new Set();
    streams.set(session, set);
  }
  set.add(sub);
  return () => {
    set?.delete(sub);
    if (set && set.size === 0) streams.delete(session);
  };
}

async function publish(session: string, event: SseEvent): Promise<void> {
  const subs = streams.get(session);
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
    const set = streams.get(session);
    if (set) {
      for (const d of dead) set.delete(d);
      if (set.size === 0) streams.delete(session);
      logger.info({ msg: 'sse.publish_evict_dead', session, count: dead.length });
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

app.get('/env', (c) => c.json(getEffectiveEnv()));

// Display preferences for thin clients (TUI, future web). Server is the
// single config reader — clients fetch this rather than parsing config.yaml
// themselves.
app.get('/tui-config', (c) => c.json(config.tui));

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
  return c.json(await listSessions(agent));
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
  const events = await getHistory(agent, id);
  return c.json({ agent, session: id, events });
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
  return streamSSE(c, async (stream) => {
    logger.info({ msg: 'sse.connect', agent, session });
    const unsub = subscribe(session, async (event) => {
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

  logger.info({ msg: 'chat.send', agent, session, ref: sessionRef, len: text.length });

  // Fire-and-forget. Acquire the per-session lock with priority='user'
  // (default for /chat/send unless from_agent is set, in which case the
  // call is acting as A2A and yields to actual user turns). Release in
  // the finally block — forgetting deadlocks future turns on the session.
  const priority: 'user' | 'agent' = fromAgent ? 'agent' : 'user';
  void (async () => {
    const release = await acquireSessionLock(agent, session, {
      priority,
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
        signal: abort.signal,
        ...(fromAgent ? { fromAgent } : {}),
        ...(agentAskCallId ? { agentAskCallId } : {}),
        ...(subagentDepth > 0 ? { subagentDepth } : {}),
        publishSse: (event) => publish(session, event),
        deps: chatTurnDeps,
      });
    } catch (err) {
      logger.error({ msg: 'chat.send.run_failed', agent, session, err: (err as Error).message });
      void publish(session, { event: 'status', data: { msg: `turn failed: ${(err as Error).message}` } });
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
      publishSse: (event) => publish(session, event),
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
  // response — the caller already got their task_id back.
  void (async () => {
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
// The pre-sweep callback forces REM across all agents before Deep
// reads memory, so agents' un-processed sessions are settled into
// memory first. See `private/dream-system-v2.md`.
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
  preSweep: async () => {
    await remWorker.runPreSweep();
  },
});
deepWorker.start();
const lucidWorker = new LucidWorker({ config });
lucidWorker.start();
configureDreamRunTool({ deepWorker, lucidWorker });

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  logger.info({ msg: 'server.start', port: info.port });
});

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
