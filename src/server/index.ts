import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { anthropicEngine } from '../engine/anthropic.ts';
import { ensureDefaultAgent, listAgents, loadPersona } from '../persona/loader.ts';
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

  logger.info({ msg: 'chat.send', agent, session, ref: sessionRef, len: text.length });

  await appendEvent(agent, session, {
    kind: 'user_message',
    ts: Date.now(),
    engine: anthropicEngine.name,
    text,
  });

  void (async () => {
    await publish(session, { event: 'agent', data: { phase: 'start' } });
    try {
      const history = await getHistory(agent, session);
      const stream = anthropicEngine.runTurn({
        agent,
        session,
        systemPrompt: persona.systemPrompt,
        userMessage: text,
        history,
        metaStore: sessionMetaStore,
      });
      for await (const ev of stream) {
        await appendEvent(agent, session, ev);
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

const port = Number(process.env.SOMORA_PORT ?? 18737);

await ensureDefaultAgent();
const agentList = await listAgents();
logger.info({ msg: 'agents.loaded', count: agentList.length, names: agentList.map((a) => a.name).join(',') });

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  logger.info({ msg: 'server.start', port: info.port });
});
