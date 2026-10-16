// A stand-in A2A peer for tests: an HTTP server with an Agent Card and a
// JSON-RPC endpoint whose behaviour each test sets — streaming or not,
// v1.0 or 0.3 method names, how long a task takes, how it ends, whether
// cancel works. Records every request so tests can check what was sent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTask {
  id: string;
  contextId: string;
  text: string;
  state: string;
  answer: string;
  /** Status message (question, failure reason). */
  said?: string;
  doneAt: number;
}

export interface FakePeerOptions {
  version?: '1.0' | '0.3';
  streaming?: boolean;
  token?: string;
  /** How long a task works before it ends. */
  workMs?: number;
  /** How a task ends, from its text. Default: completed with "echo: <text>". */
  finish?: (text: string, contextId: string, history: string[]) => { state: string; answer?: string; said?: string };
  /** CancelTask: 'ok' cancels, 'unsupported' refuses (-32004). */
  cancel?: 'ok' | 'unsupported';
  /** GetTask fails this many times first (a flaky network). */
  failGets?: number;
  /** Stream text in this many pieces. */
  pieces?: number;
}

export interface FakePeer {
  url: string;
  requests: Array<{ method: string; params: any; auth: string | undefined }>;
  tasks: Map<string, FakeTask>;
  cancelled: string[];
  options: FakePeerOptions;
  close(): Promise<void>;
}

const STATE_03: Record<string, string> = {
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_REJECTED: 'rejected',
  TASK_STATE_INPUT_REQUIRED: 'input-required',
};

export async function startFakePeer(options: FakePeerOptions = {}): Promise<FakePeer> {
  const opts = options;
  const requests: FakePeer['requests'] = [];
  const tasks = new Map<string, FakeTask>();
  const cancelled: string[] = [];
  const histories = new Map<string, string[]>();
  let seq = 0;
  let failGets = opts.failGets ?? 0;
  let base = '';

  const v = () => opts.version ?? '1.0';
  const st = (s: string) => (v() === '0.3' ? STATE_03[s] ?? s : s);
  const textOf = (msg: any): string => (msg?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const parts = (text: string) => (v() === '0.3' ? [{ kind: 'text', text }] : [{ text }]);

  const view = (t: FakeTask): any => {
    const now = Date.now();
    const running = now < t.doneAt && !cancelled.includes(t.id);
    const state = cancelled.includes(t.id) ? 'TASK_STATE_CANCELED' : running ? 'TASK_STATE_WORKING' : t.state;
    const out: any = { id: t.id, contextId: t.contextId, status: { state: st(state) } };
    if (v() === '0.3') out.kind = 'task';
    if (!running && t.said) out.status.message = { role: v() === '0.3' ? 'agent' : 'ROLE_AGENT', parts: parts(t.said) };
    if (!running && state === 'TASK_STATE_COMPLETED' && t.answer) out.artifacts = [{ artifactId: `a-${t.id}`, parts: parts(t.answer) }];
    return out;
  };

  const newTask = (msg: any): FakeTask => {
    const text = textOf(msg);
    const contextId = msg.contextId ?? `ctx-${++seq}`;
    const history = histories.get(contextId) ?? [];
    const f = opts.finish?.(text, contextId, history) ?? { state: 'TASK_STATE_COMPLETED', answer: `echo: ${text}` };
    history.push(text);
    histories.set(contextId, history);
    const t: FakeTask = { id: `task-${++seq}`, contextId, text, state: f.state, answer: f.answer ?? '', ...(f.said ? { said: f.said } : {}), doneAt: Date.now() + (opts.workMs ?? 0) };
    tasks.set(t.id, t);
    return t;
  };

  const names = () =>
    v() === '0.3'
      ? { send: 'message/send', stream: 'message/stream', get: 'tasks/get', cancel: 'tasks/cancel' }
      : { send: 'SendMessage', stream: 'SendStreamingMessage', get: 'GetTask', cancel: 'CancelTask' };

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      const card: any =
        v() === '0.3'
          ? { name: 'fake', url: `${base}/rpc`, protocolVersion: '0.3.0', capabilities: { streaming: !!opts.streaming } }
          : { name: 'fake', supportedInterfaces: [{ url: `${base}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }], capabilities: { streaming: !!opts.streaming } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const auth = req.headers.authorization;
    requests.push({ method: body.method, params: body.params, auth });
    if (opts.token && auth !== `Bearer ${opts.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32050, message: 'unauthorized' } }));
      return;
    }
    const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    const fail = (code: number, message: string) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code, message } }));
    const n = names();
    switch (body.method) {
      case n.send: {
        const t = newTask(body.params.message);
        const wait = body.params.configuration?.returnImmediately !== true && body.params.configuration?.blocking !== false;
        if (wait) await new Promise((r) => setTimeout(r, Math.max(0, t.doneAt - Date.now())));
        reply(v() === '0.3' ? view(t) : { task: view(t) });
        return;
      }
      case n.stream: {
        if (!opts.streaming) return fail(-32004, 'streaming not supported');
        const t = newTask(body.params.message);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (result: unknown) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
        const wrap = (member: string, value: any) => (v() === '0.3' ? { ...value, kind: member === 'statusUpdate' ? 'status-update' : member === 'artifactUpdate' ? 'artifact-update' : 'task' } : { [member]: value });
        send(wrap('task', { id: t.id, contextId: t.contextId, status: { state: st('TASK_STATE_SUBMITTED') } }));
        send(wrap('statusUpdate', { taskId: t.id, contextId: t.contextId, status: { state: st('TASK_STATE_WORKING') } }));
        const k = Math.max(1, opts.pieces ?? 1);
        const step = Math.ceil(t.answer.length / k) || 1;
        for (let i = 0; i < k; i++) {
          await new Promise((r) => setTimeout(r, (opts.workMs ?? 0) / k));
          if (cancelled.includes(t.id) || res.destroyed) break;
          const piece = t.answer.slice(i * step, (i + 1) * step);
          if (t.state === 'TASK_STATE_COMPLETED' && piece) send(wrap('artifactUpdate', { taskId: t.id, contextId: t.contextId, artifact: { artifactId: `a-${t.id}`, parts: parts(piece) }, append: i > 0 }));
        }
        const end = cancelled.includes(t.id) ? 'TASK_STATE_CANCELED' : t.state;
        send(wrap('statusUpdate', { taskId: t.id, contextId: t.contextId, status: { state: st(end), ...(t.said ? { message: { role: 'ROLE_AGENT', parts: parts(t.said) } } : {}) } }));
        res.end();
        return;
      }
      case n.get: {
        if (failGets > 0) {
          failGets--;
          res.writeHead(502).end('bad gateway');
          return;
        }
        const t = tasks.get(body.params.id);
        if (!t) return fail(-32001, 'task not found');
        reply(v() === '0.3' ? view(t) : { ...view(t) });
        return;
      }
      case n.cancel: {
        if ((opts.cancel ?? 'ok') === 'unsupported') return fail(-32004, 'Unsupported operation');
        cancelled.push(body.params.id);
        reply({ id: body.params.id, status: { state: st('TASK_STATE_CANCELED') } });
        return;
      }
      default:
        fail(-32601, `method not found: ${body.method}`);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    requests,
    tasks,
    cancelled,
    options: opts,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
