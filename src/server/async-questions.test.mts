// Questions that do not wait (async-questions.ts): a chat agent's
// ask_user in a turn a person started returns at once and leaves a card
// on the session; the card survives the turn (it lives in the session
// meta); a click sends the choice as the person's next message through
// the same ledger item and turn a typed message gets; writing anything
// else answers it too; a newer question replaces it. A task from another
// agent system keeps the waiting question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConfigSchema } from '../config/types.ts';
import { setConfig } from './server-state.ts';
import { TURN_ASKER_KEY, TURN_ATTENDED_KEY, askerOf, asksWithoutWaiting } from './ask-attended.ts';
import { OPEN_QUESTION_KEY, askWithoutWaiting, cleanParts, clearAsyncQuestion, composeAnswerMessage, openAsyncQuestion } from './async-questions.ts';
import { pendingQuestion, answerQuestion, type PendingQuestion } from './builder-questions.ts';
import { registerBuilderRoutes } from './routes/builder.ts';
import { registerExternalRoutes } from './routes/external.ts';
import { configureStartTurn } from './start-turn.ts';
import type { RunChatTurnArgs } from './run-turn.ts';
import type { ChatTurnResolveDeps, ChatTurnResult } from './run-turn-types.ts';
import { createSession, sessionMetaStore } from '../storage/sessions.ts';
import type { SseEvent } from '../types/events.ts';
import { loadPersona } from '../persona/loader.ts';
import { ASK_USER_HINT, assembleSystemPrompt } from './prompt-assembly.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
setConfig(ConfigSchema.parse({ providers: {} }));

const events: Array<{ session: string; event: SseEvent }> = [];
const runs: RunChatTurnArgs[] = [];
configureStartTurn({
  chatTurnDeps: {} as ChatTurnResolveDeps,
  publish: async (_agent, session, event) => {
    events.push({ session, event });
  },
  runTurn: async (args) => {
    runs.push(args);
    return { finalText: 'ok', outcome: 'completed', tool_calls: 0, contextWindow: 1, provider: 'p', model: 'm', thinkingActive: false, ms: 1 } as ChatTurnResult;
  },
});
const publish = (async (_a: string, session: string, event: SseEvent) => {
  events.push({ session, event });
}) as never;

const app = new Hono();
registerBuilderRoutes(app, { publish });
registerExternalRoutes(app, { publish } as never);

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const ask = (session: string) => app.request(`/agents/ada/sessions/${session}/ask`, json({ question: 'Go on or stop here?', options: [{ label: 'Go on' }, { label: 'Stop here' }] }));
const getQuestion = async (session: string) => ((await (await app.request(`/agents/ada/sessions/${session}/question`)).json()) as { question: PendingQuestion | null }).question;
const answer = (session: string, id: string, body: unknown) => app.request(`/agents/ada/sessions/${session}/questions/${id}/answer`, json(body));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function personTurn(slug: string): Promise<string> {
  const id = await createSession('ada', slug);
  await sessionMetaStore.update('ada', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: true, [TURN_ASKER_KEY]: 'human' }));
  return id;
}

test('who asks decides whether the question waits', () => {
  assert.equal(askerOf({ kind: 'human', via: 'chat' }), 'human');
  assert.equal(askerOf({ kind: 'peer', peer: 'x', contextId: 'c', taskId: 't' }), 'peer');
  assert.equal(askerOf({ kind: 'agent', from: { agent: 'bea' } }), null);
  assert.equal(asksWithoutWaiting('chat', { [TURN_ATTENDED_KEY]: true, [TURN_ASKER_KEY]: 'human' }), true);
  assert.equal(asksWithoutWaiting('chat', { [TURN_ATTENDED_KEY]: true, [TURN_ASKER_KEY]: 'peer' }), false, 'another agent system waits for its answer');
  assert.equal(asksWithoutWaiting('chat', { [TURN_ATTENDED_KEY]: true }), false, 'unknown asker: the old waiting behaviour');
  assert.equal(asksWithoutWaiting('builder', { [TURN_ATTENDED_KEY]: true, [TURN_ASKER_KEY]: 'human' }), false, "a builder's question waits");
});

