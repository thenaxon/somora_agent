import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { configPath, loadConfig } from '../config/loader.ts';
import { type Config, resolveAnyRef } from '../config/types.ts';
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
  for (const sub of subs) {
    try {
      await sub(event);
    } catch (err) {
      logger.warn({ msg: 'sse.publish_fail', session, err: String(err) });
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

let config;
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
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
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
    await publish(session, { event: 'agent', data: { phase: 'start' } });
    try {
      const history = await getHistory(agent, session);
      const stream = engine.runTurn({
        agent,
        session,
        systemPrompt: persona.systemPrompt,
        userMessage: text,
        history,
        metaStore: sessionMetaStore,
        resolvedModel,
      });
      for await (const ev of stream) {
        // Streaming deltas are transient — only relevant for the live SSE
        // feed. The canonical record is `assistant_message` (final). Persisting
        // every delta would duplicate the same cumulative text dozens of times
        // and bloat the session JSONL for no replay benefit.
        if (ev.kind !== 'assistant_delta') {
          await appendEvent(agent, session, ev);
        }
        const sse = eventToSse(ev);
        if (sse) await publish(session, sse);
      }
    } catch (err) {
      logger.error({ msg: 'turn.fail', agent, session, err: String(err) });
      await publish(session, { event: 'status', data: { msg: `turn failed: ${(err as Error).message}` } });
    }
    await publish(session, { event: 'agent', data: { phase: 'end' } });
  })();

  return c.json({ ok: true }, 202);
});

const port = Number(process.env.SOMORA_PORT ?? config.server.port);

await ensureDefaultAgent();
const agentList = await listAgents();
logger.info({ msg: 'agents.loaded', count: agentList.length, names: agentList.map((a) => a.name).join(',') });

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  logger.info({ msg: 'server.start', port: info.port });
});
