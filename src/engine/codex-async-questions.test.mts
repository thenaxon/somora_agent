// Codex's own question tool (request_user_input_async, codex 0.161):
// Codex answers the call itself with `{accepted: true}` and hands the
// questions over on the agentMessage item (`delivery: "async"`,
// `questions: [{title, options}]`, app-server v2). somora used to keep
// only the text, so the person saw the question as plain text and no
// buttons (report 2026-10-23). Now the questions become the session's
// open question — in a turn a person started — and are not stored as a
// row of their own; the text stays as it was.
import '../testing/own-home.mts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, type Config } from '../config/types.ts';
import { setConfig } from '../server/server-state.ts';
import { runChatTurn } from '../server/run-turn.ts';
import { configureStartTurn } from '../server/start-turn.ts';
import { openAsyncQuestion } from '../server/async-questions.ts';
import { createSession, getHistory, sessionMetaStore } from '../storage/sessions.ts';
import { asyncQuestionsOf } from './codex-cli.ts';
import { buildCodexToolCatalog } from './codex-dynamic-tools.ts';
import { DEFAULT_ALWAYS_VISIBLE } from '../tools/catalog.ts';
import { engineRegistry } from './registry.ts';
import { shutdownMemoryRegistry } from '../memory/registry.ts';
import { ASYNC_QUESTIONS_ITEM } from './types.ts';
import type { SseEvent } from '../types/events.ts';
import type { TurnOrigin } from '../types/turn-origin.ts';
import type { ToolDefinition } from '../tools/types.ts';
import { z } from 'zod';

// The item as codex 0.161 delivered it on 2026-10-23 (rollout row 11,
// shortened text).
const REAL_ITEM = {
  type: 'agentMessage',
  id: 'call_ba5cbeab24ab4dda97783dd1fb1f5283',
  text: 'Ja – soll ich weitermachen?\n- Weiter\n- Für jetzt pausieren',
  phase: 'final_answer',
  delivery: 'async',
  questions: [{ title: 'Ja – soll ich weitermachen?', options: ['Weiter', 'Für jetzt pausieren'] }],
};

test('the questions of an async agentMessage', () => {
  assert.deepEqual(asyncQuestionsOf(REAL_ITEM), [{ question: 'Ja – soll ich weitermachen?', options: ['Weiter', 'Für jetzt pausieren'] }]);
  assert.deepEqual(asyncQuestionsOf({ ...REAL_ITEM, questions: [{ title: 'Name?', options: null }] }), [{ question: 'Name?', options: [] }], 'no options: answered in words');
  assert.equal(asyncQuestionsOf({ ...REAL_ITEM, delivery: null }), null, 'an ordinary message');
  assert.equal(asyncQuestionsOf({ type: 'agentMessage', id: 'x', text: 'hi' }), null);
  assert.equal(asyncQuestionsOf({ ...REAL_ITEM, questions: [{ title: '' }] }), null);
});

test('ask_user is in the direct list, but only listed when the turn offers it', () => {
  assert.ok(DEFAULT_ALWAYS_VISIBLE.includes('ask_user'));
  const def = (name: string): ToolDefinition =>
    ({ name, description: name, inputSchema: z.object({}), jsonSchema: { type: 'object', properties: {} }, toolset: 'agents', async handler() { return {}; } }) as unknown as ToolDefinition;
  assert.ok(buildCodexToolCatalog([def('ask_user'), def('exec')]).directNames.includes('ask_user'));
  const without = buildCodexToolCatalog([def('exec')]);
  assert.ok(!without.directNames.includes('ask_user') && !without.deferredNames.includes('ask_user'), 'gating decides: not offered, not listed');
});