test('the message an answer becomes', () => {
  const one = { id: 'q', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }], multiple: false } as PendingQuestion;
  assert.equal(composeAnswerMessage(one, { answers: ['B'] }), 'B');
  assert.equal(composeAnswerMessage(one, { answers: ['Go on (Recommended)'] }), 'Go on', "the agent's note on its option is not part of the answer");
  assert.equal(composeAnswerMessage(one, { answers: ['A'], text: 'but quickly' }), 'A — but quickly');
  assert.equal(composeAnswerMessage(one, { text: '  neither  ' }), 'neither');
  assert.equal(composeAnswerMessage(one, { answers: ['  '] }), null, 'nothing chosen, nothing typed');
  const two = { ...one, parts: [{ question: 'Colour?', options: [{ label: 'Red' }], multiple: false }, { question: 'Name?', options: [], multiple: false }] } as PendingQuestion;
  assert.equal(composeAnswerMessage(two, { parts: [{ answers: ['Red'] }, { text: 'Kai' }] }), 'Colour?\n→ Red\n\nName?\n→ Kai');
  assert.equal(composeAnswerMessage(two, { parts: [{}, { text: 'Kai' }] }), 'Name?\n→ Kai', 'an unanswered part is left out');
  assert.equal(composeAnswerMessage(two, { parts: [{}, {}] }), null);
});

test('cleanParts keeps questions with text, options as labels, at most six', () => {
  const parts = cleanParts([{ question: ' Weiter? ', options: ['Weiter', '', 'Pause'] }, { question: '' }, { title: 'no question field' }, { question: 'Free text', options: null }]);
  assert.deepEqual(parts, [
    { question: 'Weiter?', options: [{ label: 'Weiter' }, { label: 'Pause' }], multiple: false },
    { question: 'Free text', options: [], multiple: false },
  ]);
  assert.equal(cleanParts(Array.from({ length: 9 }, (_, i) => ({ question: `q${i}` }))).length, 6);
});

test("a chat agent's question in a person's turn returns at once and stays on the session", async () => {
  const id = await personTurn('async-ask');
  events.length = 0;
  const t = Date.now();
  const body = (await (await ask(id)).json()) as { asked?: boolean; questionId?: string; note?: string };
  assert.ok(Date.now() - t < 2000, 'no waiting');
  assert.equal(body.asked, true);
  assert.match(body.note ?? '', /End your turn/);
  assert.equal(pendingQuestion('ada', id), null, 'nothing waits in memory');
  const meta = (await sessionMetaStore.get('ada', id)) as Record<string, unknown>;
  assert.equal((meta[OPEN_QUESTION_KEY] as PendingQuestion).id, body.questionId, 'kept in the session meta (survives a restart)');
  const q = await getQuestion(id);
  assert.equal(q?.id, body.questionId);
  assert.equal(q?.async, true);
  assert.equal(q?.expiresAt, 0);
  const asked = events.find((e) => e.event.event === 'question_asked');
  assert.ok(asked && asked.event.event === 'question_asked' && asked.event.data.async === true && asked.event.data.source === 'ask_user');
});

test('a click sends the choice as the person’s next message and removes the card', async () => {
  const id = await personTurn('async-answer');
  const { questionId } = (await (await ask(id)).json()) as { questionId: string };
  events.length = 0;
  runs.length = 0;
  const res = await answer(id, questionId, { answers: ['Stop here'] });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sent?: boolean; text?: string; turnId?: string };
  assert.equal(body.sent, true);
  assert.equal(body.text, 'Stop here');
  for (let i = 0; i < 50 && runs.length === 0; i++) await tick();
  assert.equal(runs.length, 1, 'a turn started');
  assert.equal(runs[0]!.text, 'Stop here');
  assert.deepEqual(runs[0]!.origin, { kind: 'human', via: 'chat' });
  assert.equal(await getQuestion(id), null);
  const settled = events.find((e) => e.event.event === 'question_answered');
  assert.ok(settled && settled.event.event === 'question_answered' && settled.event.data.choice === 'Stop here');
  assert.equal((await answer(id, questionId, { answers: ['Stop here'] })).status, 404, 'answered once only');
});

