// agent_ask back to the session whose question this turn answers is
// refused, whether or not the asker still waits (2026-11-13 report: with
// wait:false it went through and the asker got the result twice). Another
// session of the same agent is another conversation and stays open.
import '../../testing/own-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '../../config/types.ts';
import { setConfig } from '../../server/server-state.ts';
import { agentAsk } from './ask.ts';

const home = process.env.SOMORA_HOME!;
for (const a of ['ada', 'zed']) {
  mkdirSync(join(home, 'agents', a), { recursive: true });
  writeFileSync(join(home, 'agents', a, 'AGENTS.md'), `# ${a}\n`);
  writeFileSync(join(home, 'agents', a, 'agent.yaml'), 'model: x\n');
}
writeFileSync(join(home, 'config.yaml'), 'providers: {}\n');
const config = ConfigSchema.parse({ providers: {} });
setConfig(config);

let origin: { agent: string; session: string; kind: 'a2a' | 'subagent' } | null = null;
const sent: Array<{ session: string }> = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url?.startsWith('/a2a/turn-origin/')) { res.end(JSON.stringify({ origin })); return; }
  if (req.url?.startsWith('/chat/send-sync')) {
    sent.push({ session: JSON.parse(raw).session });
    res.end(JSON.stringify({ finalText: 'ok', outcome: 'completed' }));
    return;
  }
  res.end('{}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.SOMORA_HOST = '127.0.0.1';
process.env.SOMORA_PORT = String((server.address() as AddressInfo).port);
after(() => server.close());

const ctx = { agent: 'ada', session: 'main', config } as Parameters<typeof agentAsk.handler>[1];
const ask = (input: Record<string, unknown>) => agentAsk.handler({ agent: 'zed', message: 'Research done: …', ...input } as never, ctx);

test('answering zed/main: agent_ask to zed/main is refused, sent nowhere', async () => {
  origin = { agent: 'zed', session: 'main', kind: 'a2a' };
  sent.length = 0;
  await assert.rejects(ask({}), /answering a question from zed \(session 'main'\).*into your reply/s);
  await assert.rejects(ask({ session: 'main' }), /answering a question from zed/);
  await assert.rejects(ask({ wait: false }), /answering a question from zed/);
  assert.equal(sent.length, 0);
});

test('a session named by slug counts as the same session as its id', async () => {
  origin = { agent: 'zed', session: '20261113-101500_film-x', kind: 'a2a' };
  await assert.rejects(ask({ session: 'film-x' }), /answering a question from zed/);
});

test('another session of the asker is another conversation: allowed', async () => {
  origin = { agent: 'zed', session: 'main', kind: 'a2a' };
  sent.length = 0;
  const r = (await ask({ session: 'film-x' })) as unknown as Record<string, unknown>;
  assert.equal(r.state, 'done');
  assert.deepEqual(sent, [{ session: 'film-x' }]);
});

test('asking a third agent, or with no asker, is unaffected', async () => {
  origin = { agent: 'kim', session: 'main', kind: 'a2a' };
  sent.length = 0;
  await ask({});
  origin = null;
  await ask({});
  assert.equal(sent.length, 2);
});

test('a sub-agent asking its parent keeps the reply-back routing', async () => {
  origin = { agent: 'zed', session: '20261113-101500_film-x', kind: 'subagent' };
  sent.length = 0;
  await ask({});
  assert.deepEqual(sent, [{ session: '20261113-101500_film-x' }]);
});
