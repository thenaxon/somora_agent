// `somora acp` against a stand-in somora server: the ACP SDK plays the
// editor, the server speaks the routes the agent uses (/agents, sessions,
// /chat/send, /chat/stream, /chat/abort, /chat/history, the question
// answer). Covers a turn, a turn of another client in between, tools,
// a question, cancel, load and the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentSideConnection, ClientSideConnection, ndJsonStream, type SessionUpdate } from '@agentclientprotocol/sdk';
import { SomoraAcpAgent, type HttpFetch } from './somora-agent.ts';

type Frame = { event: string; data: Record<string, unknown> };

/** A somora stand-in. `script(text, turnId)` gives the frames a turn sends. */
function fakeSomora(script: (text: string, turnId: string, s: Fake) => Promise<void> | void) {
  const subs = new Set<http.ServerResponse>();
  const answers: Array<{ id: string; answers: string[] }> = [];
  const sent: Array<Record<string, unknown>> = [];
  let aborts = 0;
  let n = 0;
  const sessions = [{ id: 'main', slug: 'main', lastActivity: '2026-10-16T10:00:00Z' }];
  const fake = {
    emit(f: Frame) {
      for (const r of subs) r.write(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);
    },
    answers,
    sent,
    get aborts() {
      return aborts;
    },
    onAbort: () => {},
    sessions,
  };
  type Fake = typeof fake;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (url.pathname === '/agents') return json(200, [{ name: 'ada', kind: 'builder' }, { name: 'claw', kind: 'external' }]);
      if (url.pathname === '/agents/ada/sessions' && req.method === 'GET') return json(200, sessions);
      if (url.pathname === '/agents/ada/sessions' && req.method === 'POST') {
        const slug = JSON.parse(body).slug as string;
        const row = { id: `id-${slug}`, slug, lastActivity: null as unknown as string };
        sessions.push(row);
        return json(201, { id: row.id, slug });
      }
      if (url.pathname === '/chat/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: status\ndata: {"msg":"connected"}\n\n`);
        subs.add(res);
        // The response, not the request: a request's 'close' fires once
        // its (empty) body is read.
        res.on('close', () => subs.delete(res));
        return;
      }
      if (url.pathname === '/chat/send') {
        const b = JSON.parse(body) as { text: string };
        sent.push(b);
        const turnId = `turn-${++n}-xxxxxxxx`;
        json(202, { ok: true, turnId });
        setTimeout(() => void script(b.text, turnId, fake), 5);
        return;
      }
      if (url.pathname === '/chat/abort') {
        aborts++;
        fake.onAbort();
        return json(200, { ok: true });
      }
      if (url.pathname === '/chat/history') {
        return json(200, {
          events: [
            { kind: 'user_message', ts: 1, engine: 'x', text: 'earlier' },
            { kind: 'assistant_message', ts: 2, engine: 'x', text: 'earlier answer' },
          ],
        });
      }
      const m = url.pathname.match(/^\/agents\/ada\/sessions\/[^/]+\/questions\/([^/]+)\/answer$/);
      if (m) {
        answers.push({ id: m[1]!, answers: JSON.parse(body).answers });
        return json(200, { ok: true });
      }
      json(404, { error: 'not found' });
    });
  });
  return { server, fake };
}

/** Editor ⇄ `somora acp` over in-memory pipes. */
async function connect(base: string, opts: { onPermission?: (r: any) => any; session?: string } = {}) {
  const a = new TransformStream<Uint8Array, Uint8Array>();
  const b = new TransformStream<Uint8Array, Uint8Array>();
  const updates: SessionUpdate[] = [];
  const permissions: any[] = [];
  new AgentSideConnection(
    (c) => new SomoraAcpAgent(c, { base, agent: 'ada', version: 'test', fetch: fetch as unknown as HttpFetch, ...(opts.session ? { session: opts.session } : {}) }),
    ndJsonStream(a.writable, b.readable),
  );
  const client = new ClientSideConnection(
    () =>
      ({
        async sessionUpdate(n: { update: SessionUpdate }) {
          updates.push(n.update);
        },
        async requestPermission(r: any) {
          permissions.push(r);
          return opts.onPermission ? opts.onPermission(r) : { outcome: { outcome: 'cancelled' } };
        },
      }) as any,
    ndJsonStream(b.writable, a.readable),
  );
  return { client, updates, permissions };
}