test('an empty answer is refused and the card stays', async () => {
  const id = await personTurn('async-empty');
  const { questionId } = (await (await ask(id)).json()) as { questionId: string };
  assert.equal((await answer(id, questionId, { answers: [] })).status, 400);
  assert.equal((await getQuestion(id))?.id, questionId);
});

test('several questions: one message with each question and its answer', async () => {
  const id = await personTurn('async-parts');
  const q = await askWithoutWaiting({
    agent: 'ada',
    session: id,
    source: 'codex',
    parts: cleanParts([{ question: 'Weiter?', options: ['Ja', 'Nein'] }, { question: 'Wann?' }]),
  });
  assert.equal(q.parts?.length, 2);
  assert.equal(q.question, 'Weiter?', 'the top-level fields repeat the first part');
  runs.length = 0;
  const body = (await (await answer(id, q.id, { parts: [{ answers: ['Ja'] }, { text: 'morgen' }] })).json()) as { text?: string };
  assert.equal(body.text, 'Weiter?\n→ Ja\n\nWann?\n→ morgen');
  for (let i = 0; i < 50 && runs.length === 0; i++) await tick();
  assert.equal(runs[0]?.text, 'Weiter?\n→ Ja\n\nWann?\n→ morgen');
});

test('writing something else answers it; a newer question replaces the open one', async () => {
  const id = await personTurn('async-clear');
  const first = await askWithoutWaiting({ agent: 'ada', session: id, source: 'ask_user', parts: cleanParts([{ question: 'A?', options: ['x', 'y'] }]) });
  events.length = 0;
  const second = await askWithoutWaiting({ agent: 'ada', session: id, source: 'ask_user', parts: cleanParts([{ question: 'B?', options: ['x', 'y'] }]) });
  const replaced = events.find((e) => e.event.event === 'question_answered');
  assert.ok(replaced && replaced.event.event === 'question_answered' && replaced.event.data.questionId === first.id && replaced.event.data.answered === false);
  assert.equal((await openAsyncQuestion('ada', id))?.id, second.id);
  events.length = 0;
  assert.equal(await clearAsyncQuestion('ada', id), true);
  const cleared = events.find((e) => e.event.event === 'question_answered');
  assert.ok(cleared && cleared.event.event === 'question_answered' && cleared.event.data.by === 'message' && cleared.event.data.questionId === second.id);
  assert.equal(await openAsyncQuestion('ada', id), null);
  assert.equal(await clearAsyncQuestion('ada', id), false, 'nothing left to clear');
});

test('a task from another agent system keeps the waiting question', async () => {
  const id = await createSession('ada', 'peer-ask');
  await sessionMetaStore.update('ada', id, (m) => ({ ...m, [TURN_ATTENDED_KEY]: true, [TURN_ASKER_KEY]: 'peer' }));
  const pending = ask(id);
  let q = null;
  for (let i = 0; i < 50 && !q; i++) {
    await tick();
    q = pendingQuestion('ada', id);
  }
  assert.ok(q, 'the question waits in memory');
  assert.equal(await openAsyncQuestion('ada', id), null);
  assert.equal(answerQuestion('ada', id, q!.id, { answers: ['Go on'] }), true);
  assert.deepEqual(await (await pending).json(), { answered: true, answers: ['Go on'] });
});

test('the chat prompt names ask_user only when the turn offers it', async () => {
  const persona = (await loadPersona('ada'))!;
  const id = await createSession('ada', 'prompt-hint');
  const deps = { config: ConfigSchema.parse({ providers: {} }), sessionMetaStore, tools: undefined as never, onActivity: () => {} };
  const build = (toolNames: string[]) =>
    assembleSystemPrompt({ agent: 'ada', session: id, persona, sessionMeta: {}, deps, subagentDepth: 0, toolCount: toolNames.length, toolNames, persistWikiSnapshot: false });
  assert.ok((await build(['exec', 'ask_user'])).text.includes(ASK_USER_HINT));
  assert.ok(!(await build(['exec'])).text.includes(ASK_USER_HINT));
});
