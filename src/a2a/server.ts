// somora as an A2A agent (docs/a2a.md): other agent systems send tasks to
// somora's agents over the Agent2Agent protocol.
//
//   GET  /a2a/agents/<agent>/.well-known/agent-card.json   the agent's card (open)
//   POST /a2a/agents/<agent>                                JSON-RPC (peer token)
//   GET  /.well-known/agent-card.json                       the default agent's card
//
// Who may send: the peers in config.yaml `a2a.peers`, each with its own
// token. Who can be reached: agents with `a2a: true` in agent.yaml (never
// a builder). A task becomes a normal turn of the agent (startTurn) in a
// session of its own per peer and conversation (`a2a-<peer>-<hash>`); the
// answer streams back to the peer, a question the agent asks (ask_user)
// goes back as input-required, and a stop really stops the turn.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { loadPersona, type Persona as PersonaInfo } from '../persona/loader.ts';
import { config } from '../server/server-state.ts';
import { logger } from '../server/logger.ts';
import { startTurn, STOPPED_BY_USER } from '../server/start-turn.ts';
import { triggerChatAbort } from '../server/chat-aborts.ts';
import { openWork } from '../server/work-ledger.ts';
import { answerQuestion, pendingQuestion, watchQuestions } from '../server/builder-questions.ts';
import { createSession, resolveSessionId, sessionMetaStore } from '../storage/sessions.ts';
import { A2A_PEER_KEY, A2A_QUIET_KEY } from '../tools/gating.ts';
import { getResolvedTeam } from '../team/store.ts';
import { streamSSEH2Safe } from '../server/sse-h2-safe.ts';
import { remoteOf } from '../server/sse-liveness.ts';
import { SOMORA_VERSION } from '../version.ts';
import type { SseEvent } from '../types/events.ts';
import type { TurnOrigin } from '../types/turn-origin.ts';
import { takeDailyCall } from './limits.ts';
import { type A2AMessage, type A2APart, type ProtocolVersion, type TaskState, PAUSED_STATES, TERMINAL_STATES, partsText } from './protocol.ts';

export interface InboundTask {
  id: string;
  peer: string;
  agent: string;
  session: string;
  contextId: string;
  messageIds: Set<string>;
  state: TaskState;
  /** The answer so far (streamed) and at the end. */
  answer: string;
  /** Status message: the question (input_required), the reason (failed). */
  said: string;
  createdAt: number;
  updatedAt: number;
  /** The lock wait can be stopped before the turn runs. */
  lockAbort: AbortController;
  running: boolean;
  listeners: Set<(t: InboundTask, change: TaskChange) => void>;
}

type TaskChange = { kind: 'state' } | { kind: 'text'; piece: string; replace: boolean } | { kind: 'note'; text: string };

const tasks = new Map<string, InboundTask>();
const MAX_TASKS = 500;
const KEEP_MS = 24 * 60 * 60 * 1000;

function prune(): void {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if ((TERMINAL_STATES.has(t.state) && now - t.updatedAt > KEEP_MS) || tasks.size > MAX_TASKS) {
      if (!t.running) tasks.delete(id);
    }
  }
}

/** For tests. */
export function resetInboundTasks(): void {
  tasks.clear();
  rate.clear();
}

// ── peers, tokens, rate ────────────────────────────────────────────────

function peerForToken(token: string): string | null {
  const given = Buffer.from(token);
  for (const [name, p] of Object.entries(config.a2a.peers)) {
    const want = Buffer.from(p.token);
    if (want.length === given.length && timingSafeEqual(want, given)) return name;
  }
  return null;
}

const rate = new Map<string, number[]>();
function rateLimited(peer: string): boolean {
  const now = Date.now();
  const hits = (rate.get(peer) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= config.a2a.rateLimitPerMinute) {
    rate.set(peer, hits);
    return true;
  }
  hits.push(now);
  rate.set(peer, hits);
  return false;
}

const misses = new Map<string, number[]>();
function missBlocked(ip: string): boolean {
  const now = Date.now();
  return (misses.get(ip) ?? []).filter((t) => now - t < 60_000).length >= 10;
}
function miss(ip: string): void {
  const now = Date.now();
  misses.set(ip, [...(misses.get(ip) ?? []).filter((t) => now - t < 60_000), now]);
}

