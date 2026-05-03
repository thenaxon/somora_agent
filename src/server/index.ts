import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { resolveCompactionConfig } from '../compaction/index.ts';
import { configPath, loadConfig } from '../config/loader.ts';
import { type Config, listAllModels, resolveAnyRef, type ThinkingLevel } from '../config/types.ts';
import { injectMemoryContext } from '../memory/inject.ts';
import {
  ensureMemoryDirs,
  getMemoryManager,
  shutdownMemoryRegistry,
} from '../memory/registry.ts';
import { getEffectiveEnv } from './env.ts';
import { SOMORA_HOME_DIR } from './logger.ts';
import { buildSelfPointer, ensureWorkspaceDirs } from './workspace.ts';
import { engineRegistry } from '../engine/registry.ts';
import {
  ensureDefaultAgent,
  listAgents,
  loadPersona,
  type Persona,
} from '../persona/loader.ts';
import {
  appendEvent,
  createSession,
  getHistory,
  listSessions,
  resetSession,
  resolveSessionId,
  sessionMetaStore,
} from '../storage/sessions.ts';
import {
  dreamTools,
  fileTools,
  memoryTools,
  obsidianTools,
  resourceTools,
  somoraDocsTools,
  timeTools,
  ToolRegistry,
  webTools,
} from '../tools/index.ts';
import { shutdownSshPool } from '../ssh/index.ts';
import { archiveEmptyCompletedDreams, recoverOrphanRunningDreams } from '../dream/storage.ts';
import { runDream } from '../dream/runner.ts';
import { AutoDreamWorker } from '../dream/auto-worker.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';
import { logger } from './logger.ts';
import { formatArgs, formatDetails, formatResult, shortToolName } from './tool-format.ts';

// Per-turn SSE serializer. Holds a callId→tool map so tool_result events
// (which only carry callId in the wire format) can be correlated back to
// the originating tool name and pre-formatted accordingly. Clients
// receive renderable strings, not raw payloads — keeps TUI / Orbit / web
// consumers thin.
function createTurnSerializer() {
  const callIdToTool = new Map<string, string>();
  return function serialize(ev: NormalizedEvent): SseEvent | null {
    switch (ev.kind) {
      case 'assistant_delta':
        return { event: 'chat', data: { state: 'delta', text: ev.text } };
      case 'assistant_message':
        return { event: 'chat', data: { state: 'final', text: ev.text } };
      case 'tool_call': {
        const tool = shortToolName(ev.tool);
        callIdToTool.set(ev.callId, tool);
        return {
          event: 'tool',
          data: {
            phase: 'call',
            tool,
            summary: formatArgs(ev.tool, ev.input),
            details: formatDetails(ev.input),
          },
        };
      }
      case 'tool_result': {
        const tool = callIdToTool.get(ev.callId) ?? '?';
        if (ev.error) {
          return {
            event: 'tool',
            data: { phase: 'error', tool, error: ev.error },
          };
        }
        const summary = formatResult(tool, ev.output);
        // Trivial successes (e.g. {ok:true} after memory_write) are
        // suppressed — the call line already conveys the action.
        if (summary === null) return null;
        return {
          event: 'tool',
          data: {
            phase: 'result',
            tool,
            summary,
            details: formatDetails(ev.output),
          },
        };
      }
      case 'error':
        return { event: 'status', data: { msg: `error: ${ev.message}` } };
      default:
        return null;
    }
  };
}

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
async function* runTurnWithFallback(args: {
  primary: ReturnType<typeof resolveEffectiveModel>;
  fallbackRef: string | undefined;
  baseInput: Omit<Parameters<typeof engineRegistry[keyof typeof engineRegistry]['runTurn']>[0], 'resolvedModel'>;
}): AsyncGenerator<NormalizedEvent> {
  const { primary, fallbackRef, baseInput } = args;
  if (!primary) return;
  const primaryEngine = engineRegistry[primary.provider.engine];
  if (!primaryEngine) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: `engine '${primary.provider.engine}' not registered`,
    };
    return;
  }

  let hasContent = false;
  let primaryError: string | null = null;

  try {
    for await (const ev of primaryEngine.runTurn({ ...baseInput, resolvedModel: primary })) {
      if (ev.kind === 'assistant_delta' || ev.kind === 'assistant_message') hasContent = true;
      if (ev.kind === 'error' && !hasContent) {
        // Hold back the error event — fallback will replace this whole turn
        primaryError = ev.message;
        continue;
      }
      if (ev.kind === 'turn_end' && primaryError) {
        // Hold back the trailing turn_end too while we plan a fallback
        continue;
      }
      yield ev;
    }
  } catch (err) {
    if (hasContent) throw err;
    primaryError = (err as Error).message;
  }

  if (!primaryError) return;

  // Primary failed before any content — try fallback
  if (!fallbackRef) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: primaryError,
    };
    yield {
      kind: 'turn_end',
      ts: Date.now(),
      engine: primary.provider.engine,
      turnId: `t-${Date.now()}`,
    };
    return;
  }

  const fallbackResolved = resolveAnyRef(config, fallbackRef);
  if (!fallbackResolved) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: `primary failed (${primaryError}); fallback '${fallbackRef}' not found in config`,
    };
    yield {
      kind: 'turn_end',
      ts: Date.now(),
      engine: primary.provider.engine,
      turnId: `t-${Date.now()}`,
    };
    return;
  }
  const fallbackEngine = engineRegistry[fallbackResolved.provider.engine];
  if (!fallbackEngine) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: fallbackResolved.provider.engine,
      message: `fallback engine '${fallbackResolved.provider.engine}' not registered`,
    };
    yield {
      kind: 'turn_end',
      ts: Date.now(),
      engine: fallbackResolved.provider.engine,
      turnId: `t-${Date.now()}`,
    };
    return;
  }

  logger.warn({
    msg: 'engine.fallback',
    primary: `${primary.providerName}/${primary.modelId}`,
    fallback: `${fallbackResolved.providerName}/${fallbackResolved.modelId}`,
    reason: primaryError,
  });

  for await (const ev of fallbackEngine.runTurn({ ...baseInput, resolvedModel: fallbackResolved })) {
    yield ev;
  }
}

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

