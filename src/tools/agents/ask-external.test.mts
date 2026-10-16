// agent_ask and spawn_subagent with an external agent (docs/a2a.md):
//   - with A2A access, agent_ask goes to the agent's own conversation with
//     the asker (`a2a-<asker>`), created on first use, and says so in
//     routing_reason; a named session still wins;
//   - without A2A access, or with a model or images, it is refused before
//     anything is sent;
//   - spawn_subagent takes an external agent as persona when it has A2A
//     access and refuses model, maxRounds and images for it.
import '../../testing/own-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '../../config/types.ts';
import { setConfig } from '../../server/server-state.ts';
import { agentAsk, describeRouting } from './ask.ts';
import { spawnSubagent } from './spawn.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
const yaml = `providers: {}
external:
  systems:
    loc:
      transport: { local: true }
      agents:
        claw:
          command: "false"
          a2a: { url: "http://127.0.0.1:9", token: t }
        chatonly:
          command: "false"
`;
writeFileSync(join(home, 'config.yaml'), yaml);
const config = ConfigSchema.parse({
  providers: {},
  external: { systems: { loc: { transport: { local: true }, agents: { claw: { command: 'false', a2a: { url: 'http://127.0.0.1:9', token: 't' } }, chatonly: { command: 'false' } } } } },
});
setConfig(config);

// Stand-in for somora's own server: records what the tools send.
const seen: Array<{ url: string; body: any }> = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  seen.push({ url: req.url ?? '', body });
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url?.startsWith('/chat/send-sync')) res.end(JSON.stringify({ finalText: 'answer from claw', outcome: 'completed' }));
  else if (req.url?.startsWith('/spawn-async')) res.end(JSON.stringify({ task_id: 'task_x', session: body.session }));
  else res.end('{}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.SOMORA_HOST = '127.0.0.1';
process.env.SOMORA_PORT = String((server.address() as AddressInfo).port);
after(() => server.close());

const ctx = { agent: 'ada', session: 'main', config } as Parameters<typeof agentAsk.handler>[1];

test('routing reason for an external agent\'s own conversation', () => {
  assert.deepEqual(describeRouting({ targetAgent: 'claw', explicit: false, inferred: false, callerSession: 'proj', external: true }), { routing_reason: 'external_conversation' });
  assert.equal(describeRouting({ targetAgent: 'claw', explicit: true, inferred: false, callerSession: 'proj', external: true }).routing_reason, 'explicit');
});

test('agent_ask to an external agent with A2A access: its conversation with the asker', async () => {
  seen.length = 0;
  const r = (await agentAsk.handler({ agent: 'claw', message: 'Please summarise X.' } as never, ctx)) as unknown as Record<string, unknown>;
  assert.equal(r.state, 'done');
  assert.equal(r.response, 'answer from claw');
  assert.equal(r.target_session, 'a2a-ada');
  assert.equal(r.routing_reason, 'external_conversation');
  const send = seen.find((s) => s.url.startsWith('/chat/send-sync'))!;
  assert.equal(send.body.session, 'a2a-ada');
  assert.equal(send.body.create_session, true);
  assert.equal(send.body.from_agent, 'ada');
  assert.ok(!seen.some((s) => s.url.startsWith('/a2a/turn-origin')), 'no reply-back lookup for an external target');

  seen.length = 0;
  const named = (await agentAsk.handler({ agent: 'claw', message: 'x', session: 'research' } as never, ctx)) as unknown as Record<string, unknown>;
  assert.equal(named.target_session, 'research');
  assert.equal(seen.find((s) => s.url.startsWith('/chat/send-sync'))!.body.create_session, undefined, 'a named session is not created on its own');
});

test('agent_ask refusals: no A2A access, a model, images — nothing is sent', async () => {
  seen.length = 0;
  await assert.rejects(agentAsk.handler({ agent: 'chatonly', message: 'x' } as never, ctx), /external agent \(loc\) without A2A access/);
  await assert.rejects(agentAsk.handler({ agent: 'claw', message: 'x', session: 's', create_session: true, model: 'gpt' } as never, ctx), /its model is set on its own system/);
  await assert.rejects(agentAsk.handler({ agent: 'claw', message: 'x', images: ['/tmp/a.png'] } as never, ctx), /images cannot be handed to an external agent/);
  assert.equal(seen.length, 0);
});

test('spawn_subagent: an external agent with A2A access is a valid persona; model, maxRounds, images are refused', async () => {
  await assert.rejects(spawnSubagent.handler({ persona: 'chatonly', task: 'x' } as never, ctx), /without A2A access/);
  await assert.rejects(spawnSubagent.handler({ persona: 'claw', task: 'x', model: 'gpt' } as never, ctx), /its model is set on its own system/);
  await assert.rejects(spawnSubagent.handler({ persona: 'claw', task: 'x', maxRounds: 20 } as never, ctx), /runs its own loop/);
  await assert.rejects(spawnSubagent.handler({ persona: 'claw', task: 'x', images: ['/tmp/a.png'] } as never, ctx), /images cannot be handed/);
  await assert.rejects(spawnSubagent.handler({ persona: 'nobody', task: 'x' } as never, ctx), /persona 'nobody' not found/);
  seen.length = 0;
  const r = (await spawnSubagent.handler({ persona: 'claw', task: 'look into X' } as never, ctx)) as unknown as Record<string, unknown>;
  assert.equal(r.ok ?? true, true, JSON.stringify(r));
  const spawn = seen.find((s) => s.url.startsWith('/spawn-async'));
  assert.ok(spawn, `spawned through the server: ${JSON.stringify(seen.map((s) => s.url))}`);
  assert.equal(spawn!.body.agent, 'claw');
  assert.match(spawn!.body.session, /^\d{8}-\d{6}_sub-ada-/);
});