/** An agent this peer may send tasks to — or why not. */
async function reachable(agent: string, peer: string | null): Promise<{ persona: PersonaInfo } | { error: string }> {
  const persona = await loadPersona(agent);
  if (!persona || !persona.a2a || persona.kind === 'builder') return { error: `no A2A agent '${agent}' here` };
  if (peer) {
    const allowed = config.a2a.peers[peer]?.agents;
    if (allowed && !allowed.includes(agent)) return { error: `no A2A agent '${agent}' here` };
  }
  return { persona };
}

// ── the card ───────────────────────────────────────────────────────────

function baseUrl(c: Context): string {
  if (config.a2a.publicUrl) return config.a2a.publicUrl.replace(/\/+$/, '');
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
  return `${proto}://${host}`;
}

export function agentCard(persona: PersonaInfo, base: string): Record<string, unknown> {
  const url = `${base}/a2a/agents/${encodeURIComponent(persona.name)}`;
  const description = persona.description || `${persona.name}, an agent on somora`;
  return {
    name: persona.name,
    description,
    version: SOMORA_VERSION,
    provider: { organization: 'somora', url: 'https://somora.ai' },
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    // 0.3 readers look here.
    url,
    protocolVersion: '1.0',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: persona.name, name: persona.name, description, tags: ['somora'] }],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } } },
    security: [{ bearer: [] }],
  };
}

// ── wire shapes per version ────────────────────────────────────────────

const V1_STATE: Record<TaskState, string> = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  input_required: 'TASK_STATE_INPUT_REQUIRED',
  auth_required: 'TASK_STATE_AUTH_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
  unknown: 'TASK_STATE_UNSPECIFIED',
};
const wireState = (v: ProtocolVersion, s: TaskState) => (v === '0.3' ? s.replace('_', '-') : V1_STATE[s]);
const textPart = (v: ProtocolVersion, text: string) => (v === '0.3' ? { kind: 'text', text } : { text });

function agentMessage(v: ProtocolVersion, t: InboundTask, text: string): Record<string, unknown> {
  return {
    ...(v === '0.3' ? { kind: 'message' } : {}),
    messageId: `${t.id}-${t.updatedAt}`,
    role: v === '0.3' ? 'agent' : 'ROLE_AGENT',
    parts: [textPart(v, text)],
    contextId: t.contextId,
    taskId: t.id,
  };
}

function statusOf(v: ProtocolVersion, t: InboundTask): Record<string, unknown> {
  return {
    state: wireState(v, t.state),
    timestamp: new Date(t.updatedAt).toISOString(),
    ...(t.said ? { message: agentMessage(v, t, t.said) } : {}),
  };
}

function taskView(v: ProtocolVersion, t: InboundTask): Record<string, unknown> {
  return {
    ...(v === '0.3' ? { kind: 'task' } : {}),
    id: t.id,
    contextId: t.contextId,
    status: statusOf(v, t),
    ...(t.state === 'completed' && t.answer ? { artifacts: [{ artifactId: `${t.id}-answer`, name: 'answer', parts: [textPart(v, t.answer)] }] } : {}),
  };
}

// ── JSON-RPC plumbing ──────────────────────────────────────────────────

const METHOD: Record<string, { op: 'send' | 'stream' | 'get' | 'cancel' | 'list' | 'subscribe'; v: ProtocolVersion }> = {
  SendMessage: { op: 'send', v: '1.0' },
  SendStreamingMessage: { op: 'stream', v: '1.0' },
  GetTask: { op: 'get', v: '1.0' },
  CancelTask: { op: 'cancel', v: '1.0' },
  ListTasks: { op: 'list', v: '1.0' },
  SubscribeToTask: { op: 'subscribe', v: '1.0' },
  'message/send': { op: 'send', v: '0.3' },
  'message/stream': { op: 'stream', v: '0.3' },
  'tasks/get': { op: 'get', v: '0.3' },
  'tasks/cancel': { op: 'cancel', v: '0.3' },
  'tasks/list': { op: 'list', v: '0.3' },
  'tasks/resubscribe': { op: 'subscribe', v: '0.3' },
};

