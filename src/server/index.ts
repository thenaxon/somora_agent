import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { resolveCompactionConfig } from '../compaction/index.ts';
import { configPath, loadConfig } from '../config/loader.ts';
import { type Config, listAllModels, resolveAnyRef } from '../config/types.ts';
import { injectMemoryContext } from '../memory/inject.ts';
import {
  ensureMemoryDirs,
  getMemoryManager,
  shutdownMemoryRegistry,
} from '../memory/registry.ts';
import { getEffectiveEnv } from './env.ts';
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
  resolveSessionId,
  sessionMetaStore,
} from '../storage/sessions.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';
import { logger } from './logger.ts';

function eventToSse(ev: NormalizedEvent): SseEvent | null {
  switch (ev.kind) {
    case 'assistant_delta':
      return { event: 'chat', data: { state: 'delta', text: ev.text } };
    case 'assistant_message':
      return { event: 'chat', data: { state: 'final', text: ev.text } };
    case 'tool_call':
      return { event: 'tool', data: { phase: 'call', tool: ev.tool, input: ev.input } };
    case 'tool_result':
      return { event: 'tool', data: { phase: 'result', output: ev.output, ...(ev.error ? { error: ev.error } : {}) } };
    case 'error':
      return { event: 'status', data: { msg: `error: ${ev.message}` } };
    default:
      return null;
  }
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
  const body = (await c.req.json()) as { agent?: string; session?: string; text?: string };
  const agent = body.agent ?? 'hans';
  const sessionRef = body.session ?? 'main';
  const text = body.text ?? '';

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
  });

  void (async () => {
    await publish(session, {
      event: 'agent',
      data: {
        phase: 'start',
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
      },
    });
    let lastUsage: { tokens_in: number; tokens_out: number } | undefined;
    try {
      const history = await getHistory(agent, session);

      // Auto-inject memory recall (DECISION #26). Best-effort: if init or
      // search fails, we proceed with the unaugmented systemPrompt.
      let systemPrompt = persona.systemPrompt;
      try {
        const mgr = await getMemoryManager(agent, { config: config.memory });
        const inject = await injectMemoryContext({
          mgr,
          systemPrompt,
          history,
          userMessage: text,
          cfg: config.memory.autoInject,
        });
        systemPrompt = inject.systemPrompt;
        if (inject.injectedCount > 0) {
          logger.info({
            msg: 'memory.injected',
            agent,
            session,
            count: inject.injectedCount,
            slugs: inject.hits.map((h) => `${h.source}/${h.slug}`),
            topScore: inject.hits[0]?.score,
          });
        }
      } catch (err) {
        logger.warn({ msg: 'memory.inject_failed', agent, err: (err as Error).message });
      }

      const stream = runTurnWithFallback({
        primary: resolvedModel,
        fallbackRef: persona.fallback,
        baseInput: {
          agent,
          session,
          systemPrompt,
          userMessage: text,
          history,
          metaStore: sessionMetaStore,
          availableModels: listAllModels(config),
          compactionConfig: resolveCompactionConfig(config),
        },
      });
      for await (const ev of stream) {
        if (ev.kind !== 'assistant_delta') {
          await appendEvent(agent, session, ev);
        }
        if (ev.kind === 'turn_end' && ev.usage) lastUsage = ev.usage;
        const sse = eventToSse(ev);
        if (sse) await publish(session, sse);
      }
    } catch (err) {
      logger.error({ msg: 'turn.fail', agent, session, err: String(err) });
      await publish(session, { event: 'status', data: { msg: `turn failed: ${(err as Error).message}` } });
    }
    await publish(session, {
      event: 'agent',
      data: {
        phase: 'end',
        ...(lastUsage ? { usage: lastUsage } : {}),
        contextWindow: resolvedModel.model.contextWindow,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
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

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  logger.info({ msg: 'server.start', port: info.port });
});

// Best-effort cleanup on signal — keeps embedding processes from lingering
// and SQLite handles closed cleanly. tsx watch tends to send SIGTERM on reload.
async function shutdown(signal: string): Promise<void> {
  logger.info({ msg: 'server.shutdown', signal });
  await shutdownMemoryRegistry();
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
