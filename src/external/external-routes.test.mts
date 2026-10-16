// External agents in somora's routes (docs/external-agents.md): the agent
// list, the session list, a somora agent of the same name winning, the
// refusals for model / thinking / sampling / compact, the open-question
// routes, a reset that gives the other side a fresh session too
// ({session} carries the generation), and a resource marked
// externalOnly staying out of somora agents' sight.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { ConfigSchema } from '../config/types.ts';
import { setConfig } from '../server/server-state.ts';
import { registerAgentRoutes } from '../server/routes/agents.ts';
import { registerSessionRoutes } from '../server/routes/sessions.ts';
import { registerExternalRoutes } from '../server/routes/external.ts';
import { askQuestion } from '../server/builder-questions.ts';
import { runExternalTurn } from '../engine/acp-external.ts';
import { sessionMetaStore } from '../storage/sessions.ts';
import { closeAllExternal, knownInfo } from './connection.ts';
import { getExternalAgent } from './registry.ts';
import { visibleResourcesForAgent } from '../tools/resources/visibility.ts';
import type { SseEvent } from '../types/events.ts';

const home = process.env.SOMORA_HOME!;
const fake = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-acp-agent.mjs');
// The fake agent introduces itself with FAKE_AGENT_NAME: here the filled
// {session}, so the test sees what the command was started with.
const command = `FAKE_AGENT_NAME=s-{session} ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`;

mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');

const config = ConfigSchema.parse({
  providers: {},
  resources: {
    shared: { type: 'ssh', host: 'h1', user: 'u', keyPath: '~/.ssh/k' },
    lab: { type: 'ssh', host: 'h2', user: 'u', keyPath: '~/.ssh/k', externalOnly: true },
  },
  external: {
    systems: {
      loc: {
        transport: { local: true },
        agents: {
          probe: { command, icon: '🧪' },
          // Taken by the somora agent on disk: ignored.
          ada: { command },
        },
      },
      claws: { transport: { resource: 'lab' }, agents: { pincer: { command: 'openclaw acp --session agent:main:{session}' } } },
    },
  },
});
setConfig(config);

const published: Array<{ agent: string; session: string; ev: SseEvent }> = [];
const publish = (async (agent: string, session: string, ev: SseEvent) => {
  published.push({ agent, session, ev });
}) as never;
const app = new Hono();
registerAgentRoutes(app, { nextTurnPrompt: undefined as never, syncDreamers: async () => {} });
registerSessionRoutes(app, { nextTurnPrompt: undefined as never, publish, resolveEffectiveModel: undefined as never, streamKey: ((a: string, s: string) => `${a}::${s}`) as never, streams: new Map() as never });
registerExternalRoutes(app, { publish });

after(() => closeAllExternal());

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

test('/agents: external agents with their system and sign; a somora agent of the same name stays itself', async () => {
  const { body } = await call('GET', '/agents');
  const probe = body.find((a: any) => a.name === 'probe');
  assert.equal(probe.kind, 'external');
  assert.equal(probe.external.system, 'loc');
  const pincer = body.find((a: any) => a.name === 'pincer');
  assert.equal(pincer.external.badge, '🦞', 'the sign guessed from the command before any connection');
  assert.equal(pincer.external.label, 'OpenClaw');
  const adas = body.filter((a: any) => a.name === 'ada');
  assert.equal(adas.length, 1);
  assert.notEqual(adas[0].kind, 'external');
  assert.equal(getExternalAgent('ada'), null);
});