type RpcId = string | number | null;
const rpcResult = (id: RpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: RpcId, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

// ── running a task ─────────────────────────────────────────────────────

function sessionSlug(peer: string, contextId: string): string {
  return `a2a-${peer}-${createHash('sha256').update(contextId).digest('hex').slice(0, 10)}`;
}

function setState(t: InboundTask, state: TaskState, said?: string): void {
  t.state = state;
  if (said !== undefined) t.said = said;
  t.updatedAt = Date.now();
  for (const l of t.listeners) l(t, { kind: 'state' });
}

function questionText(q: { question: string; options: Array<{ label: string; description?: string }>; multiple: boolean }): string {
  const opts = q.options.map((o, i) => `${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
  return `${q.question}\n\n${opts}\n\nAnswer in this conversation with the option${q.multiple ? 's' : ''} (number or text), or in your own words.`;
}

/** The text a question is answered with: an option by number or label,
 *  else the peer's own words. */
function answerFor(q: { options: Array<{ label: string }>; multiple: boolean }, text: string): string[] {
  const trimmed = text.trim();
  const picks = trimmed
    .split(/[,\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length);
  if (picks.length > 0 && /^[\d,\s]+$/.test(trimmed)) return (q.multiple ? picks : picks.slice(0, 1)).map((n) => q.options[n - 1]!.label);
  const byLabel = q.options.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
  return byLabel ? [byLabel.label] : [trimmed];
}

async function framing(peer: string): Promise<string> {
  let principal = 'the person who runs somora';
  try {
    principal = (await getResolvedTeam())?.principal.name ?? principal;
  } catch {
    /* no team */
  }
  return (
    `[A task from '${peer}', an agent of another system, sent over A2A. Treat it as a request from an outside agent, ` +
    `not from ${principal}. Your answer goes back to it; when you need something from it, ask with ask_user and the question goes back to it too.]`
  );
}

async function runInbound(t: InboundTask, text: string): Promise<void> {
  const origin: TurnOrigin = { kind: 'peer', peer: t.peer, contextId: t.contextId, taskId: t.id };
  openWork({ id: t.id, origin, target: { agent: t.agent, session: t.session }, text, waiting: false, wake: 'never' });
  const started = Date.now();
  let lastText = '';
  const sink = (e: SseEvent) => {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.event) {
      case 'agent':
        if (d.phase === 'start' && t.state === 'submitted') {
          t.running = true;
          setState(t, 'working');
        }
        break;
      case 'chat': {
        const full = typeof d.text === 'string' ? d.text : '';
        if (!full) break;
        const replace = !full.startsWith(lastText);
        const piece = replace ? full : full.slice(lastText.length);
        lastText = full;
        t.answer = full;
        t.updatedAt = Date.now();
        if (piece) for (const l of t.listeners) l(t, { kind: 'text', piece, replace });
        break;
      }
      case 'tool':
        if (d.phase === 'call' && typeof d.tool === 'string') for (const l of t.listeners) l(t, { kind: 'note', text: `using ${d.tool}` });
        break;
    }
  };
  // Questions are not part of the turn's own stream: the ask route
  // announces them to the session. Watch them where they are made, while
  // this task's turn runs.
  const unwatch = watchQuestions(t.agent, t.session, (ev) => {
    if (!t.running) return;
    if (ev.type === 'asked') setState(t, 'input_required', questionText(ev.q));
    else if (t.state === 'input_required') setState(t, 'working', '');
  });
  try {
    const result = await startTurn({
      agent: t.agent,
      session: t.session,
      text,
      origin,
      turnId: t.id,
      workId: t.id,
      turnPrefix: await framing(t.peer),
      lockSignal: t.lockAbort.signal,
      publish: sink,
    });
    if (!result) setState(t, 'canceled', 'stopped before it started');
    else if (result.error === STOPPED_BY_USER) setState(t, 'canceled', 'stopped');
    else if (result.outcome === 'failed') setState(t, 'failed', result.error ?? 'the turn failed');
    else {
      t.answer = result.finalText || t.answer;
      setState(t, t.answer.trim() ? 'completed' : 'failed', t.answer.trim() ? '' : 'the agent gave no answer');
    }
  } catch (err) {
    setState(t, t.lockAbort.signal.aborted ? 'canceled' : 'failed', t.lockAbort.signal.aborted ? 'stopped before it started' : (err as Error).message);
  } finally {
    unwatch();
    t.running = false;
    logger.info({ msg: 'a2a.inbound', peer: t.peer, agent: t.agent, session: t.session, task: t.id, state: t.state, ms: Date.now() - started, answerLen: t.answer.length });
  }
}

/** Wait until the task ends or pauses, or `ms` pass. */
function settled(t: InboundTask, ms: number, signal?: AbortSignal): Promise<void> {
  if (TERMINAL_STATES.has(t.state) || PAUSED_STATES.has(t.state)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      t.listeners.delete(listener);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const listener = (x: InboundTask, ch: TaskChange) => {
      if (ch.kind === 'state' && (TERMINAL_STATES.has(x.state) || PAUSED_STATES.has(x.state))) done();
    };
    const timer = setTimeout(done, ms);
    t.listeners.add(listener);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface InboundDeps {
  /** One inbox entry per peer and day (docs/a2a.md). */
  notify?: (peer: string, agent: string, countToday: number) => void;
}

/** Accept a message: a new task, the answer to an open question, or a
 *  repeat of a message already taken (same messageId). */
async function accept(
  peer: string,
  agent: string,
  params: { message?: A2AMessage & { parts?: A2APart[] } },
  deps: InboundDeps,
): Promise<{ task: InboundTask } | { error: [number, string] }> {
  const msg = params?.message;
  if (!msg || !Array.isArray(msg.parts)) return { error: [-32602, 'params.message with parts is required'] };
  const text = partsText(msg.parts).trim();
  if (!text) return { error: [-32602, 'the message has no text'] };
  if (text.length > config.a2a.maxMessageChars) return { error: [-32602, `the message is longer than ${config.a2a.maxMessageChars} characters`] };
  const messageId = typeof msg.messageId === 'string' ? msg.messageId : '';
  if (messageId) {
    for (const t of tasks.values()) if (t.peer === peer && t.messageIds.has(messageId)) return { task: t };
  }
  if (typeof msg.taskId === 'string' && msg.taskId) {
    const t = tasks.get(msg.taskId);
    if (!t || t.peer !== peer) return { error: [-32001, `task '${msg.taskId}' not found`] };
    if (t.state !== 'input_required') return { error: [-32004, `task '${msg.taskId}' is ${t.state}; send a new message without taskId to continue the conversation`] };
  }
  const contextId = typeof msg.contextId === 'string' && msg.contextId ? msg.contextId : `ctx-${randomUUID()}`;
  if (contextId.length > 200) return { error: [-32602, 'contextId is longer than 200 characters'] };

  // An open question in this conversation: the message answers it, and
  // the task that asked goes on.
  const waiting = [...tasks.values()].find((t) => t.peer === peer && t.agent === agent && t.contextId === contextId && t.state === 'input_required');
  if (waiting) {
    const q = pendingQuestion(waiting.agent, waiting.session);
    if (q && answerQuestion(waiting.agent, waiting.session, q.id, { answers: answerFor(q, text) })) {
      if (messageId) waiting.messageIds.add(messageId);
      setState(waiting, 'working', '');
      return { task: waiting };
    }
  }

  if (rateLimited(peer)) return { error: [-32051, `rate limit: more than ${config.a2a.rateLimitPerMinute} requests a minute`] };
  const daily = takeDailyCall(config.a2a.maxTasksPerDay, `peer-${peer}`);
  if (!daily.ok) return { error: [-32051, `daily limit reached (${config.a2a.maxTasksPerDay} tasks)`] };

  const slug = sessionSlug(peer, contextId);
  const session = (await resolveSessionId(agent, slug)) ?? (await createSession(agent, slug));
  await sessionMetaStore.update(agent, session, (m) => ({ ...m, [A2A_PEER_KEY]: { peer, contextId }, [A2A_QUIET_KEY]: true }));
  prune();
  const t: InboundTask = {
    id: `task-${randomUUID()}`,
    peer,
    agent,
    session,
    contextId,
    messageIds: new Set(messageId ? [messageId] : []),
    state: 'submitted',
    answer: '',
    said: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lockAbort: new AbortController(),
    running: false,
    listeners: new Set(),
  };
  tasks.set(t.id, t);
  logger.info({ msg: 'a2a.inbound_accepted', peer, agent, session, task: t.id, contextId, chars: text.length, today: daily.count });
  try {
    deps.notify?.(peer, agent, daily.count);
  } catch {
    /* the inbox must not stop a task */
  }
  void runInbound(t, text);
  return { task: t };
}

function cancel(t: InboundTask): boolean {
  if (TERMINAL_STATES.has(t.state)) return false;
  if (t.running) {
    triggerChatAbort(t.agent, t.session);
  } else {
    t.lockAbort.abort();
  }
  return true;
}

// ── the routes ─────────────────────────────────────────────────────────

/** Paths the login key does not guard: the cards, and the JSON-RPC
 *  endpoint, which checks the peer tokens itself. */
export function isA2APublicPath(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/.well-known/agent-card.json' || path === '/.well-known/agent.json')) return true;
  const m = /^\/a2a\/agents\/[^/]+(\/\.well-known\/agent(-card)?\.json)?$/.exec(path);
  if (!m) return false;
  return m[1] ? method === 'GET' : method === 'POST';
}

export function registerA2AInboundRoutes(app: Hono, deps: InboundDeps = {}): void {
  const enabled = () => Object.keys(config.a2a.peers).length > 0;

  const cardRoute = async (c: Context, agent: string | undefined) => {
    if (!enabled() || !agent) return c.json({ error: 'not found' }, 404);
    const r = await reachable(agent, null);
    if ('error' in r) return c.json({ error: r.error }, 404);
    return c.json(agentCard(r.persona, baseUrl(c)));
  };
  app.get('/a2a/agents/:agent/.well-known/agent-card.json', (c) => cardRoute(c, c.req.param('agent')));
  app.get('/a2a/agents/:agent/.well-known/agent.json', (c) => cardRoute(c, c.req.param('agent')));
  app.get('/.well-known/agent-card.json', (c) => cardRoute(c, config.a2a.defaultAgent));
  app.get('/.well-known/agent.json', (c) => cardRoute(c, config.a2a.defaultAgent));

  app.post('/a2a/agents/:agent', async (c) => {
    if (!enabled()) return c.json(rpcError(null, -32601, 'A2A is not enabled here'), 404);
    // The connection's own address, as the login-key gate counts it: a
    // header could be set by anyone and would put every sender in one bucket.
    const ip = remoteOf(c)?.ip ?? 'unknown';
    const auth = c.req.header('authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
    const peer = token ? peerForToken(token) : null;
    // A right token always passes; only wrong ones are slowed down, per
    // address, so a stranger guessing cannot lock out a real peer (behind
    // a proxy every sender shares one address).
    if (!peer) {
      if (missBlocked(ip)) return c.json(rpcError(null, -32050, 'too many wrong tokens — wait a minute'), 429);
      miss(ip);
      logger.warn({ msg: 'a2a.inbound_refused', ip, reason: token ? 'unknown token' : 'no token' });
      return c.json(rpcError(null, -32050, 'unauthorized'), 401);
    }
    const agent = c.req.param('agent');
    let body: { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(rpcError(null, -32700, 'parse error'), 400);
    }
    const id = body?.id ?? null;
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return c.json(rpcError(id, -32600, 'invalid request'));
    const route = METHOD[body.method];
    if (!route) return c.json(rpcError(id, -32601, `method not found: ${body.method}`));
    const r = await reachable(agent, peer);
    if ('error' in r) return c.json(rpcError(id, -32001, r.error), 404);
    const v = route.v;
    const params = body.params ?? {};

    if (route.op === 'get' || route.op === 'cancel' || route.op === 'subscribe') {
      const t = typeof params.id === 'string' ? tasks.get(params.id) : undefined;
      if (!t || t.peer !== peer || t.agent !== agent) return c.json(rpcError(id, -32001, `task '${String(params.id)}' not found`));
      if (route.op === 'get') return c.json(rpcResult(id, taskView(v, t)));
      if (route.op === 'cancel') {
        if (!cancel(t)) return c.json(rpcError(id, -32002, `task is already ${t.state}`));
        await settled(t, 10_000);
        return c.json(rpcResult(id, taskView(v, t)));
      }
      return streamTask(c, v, id, t, false);
    }
    if (route.op === 'list') {
      const ctx = typeof params.contextId === 'string' ? params.contextId : undefined;
      const list = [...tasks.values()].filter((t) => t.peer === peer && t.agent === agent && (!ctx || t.contextId === ctx)).slice(-100);
      return c.json(rpcResult(id, { tasks: list.map((t) => taskView(v, t)) }));
    }

    const accepted = await accept(peer, agent, params as { message?: A2AMessage }, deps);
    if ('error' in accepted) {
      const [code, message] = accepted.error;
      return c.json(rpcError(id, code, message), code === -32051 ? 429 : 200);
    }
    const t = accepted.task;
    if (route.op === 'stream') return streamTask(c, v, id, t, true);
    const conf = (params.configuration ?? {}) as { returnImmediately?: boolean; blocking?: boolean };
    const immediate = conf.returnImmediately === true || conf.blocking === false;
    if (!immediate) await settled(t, config.a2a.replyTimeoutSeconds * 1000, c.req.raw.signal);
    const view = taskView(v, t);
    return c.json(rpcResult(id, v === '0.3' ? view : { task: view }));
  });
}

/** SendStreamingMessage / SubscribeToTask: the task, then its changes,
 *  until it ends or pauses. */
function streamTask(c: Context, v: ProtocolVersion, id: RpcId, t: InboundTask, fresh: boolean): Response {
  return streamSSEH2Safe(c, async (stream) => {
    const send = (result: unknown) => stream.writeSSE({ data: JSON.stringify(rpcResult(id, result)) });
    const wrap = (member: 'statusUpdate' | 'artifactUpdate', value: Record<string, unknown>, final = false) =>
      v === '0.3' ? { ...value, kind: member === 'statusUpdate' ? 'status-update' : 'artifact-update', ...(member === 'statusUpdate' ? { final } : {}) } : { [member]: value };
    const status = (final = false) => wrap('statusUpdate', { taskId: t.id, contextId: t.contextId, status: statusOf(v, t) }, final);
    let artifactStarted = false;
    const queue: Array<() => Promise<void>> = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const push = (fn: () => Promise<void>) => {
      queue.push(fn);
      wake?.();
    };
    const listener = (x: InboundTask, ch: TaskChange) => {
      if (ch.kind === 'text') {
        const append = artifactStarted && !ch.replace;
        artifactStarted = true;
        push(() => send(wrap('artifactUpdate', { taskId: x.id, contextId: x.contextId, artifact: { artifactId: `${x.id}-answer`, name: 'answer', parts: [textPart(v, ch.piece)] }, append, lastChunk: false })));
      } else if (ch.kind === 'note') {
        push(() => send(wrap('statusUpdate', { taskId: x.id, contextId: x.contextId, status: { state: wireState(v, 'working'), timestamp: new Date().toISOString(), message: agentMessage(v, x, ch.text) } })));
      } else {
        const end = TERMINAL_STATES.has(x.state) || PAUSED_STATES.has(x.state);
        if (end && x.state === 'completed' && !artifactStarted && x.answer) {
          artifactStarted = true;
          push(() => send(wrap('artifactUpdate', { taskId: x.id, contextId: x.contextId, artifact: { artifactId: `${x.id}-answer`, name: 'answer', parts: [textPart(v, x.answer)] }, append: false, lastChunk: true })));
        }
        push(() => send(status(end)));
        if (end) finished = true;
      }
    };
    t.listeners.add(listener);
    stream.onAbort(() => {
      finished = true;
      wake?.();
    });
    try {
      await send(v === '0.3' ? taskView(v, t) : { task: taskView(v, t) });
      if (!fresh && (TERMINAL_STATES.has(t.state) || PAUSED_STATES.has(t.state))) return;
      if (fresh && t.state !== 'submitted') await send(status());
      for (;;) {
        while (queue.length > 0) await queue.shift()!();
        if (finished || stream.closed) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      while (queue.length > 0) await queue.shift()!();
    } finally {
      t.listeners.delete(listener);
      stream.close();
    }
  });
}

/** Archive conversations with peers that have been quiet for
 *  `a2a.archiveAfterDays` (docs/a2a.md). REM still reads an archived
 *  session once, like every other. Returns how many were archived. */
export async function archiveIdlePeerSessions(now = Date.now()): Promise<number> {
  const days = config.a2a.archiveAfterDays;
  if (!days || days <= 0) return 0;
  const { listAgents } = await import('../persona/loader.ts');
  const { listSessions, archiveSession } = await import('../storage/sessions.ts');
  let archived = 0;
  for (const a of await listAgents()) {
    for (const s of await listSessions(a.name)) {
      if (s.id === 'main') continue;
      const meta = (await sessionMetaStore.get(a.name, s.id)) as Record<string, unknown>;
      if (!meta[A2A_PEER_KEY]) continue;
      const last = Date.parse(s.lastActivity ?? s.createdAt ?? '');
      if (!Number.isFinite(last) || now - last < days * 24 * 60 * 60 * 1000) continue;
      if ([...tasks.values()].some((t) => t.session === s.id && t.running)) continue;
      try {
        await archiveSession(a.name, s.id, `no A2A activity for ${days} days`);
        archived += 1;
      } catch (err) {
        logger.warn({ msg: 'a2a.archive_failed', agent: a.name, session: s.id, err: (err as Error).message });
      }
    }
  }
  if (archived > 0) logger.info({ msg: 'a2a.archived_idle', archived, days });
  return archived;
}