// Through the real turn entry with a stand-in engine.
const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'cody'), { recursive: true });
writeFileSync(join(home, 'agents', 'cody', 'AGENTS.md'), '# cody\n');
writeFileSync(join(home, 'agents', 'cody', 'agent.yaml'), 'model: cx/gpt\n');
const config: Config = ConfigSchema.parse({
  providers: { cx: { engine: 'codex-cli', models: [{ id: 'gpt', alias: 'gpt', contextWindow: 100000, capabilities: ['text'] }] } },
  agentLoop: { toolUsageReminder: false },
});
setConfig(config);
const broadcast: SseEvent[] = [];
configureStartTurn({ chatTurnDeps: {} as never, publish: async (_a, _s, e) => void broadcast.push(e) });
// What the stand-in engine does: ask (or not) and say the text (or not).
let script = { ask: true, text: REAL_ITEM.text as string | null };
(engineRegistry as unknown as Record<string, unknown>)['codex-cli'] = {
  name: 'codex-cli',
  async *runTurn() {
    yield { kind: 'turn_start', ts: 1, engine: 'codex-cli', turnId: 't1' };
    if (script.ask) yield { kind: 'engine_meta', ts: 2, engine: 'codex-cli', itemType: ASYNC_QUESTIONS_ITEM, payload: { questions: asyncQuestionsOf(REAL_ITEM) } };
    if (script.text !== null) yield { kind: 'assistant_message', ts: 3, engine: 'codex-cli', text: script.text };
    yield { kind: 'turn_end', ts: 4, engine: 'codex-cli', turnId: 't1' };
  },
};
const tools = { listAvailable: async () => [], list: () => [], invoke: async () => ({ ok: false, error: 'none' }) };

async function turn(slug: string, origin: TurnOrigin) {
  const sid = await createSession('cody', slug);
  lastResult = await runChatTurn({
    agent: 'cody',
    session: sid,
    text: 'go on?',
    origin,
    deps: { config, sessionMetaStore, tools: tools as never, onActivity: () => {} },
  } as Parameters<typeof runChatTurn>[0]);
  return sid;
}
let lastResult: Awaited<ReturnType<typeof runChatTurn>> | undefined;

test("in a person's turn Codex's questions become the session's open question, not a row", async () => {
  broadcast.length = 0;
  const sid = await turn('codex-q', { kind: 'human', via: 'chat' });
  const q = await openAsyncQuestion('cody', sid);
  assert.ok(q, 'open question on the session');
  assert.equal(q!.question, 'Ja – soll ich weitermachen?');
  assert.deepEqual(q!.options.map((o) => o.label), ['Weiter', 'Für jetzt pausieren']);
  assert.equal(q!.source, 'codex');
  const history = await getHistory('cody', sid);
  assert.ok(!history.some((e) => e.kind === 'engine_meta' && (e as { itemType?: string }).itemType === ASYNC_QUESTIONS_ITEM), 'no row of its own');
  assert.ok(history.some((e) => e.kind === 'assistant_message' && (e as { text?: string }).text === REAL_ITEM.text), 'the text stays');
  assert.ok(broadcast.some((e) => e.event === 'question_asked'));
});

test('in a turn nobody watches the questions stay in the text only', async () => {
  const sid = await turn('codex-q-agent', { kind: 'agent', from: { agent: 'ada' } });
  assert.equal(await openAsyncQuestion('cody', sid), null);
});

test('a turn that only asks is complete: the card is its answer', async () => {
  script = { ask: true, text: null };
  await turn('codex-q-only', { kind: 'human', via: 'chat' });
  assert.equal(lastResult!.outcome, 'completed');
  assert.equal(lastResult!.outcome_reason, undefined);
  script = { ask: false, text: null };
  await turn('codex-silent', { kind: 'human', via: 'chat' });
  assert.equal(lastResult!.outcome, 'degraded', 'no question and no text is still an empty answer');
  assert.equal(lastResult!.outcome_reason, 'empty_answer');
  script = { ask: true, text: REAL_ITEM.text };
});

// The turn opened the agent's memory (and its file watcher).
after(() => shutdownMemoryRegistry());