test('model, thinking, sampling: a stub to read, 409 to change; compact refused', async () => {
  const m = await call('GET', '/agents/probe/sessions/main/model');
  assert.equal(m.status, 200);
  assert.equal(m.body.provider, 'external');
  assert.equal(m.body.source, 'external');
  for (const [method, path, body] of [
    ['PUT', '/agents/probe/sessions/main/model', { model: 'x' }],
    ['DELETE', '/agents/probe/sessions/main/model'],
    ['PUT', '/agents/probe/sessions/main/thinking', { level: 'high' }],
    ['PUT', '/agents/probe/sessions/main/sampling', { temperature: 0.2 }],
    ['POST', '/agents/probe/sessions/main/compact'],
  ] as const) {
    const r = await call(method, path, body);
    assert.equal(r.status, 409, `${method} ${path}`);
    assert.match(r.body.error, /external agent/);
  }
  assert.equal((await call('GET', '/agents/probe/sessions/main/thinking')).body.source, 'external');
  assert.equal((await call('GET', '/agents/probe/sessions/main/sampling')).body.source, 'external');
  assert.equal((await call('GET', '/agents/nobody/sessions/main/model')).status, 404);
});

test('the open question: read it, answer it once, the answer reaches the waiting turn and every client', async () => {
  const waiting = askQuestion({ agent: 'probe', session: 'main', question: 'May I?', header: 'Permission', options: [{ label: 'Allow once', description: 'allow_once' }, { label: 'Reject', description: 'reject_once' }], multiple: false });
  const q = await call('GET', '/agents/probe/sessions/main/question');
  assert.equal(q.body.question.question, 'May I?');
  assert.deepEqual(q.body.question.options.map((o: any) => o.label), ['Allow once', 'Reject']);
  const wrong = await call('POST', '/agents/probe/sessions/main/questions/not-it/answer', { answers: ['Reject'] });
  assert.ok(wrong.status >= 400);
  const ok = await call('POST', `/agents/probe/sessions/main/questions/${q.body.question.id}/answer`, { answers: ['Reject'] });
  assert.equal(ok.status, 200);
  const answer = await waiting;
  assert.deepEqual(answer.answers, ['Reject']);
  assert.ok(published.some((p) => p.ev.event === 'question_answered' && p.agent === 'probe'));
  assert.equal((await call('GET', '/agents/probe/sessions/main/question')).body.question, null);
  const again = await call('POST', `/agents/probe/sessions/main/questions/${q.body.question.id}/answer`, { answers: ['Reject'] });
  assert.ok(again.status >= 400, 'answered once');
});

async function turn(session: string, text: string) {
  const ext = getExternalAgent('probe')!;
  const kinds: string[] = [];
  for await (const ev of runExternalTurn({ ext, session, text, metaStore: sessionMetaStore, config: () => config, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })) kinds.push(ev.kind);
  return kinds;
}

test('reset: the next turn starts the agent with a new {session}, and the other side forgets', async () => {
  await turn('main', 'remember 4711');
  assert.equal(knownInfo('probe')?.agentInfo?.name, 's-main');
  const before = await sessionMetaStore.get('probe', 'main');
  assert.equal(typeof (before as any).externalSessionId, 'string');

  const r1 = await call('POST', '/agents/probe/sessions/main/reset');
  assert.equal(r1.status, 200);
  assert.equal(r1.body.dreamSpawned, false);
  const after1 = (await sessionMetaStore.get('probe', 'main')) as any;
  assert.equal(after1.externalGeneration, 1);
  assert.equal(after1.externalSessionId, undefined);
  await turn('main', 'recall');
  assert.equal(knownInfo('probe')?.agentInfo?.name, 's-main-r1');

  await call('POST', '/agents/probe/sessions/main/reset');
  assert.equal(((await sessionMetaStore.get('probe', 'main')) as any).externalGeneration, 2, 'the counter survives the fresh meta of each reset');
  await turn('main', 'recall');
  assert.equal(knownInfo('probe')?.agentInfo?.name, 's-main-r2');
});

test('/sessions lists external agents\' conversations with their system and sign', async () => {
  const { body } = await call('GET', '/sessions');
  const rows = (Array.isArray(body) ? body : body.sessions) as any[];
  const row = rows.find((r) => r.agent === 'probe');
  assert.ok(row, 'probe has a row');
  assert.deepEqual(row.external, { system: 'loc' });
  assert.equal(row.agentIcon, '🧪');
});

test('a resource marked externalOnly stays out of somora agents\' sight', async () => {
  const names = (await visibleResourcesForAgent('ada', config)).map((v) => v.name);
  assert.deepEqual(names, ['shared']);
});