async function withServer(script: Parameters<typeof fakeSomora>[0], fn: (base: string, fake: ReturnType<typeof fakeSomora>['fake']) => Promise<void>) {
  const { server, fake } = fakeSomora(script);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, fake);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const textOf = (us: SessionUpdate[]) =>
  us.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => (u as { content: { text: string } }).content.text).join('');

test('a turn: only our turn counts, text arrives in pieces, tools pair up, the fill is reported', async () => {
  await withServer(
    (text, turnId, s) => {
      // Another client's turn finishing first must not end ours.
      s.emit({ event: 'user_message', data: { text: 'other', turnId: 'someone-else' } });
      s.emit({ event: 'chat', data: { state: 'final', text: 'not yours' } });
      s.emit({ event: 'agent', data: { phase: 'end' } });
      s.emit({ event: 'user_message', data: { text, turnId } });
      s.emit({ event: 'agent', data: { phase: 'start' } });
      s.emit({ event: 'tool', data: { phase: 'call', tool: 'exec', summary: 'ls' } });
      s.emit({ event: 'tool', data: { phase: 'result', tool: 'exec', summary: 'a b' } });
      s.emit({ event: 'chat', data: { state: 'delta', text: 'Hel' } });
      s.emit({ event: 'chat', data: { state: 'delta', text: 'Hello' } });
      s.emit({ event: 'chat', data: { state: 'final', text: 'Hello' } });
      s.emit({ event: 'agent', data: { phase: 'end', usage: { tokens_in: 1, tokens_out: 1, context_tokens: 900 }, contextWindow: 8000 } });
    },
    async (base, fake) => {
      const { client, updates } = await connect(base);
      const init = await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      assert.equal(init.agentInfo?.name, 'somora');
      assert.equal(init.agentCapabilities?.loadSession, true);
      const { sessionId } = await client.newSession({ cwd: '/w', mcpServers: [] });
      assert.match(sessionId, /^id-acp-\d{8}-\d{6}$/);
      const r = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }, { type: 'resource_link', uri: 'file:///w/a.ts', name: 'a.ts' }] });
      assert.equal(r.stopReason, 'end_turn');
      assert.equal(textOf(updates), 'Hello');
      assert.deepEqual(
        updates.filter((u) => u.sessionUpdate.startsWith('tool')).map((u) => u.sessionUpdate + ':' + (u as { status?: string }).status),
        ['tool_call:in_progress', 'tool_call_update:completed'],
      );
      assert.deepEqual(updates.find((u) => u.sessionUpdate === 'usage_update'), { sessionUpdate: 'usage_update', used: 900, size: 8000 });
      assert.equal(fake.sent[0]!.text, 'hi\n[a.ts](file:///w/a.ts)');
    },
  );
});

