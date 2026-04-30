import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SseEvent } from '../types/events.ts';
import { logger } from './logger.ts';

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

app.get('/agents', (c) =>
  c.json([{ name: 'hans', description: 'Stub agent — placeholder until persona loading (step 2)' }]),
);

app.get('/chat/stream', (c) => {
  const session = c.req.query('session') ?? 'main';
  const agent = c.req.query('agent') ?? 'hans';
  return streamSSE(c, async (stream) => {
    logger.info({ msg: 'sse.connect', agent, session });
    const unsub = subscribe(session, async (event) => {
      await stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) });
    });
    await stream.writeSSE({ event: 'status', data: JSON.stringify({ msg: 'connected' }) });
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
  const session = body.session ?? 'main';
  const text = body.text ?? '';
  logger.info({ msg: 'chat.send', agent, session, len: text.length });

  // Stub turn — emits a fake reply as cumulative deltas. Real engine comes in step 1b.
  void (async () => {
    await publish(session, { event: 'agent', data: { phase: 'start' } });
    const reply = `(stub) Du sagtest: "${text}"`;
    let acc = '';
    for (const chunk of reply.match(/.{1,6}/g) ?? []) {
      acc += chunk;
      await publish(session, { event: 'chat', data: { state: 'delta', text: acc } });
      await new Promise((r) => setTimeout(r, 60));
    }
    await publish(session, { event: 'chat', data: { state: 'final', text: acc } });
    await publish(session, { event: 'agent', data: { phase: 'end' } });
  })();

  return c.json({ ok: true }, 202);
});

const port = Number(process.env.SOMORA_PORT ?? 18737);
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  logger.info({ msg: 'server.start', port: info.port });
});
