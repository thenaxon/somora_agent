// ask_user for every agent, only while someone watches: the tool is no
// longer builder-only, a chat agent gets it in a turn a person started
// (typed or spoken), never in a turn from Sentinel, another agent or a
// sub-agent; a builder keeps its attended switch. The route refuses a
// chat agent's question outside such a turn at once instead of waiting,
// and a chat agent's waiting question (a task from another agent system)
// waits 10 minutes by default. In a turn a person started it does not
// wait at all (async-questions.test.mts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConfigSchema } from '../config/types.ts';
import { setConfig } from './server-state.ts';
import { effectiveToolGating, isToolAllowed } from '../tools/gating.ts';
import { CHAT_QUESTION_TIMEOUT_MS, TURN_ASKER_KEY, TURN_ATTENDED_KEY, isAttendedOrigin, sessionToolAllows } from './ask-attended.ts';
import { registerBuilderRoutes } from './routes/builder.ts';
import { pendingQuestion, answerQuestion } from './builder-questions.ts';
import { createSession, sessionMetaStore } from '../storage/sessions.ts';
import type { BuilderSessionState } from './builder-session.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
setConfig(ConfigSchema.parse({ providers: {} }));

test('ask_user is no longer builder-only; the task list and the plan file still are', () => {
  const chat = effectiveToolGating('chat', undefined);
  assert.equal(isToolAllowed('ask_user', 'agents', chat), true);
  assert.equal(isToolAllowed('todo_write', 'builder', chat), false);
  assert.equal(isToolAllowed('plan_write', 'builder', chat), false);
  assert.equal(isToolAllowed('ask_user', 'agents', effectiveToolGating('chat', { deny: ['ask_user'], allow: [] })), false, 'an agent can still be kept from it');
  assert.equal(isToolAllowed('ask_user', 'agents', effectiveToolGating('builder', undefined)), true);
});

test('who counts as watching: a person typing or speaking, nobody else', () => {
  assert.equal(isAttendedOrigin({ kind: 'human', via: 'chat' }), true);
  assert.equal(isAttendedOrigin({ kind: 'human', via: 'voice-stt' }), true);
  assert.equal(isAttendedOrigin({ kind: 'sentinel', triggerId: 't', taskId: 'x' }), false);
  assert.equal(isAttendedOrigin({ kind: 'agent', from: { agent: 'bea' } }), false);
  assert.equal(isAttendedOrigin({ kind: 'subagent', depth: 1 }), false);
  assert.equal(isAttendedOrigin({ kind: 'wake', about: 'a2a', ref: 'c1' }), false);
  assert.equal(isAttendedOrigin(undefined), false, 'unknown origin: nobody is watching');
});

test('the offer per session: a chat agent by the turn, a builder by its switch', () => {
  assert.equal(sessionToolAllows('chat', null, { [TURN_ATTENDED_KEY]: true }, 'ask_user'), true);
  assert.equal(sessionToolAllows('chat', null, { [TURN_ATTENDED_KEY]: false }, 'ask_user'), false);
  assert.equal(sessionToolAllows('chat', null, {}, 'ask_user'), false);
  assert.equal(sessionToolAllows('chat', null, {}, 'exec'), true);
  const state = (mode: 'attended' | 'unattended'): BuilderSessionState => ({ mode, phase: 'build', planPath: null, todos: [] });
  assert.equal(sessionToolAllows('builder', state('attended'), {}, 'ask_user'), true);
  assert.equal(sessionToolAllows('builder', state('unattended'), { [TURN_ATTENDED_KEY]: true }, 'ask_user'), false, "the builder's switch decides, not the turn");
});

const app = new Hono();
registerBuilderRoutes(app, { publish: (async () => {}) as never });
const ask = (session: string) =>
  app.request(`/agents/ada/sessions/${session}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }),
  });

test("the route: a chat agent's question outside a person's turn returns at once", async () => {
  const id = await createSession('ada', 'auto');
  await sessionMetaStore.update('ada', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: false }));
  const t = Date.now();
  const body = (await (await ask(id)).json()) as { answered: boolean; text?: string };
  assert.equal(body.answered, false);
  assert.match(body.text ?? '', /decide yourself/);
  assert.ok(Date.now() - t < 2000);
  assert.equal(pendingQuestion('ada', id), null);
});

test('the route: in a task from another agent system the question waits for the answer, 10 minutes by default', async () => {
  const id = await createSession('ada', 'talk');
  await sessionMetaStore.update('ada', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: true, [TURN_ASKER_KEY]: 'peer' }));
  const pending = ask(id);
  let q = null;
  for (let i = 0; i < 50 && !q; i++) {
    await new Promise((r) => setTimeout(r, 20));
    q = pendingQuestion('ada', id);
  }
  assert.ok(q, 'the question is open');
  const wait = q!.expiresAt - q!.askedAt;
  assert.ok(Math.abs(wait - CHAT_QUESTION_TIMEOUT_MS) < 1000, `waits ${wait} ms`);
  assert.equal(answerQuestion('ada', id, q!.id, { answers: ['B'] }), true);
  const body = (await (await pending).json()) as { answered: boolean; answers: string[] };
  assert.deepEqual(body, { answered: true, answers: ['B'] });
});