logger.info({
  msg: 'somora.env',
  env: getEffectiveEnv(),
});

// Construct the process-wide tool registry. Built once at startup,
// shared by HTTP debug endpoints today and by MCP/agent-loop later.
const tools = new ToolRegistry();
tools.registerMany(memoryTools());
tools.registerMany(dreamTools());
tools.registerMany(timeTools());
tools.registerMany(webTools());
tools.registerMany(obsidianTools());
tools.registerMany(somoraDocsTools());
tools.registerMany(resourceTools());
tools.registerMany(fileTools());
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
    getMemoryManager: () => getMemoryManager(agent, { config: config.memory }),
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
  const mgr = await getMemoryManager(agent, { config: config.memory });
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
  const mgr = await getMemoryManager(agent, { config: config.memory });
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

  // Spawn dream over the archived range — async, no await, no
  // ramifications for the reset response. If it fails, only the dream
  // file gets a `failed` status; user is otherwise unaffected.
  let dreamSpawned = false;
  if (persona.dream?.enabled) {
    const archivedId = result.archivedId;
    const dreamConfig = persona.dream;
    void (async () => {
      try {
        const mgr = await getMemoryManager(agent, { config: config.memory });
        await runDream({
          agent,
          sourceSession: archivedId,
          trigger: 'manual',
          rangeFromTs: 0,
          rangeThroughTs: Date.now(),
          dream: dreamConfig,
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
  const agent = c.req.query('agent') ?? 'hans';
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
    /** Sub-agent nesting depth (0 = top-level). Reserved for future spawn flow. */
    subagent_depth?: number;
  };
  const agent = body.agent ?? 'hans';
  const sessionRef = body.session ?? 'main';
  const text = body.text ?? '';
  const fromAgent =
    typeof body.from_agent === 'string' && body.from_agent.length > 0 ? body.from_agent : undefined;
  const subagentDepth =
    typeof body.subagent_depth === 'number' && body.subagent_depth > 0 ? body.subagent_depth : 0;

  const persona = await loadPersona(agent);
  if (!persona) {
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

  const sessionMeta = await sessionMetaStore.get(agent, session);
  const resolvedModel = resolveEffectiveModel(config, persona, sessionMeta);
  if (!resolvedModel) {
    logger.error({ msg: 'chat.send.model_unresolved', agent, ref: persona.model });
    return c.json(
      {
        error: `model '${persona.model ?? '(none)'}' für agent '${agent}' lässt sich nicht aus config.yaml auflösen — Format: provider/modelId oder alias`,
      },
      500,
    );
  }
  const engine = engineRegistry[resolvedModel.provider.engine];
  if (!engine) {
    return c.json({ error: `keine engine '${resolvedModel.provider.engine}' registriert` }, 500);
  }

  logger.info({
    msg: 'chat.send',
    agent,
    session,
    ref: sessionRef,
    provider: resolvedModel.providerName,
    model: resolvedModel.modelId,
    len: text.length,
  });

  await appendEvent(agent, session, {
    kind: 'user_message',
    ts: Date.now(),
    engine: engine.name,
    text,
    ...(fromAgent ? { from_agent: fromAgent } : {}),
  });

  // User just spoke → cancel any in-flight auto-dream for this agent
  // and reset the idle countdown. resetActivity is a no-op if the agent
  // isn't dream-enabled.
  autoDreamWorker.resetActivity(agent);

  void (async () => {
    const startModelSupportsReasoning =
      resolvedModel.model.capabilities.includes('reasoning');
    const effectiveThinking = resolveEffectiveThinking(persona, sessionMeta);
    const startThinkingPayload = effectiveThinking
      ? { level: effectiveThinking, active: startModelSupportsReasoning }
      : undefined;
    await publish(session, {
      event: 'agent',
      data: {
        phase: 'start',
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        ...(startThinkingPayload ? { thinking: startThinkingPayload } : {}),
      },
    });
    let lastUsage:
      | {
          tokens_in: number;
          tokens_out: number;
          tokens_in_cached?: number;
          tokens_out_reasoning?: number;
        }
      | undefined;
    try {
      const history = await getHistory(agent, session);

      // Auto-inject memory recall (DECISION #26). Best-effort: if init or
      // search fails, we proceed without an ephemeral block — persona is
      // unaffected. The block is passed as TurnInput.ephemeralContext so
      // each engine can transport it appropriately (claude-cli appends to
      // systemPrompt, codex-cli prepends to user message on resume, etc.).
      let ephemeralContext: string | undefined;
      try {
        const mgr = await getMemoryManager(agent, { config: config.memory });
        const inject = await injectMemoryContext({
          mgr,
          history,
          userMessage: text,
          cfg: config.memory.autoInject,
        });
        ephemeralContext = inject.ephemeralContext;
        const refs = inject.hits.map((h) => `${h.source}/${h.slug}`);
        const topScore = inject.hits[0]?.score;
        if (inject.injectedCount > 0) {
          logger.info({
            msg: 'memory.injected',
            agent,
            session,
            count: inject.injectedCount,
            slugs: refs,
            topScore,
          });
        }
        // Always emit the SSE memory event — even on zero hits — so the
        // CLI can show "[memory · 0 hits]" and the user knows recall ran.
        // fullText carries the actual inject block so /verbose memory can
        // show what landed in the model's context.
        await publish(session, {
          event: 'memory',
          data: {
            count: inject.injectedCount,
            ...(topScore !== undefined ? { topScore } : {}),
            refs,
            fullText: inject.ephemeralContext ?? '',
          },
        });
      } catch (err) {
        logger.warn({ msg: 'memory.inject_failed', agent, err: (err as Error).message });
      }

      // Bind the agent context into the tool invoker for engines that run
      // their own agent-loop (currently only openai-compatible). claude-cli
      // and codex-cli consume tools via MCP and ignore this field.
      // listAvailable filters tools whose `available(ctx)` returns false —
      // model never sees a tool it can't actually run (no API key →
      // no web_search exposed, no vault → no obsidian_* exposed, etc.).
      const toolCtx = {
        agent,
        getMemoryManager: () => getMemoryManager(agent, { config: config.memory }),
        config,
      };
      const availableTools = await tools.listAvailable(toolCtx);
      const toolInvoker = {
        list: () => availableTools,
        invoke: (name: string, input: unknown) => tools.invoke(name, input, toolCtx),
      };

      // Self-pointer: tell the agent who it is and where its files
      // live. Stable per-session (no per-turn data) so engines that
      // cache systemPrompt keep their cache. Prepended so it's the
      // first thing the model sees.
      const selfPointer = buildSelfPointer(persona, config, SOMORA_HOME_DIR);
      const systemPromptForTurn = `${selfPointer}\n\n---\n\n${persona.systemPrompt}`;

      const stream = runTurnWithFallback({
        primary: resolvedModel,
        fallbackRef: persona.fallback,
        baseInput: {
          agent,
          session,
          systemPrompt: systemPromptForTurn,
          ephemeralContext,
          userMessage: text,
          ...(fromAgent ? { fromAgent } : {}),
          ...(subagentDepth > 0 ? { subagentDepth } : {}),
          history,
          metaStore: sessionMetaStore,
          availableModels: listAllModels(config),
          compactionConfig: resolveCompactionConfig(config),
          tools: toolInvoker,
          agentLoopConfig: config.agentLoop,
          ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
        },
      });
      const serialize = createTurnSerializer();
      for await (const ev of stream) {
        if (ev.kind !== 'assistant_delta') {
          await appendEvent(agent, session, ev);
        }
        if (ev.kind === 'turn_end' && ev.usage) lastUsage = ev.usage;
        const sse = serialize(ev);
        if (sse) await publish(session, sse);
      }
    } catch (err) {
      logger.error({ msg: 'turn.fail', agent, session, err: String(err) });
      await publish(session, { event: 'status', data: { msg: `turn failed: ${(err as Error).message}` } });
    }
    const modelSupportsReasoning =
      resolvedModel.model.capabilities.includes('reasoning');
    const thinkingPayload = effectiveThinking
      ? { level: effectiveThinking, active: modelSupportsReasoning }
      : undefined;
    await publish(session, {
      event: 'agent',
      data: {
        phase: 'end',
        ...(lastUsage ? { usage: lastUsage } : {}),
        contextWindow: resolvedModel.model.contextWindow,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        ...(thinkingPayload ? { thinking: thinkingPayload } : {}),
      },
    });
  })();

  return c.json({ ok: true }, 202);
});

const port = Number(process.env.SOMORA_PORT ?? config.server.port);

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

// Auto-Dream-Worker: per-agent idle-trigger that picks up dream-enabled
// agents and runs background extractions. Registers each enabled agent
// once at startup; the first idle timer runs idleMinutes from now,
// which gives any paused-from-crash dreams a quiet window to be picked up.
const autoDreamWorker = new AutoDreamWorker({
  config,
  getMemoryManager: (agent) => getMemoryManager(agent, { config: config.memory }),
});
for (const a of agentList) {
  try {
    const persona = await loadPersona(a.name);
    if (persona?.dream?.enabled) {
      autoDreamWorker.register(a.name, persona.dream);
    }
  } catch (err) {
    logger.warn({ msg: 'dream.auto.register_failed', agent: a.name, err: String(err) });
  }
}

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  logger.info({ msg: 'server.start', port: info.port });
});

// Best-effort cleanup on signal — keeps embedding processes from lingering
// and SQLite handles closed cleanly. tsx watch tends to send SIGTERM on reload.
async function shutdown(signal: string): Promise<void> {
  logger.info({ msg: 'server.shutdown', signal });
  autoDreamWorker.shutdown();
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