test('a question goes to the editor; its choice comes back as the answer, a cancelled dialog sends none', async () => {
  let round = 0;
  await withServer(
    (text, turnId, s) => {
      round++;
      s.emit({ event: 'user_message', data: { text, turnId } });
      s.emit({ event: 'tool', data: { phase: 'call', tool: 'ask_user', summary: 'colour?' } });
      s.emit({ event: 'question_asked', data: { questionId: `q${round}`, question: 'Which colour?', options: [{ label: 'Green' }, { label: 'No thanks' }], multiple: false, expiresAt: Date.now() + 60_000 } });
      setTimeout(() => s.emit({ event: 'agent', data: { phase: 'end' } }), 50);
    },
    async (base, fake) => {
      let choose: string | null = 'Green';
      const { client, permissions } = await connect(base, {
        onPermission: () => (choose ? { outcome: { outcome: 'selected', optionId: choose } } : { outcome: { outcome: 'cancelled' } }),
      });
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: '/w', mcpServers: [] });
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
      assert.equal(permissions[0].toolCall.title, 'Which colour?');
      assert.equal(permissions[0].toolCall.toolCallId, permissions[0].toolCall.toolCallId.replace(/[^-\w]/g, ''));
      assert.deepEqual(permissions[0].options.map((o: any) => [o.optionId, o.kind]), [['Green', 'allow_once'], ['No thanks', 'reject_once']]);
      assert.deepEqual(fake.answers, [{ id: 'q1', answers: ['Green'] }]);
      choose = null;
      await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] });
      assert.equal(permissions.length, 2);
      assert.equal(fake.answers.length, 1, 'a cancelled dialog answers nothing');
    },
  );
});

test('cancel stops the turn on the server and ends the prompt as cancelled', async () => {
  await withServer(
    (text, turnId, s) => {
      s.emit({ event: 'user_message', data: { text, turnId } });
      s.emit({ event: 'chat', data: { state: 'delta', text: 'partial text' } });
      s.onAbort = () => {
        s.emit({ event: 'chat', data: { state: 'final', text: 'partial [somora] aborted by user' } });
        s.emit({ event: 'agent', data: { phase: 'end' } });
      };
    },
    async (base, fake) => {
      const { client, updates } = await connect(base);
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: '/w', mcpServers: [] });
      const p = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'long' }] });
      await new Promise((r) => setTimeout(r, 100));
      await client.cancel({ sessionId });
      const r = await p;
      assert.equal(r.stopReason, 'cancelled');
      assert.equal(fake.aborts, 1);
      assert.equal(textOf(updates), 'partial text\n[somora] aborted by user');
    },
  );
});

test('load replays the stored conversation; --session opens that session; unknown sessions and external agents are refused', async () => {
  await withServer(
    () => {},
    async (base) => {
      const { client, updates } = await connect(base, { session: 'main' });
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: '/w', mcpServers: [] });
      assert.equal(sessionId, 'main');
      const list = await client.listSessions({ cwd: '/w' });
      assert.deepEqual(list.sessions.map((s) => [s.sessionId, s.title, s.cwd]), [['main', 'main', '/w']]);
      await client.loadSession({ sessionId: 'main', cwd: '/w', mcpServers: [] });
      assert.deepEqual(updates.map((u) => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk']);
      await assert.rejects(client.loadSession({ sessionId: 'nope', cwd: '/w', mcpServers: [] }), /not found/i);
    },
  );
  await withServer(
    () => {},
    async (base) => {
      const a = new TransformStream<Uint8Array, Uint8Array>();
      const b = new TransformStream<Uint8Array, Uint8Array>();
      new AgentSideConnection((c) => new SomoraAcpAgent(c, { base, agent: 'claw', version: 't', fetch: fetch as unknown as HttpFetch }), ndJsonStream(a.writable, b.readable));
      const client = new ClientSideConnection(() => ({}) as any, ndJsonStream(b.writable, a.readable));
      await assert.rejects(client.initialize({ protocolVersion: 1, clientCapabilities: {} }), /external agent/);
    },
  );
});

test('a server that is not there fails initialize with a clear message', async () => {
  const a = new TransformStream<Uint8Array, Uint8Array>();
  const b = new TransformStream<Uint8Array, Uint8Array>();
  new AgentSideConnection((c) => new SomoraAcpAgent(c, { base: 'http://127.0.0.1:1', agent: 'ada', version: 't', fetch: fetch as unknown as HttpFetch }), ndJsonStream(a.writable, b.readable));
  const client = new ClientSideConnection(() => ({}) as any, ndJsonStream(b.writable, a.readable));
  await assert.rejects(client.initialize({ protocolVersion: 1, clientCapabilities: {} }), /not reachable/);
});
