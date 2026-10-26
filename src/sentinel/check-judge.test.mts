// Art 2: the wake rule on each kind of answer, the checks at creation,
// and a watch check end to end against a fake decision model — starting
// state, the same data never asked twice, new data above and below the
// threshold, an outage that wakes nobody, and a model gone from config.
import '../testing/own-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema, type Config } from '../config/types.ts';
import { applyWakeRule, validateDecisionEvaluator } from './check-judge.ts';
import { prepareCheckSource } from './check-create.ts';
import { runDueCheck, type CheckWake, type FireOutcome } from './check-loop.ts';
import { loadCheckState } from './check-store.ts';
import { deleteTrigger, getHistory, getTrigger, keepNewest, loadTriggers, saveTrigger } from './store.ts';
import { dryRunCheck } from './check-dry-run.ts';
import type { Trigger } from './types.ts';

// ── fake decision model: "urgent" when a mail mentions tonight ──
let calls: Array<{ state: unknown }> = [];
let mode: 'ok' | 'down' | 'flaky' = 'ok';
// perItem: how many questions were open at once, and a small delay so it shows.
let inflight = 0;
let maxInflight = 0;
let delayMs = 0;
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d)).on('end', () => {
    const json = (r: ServerResponse, status: number, body: unknown) => { r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(body)); };
    if (req.url?.endsWith('/v1/models')) return json(res, 200, { data: [{ id: 'clef', max_input_tokens: 65536 }] });
    if (mode === 'down') return json(res, 503, { error: { message: 'loading' } });
    const body = JSON.parse(raw) as { state: unknown };
    if (mode === 'flaky' && JSON.stringify(body.state).includes('flaky')) return json(res, 503, { error: { message: 'loading' } });
    calls.push({ state: body.state });
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    const urgent = JSON.stringify(body.state).includes('tonight');
    setTimeout(() => {
      inflight--;
      json(res, 200, { model: 'clef', answers: { urgent: { type: 'noul', noul: urgent ? 0.93 : 0.08 } }, usage: { input_tokens: 30, output_tokens: 0 } });
    }, delayMs);
  });
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
after(() => fake.close());
const port = (fake.address() as AddressInfo).port;

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
const work = mkdtempSync(join(home, 'work-'));
const base = {
  providers: { p: { engine: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-ABCDEFGHIJKLMNOP', models: [{ id: 'x', contextWindow: 1000 }] } },
  workspace: { default: work },
};
const withModel = ConfigSchema.parse({ ...base, decisions: { model: 'clef', models: [{ name: 'clef', baseUrl: `http://127.0.0.1:${port}/clef`, model: 'clef', timeoutMs: 5000 }] } });
const without = ConfigSchema.parse(base);
const questions = { urgent: { type: 'boolean', instructions: 'Does any of these mails need an answer today?' } };

test('wake rules: yes/no probability, a choice (chosen or by confidence), a score', () => {
  const b = { type: 'boolean' as const, probabilityTrue: 0.85 };
  assert.equal((applyWakeRule({ question: 'q', minProbability: 0.8 }, { q: b }) as { wake: boolean }).wake, true);
  assert.equal((applyWakeRule({ question: 'q', minProbability: 0.9 }, { q: b }) as { wake: boolean }).wake, false);
  const c = { type: 'choice' as const, choice: 'later', confidence: 0.55, probabilities: { now: 0.45, later: 0.55 } };
  assert.equal((applyWakeRule({ question: 'q', choice: 'now' }, { q: c }) as { wake: boolean }).wake, false, 'not chosen');
  assert.equal((applyWakeRule({ question: 'q', choice: 'now', minConfidence: 0.4 }, { q: c }) as { wake: boolean }).wake, true, 'probability of now ≥ 0.4');
  const s = { type: 'score' as const, score: 3, max: 4, confidence: 0.7, probabilities: [0, 0, 0.1, 0.7, 0.2], legend: [] };
  assert.equal((applyWakeRule({ question: 'q', minScore: 3 }, { q: s }) as { wake: boolean }).wake, true);
  assert.equal(applyWakeRule({ question: 'q', minScore: 3 }, { q: b }).ok, false, 'wrong kind is an error, never a wake');
});

test('creating: Art 2 only with a decision model, and the rule must fit the questions', () => {
  assert.match(validateDecisionEvaluator(questions, { question: 'urgent', minProbability: 0.8 }, without)!, /none is configured/);
  assert.equal(validateDecisionEvaluator(questions, { question: 'urgent', minProbability: 0.8 }, withModel), null);
  assert.match(validateDecisionEvaluator(questions, { question: 'nope', minProbability: 0.8 }, withModel)!, /must name one of the questions \(urgent\)/);
  assert.match(validateDecisionEvaluator(questions, { question: 'urgent', minProbability: 1.5 }, withModel)!, /between 0 and 1/);
  assert.match(validateDecisionEvaluator(questions, { question: 'urgent', minScore: 2 }, withModel)!, /needs a score question/);
  const levels = { prio: { type: 'score', criteria: ['none', 'low', 'high'] } };
  assert.match(validateDecisionEvaluator(levels, { question: 'prio', minScore: 3 }, withModel)!, /from 1 to 2/);
  const pick = { lane: { type: 'choice', criteria: { now: 'today', later: 'can wait' } } };
  assert.match(validateDecisionEvaluator(pick, { question: 'lane', choice: 'never' }, withModel)!, /one of now, later/);
  assert.match(validateDecisionEvaluator({ urgent: { type: 'boolean' } }, { question: 'urgent', minProbability: 0.5 }, withModel)!, /needs instructions or criteria/);
});

await loadTriggers();
const mails = join(work, 'mails.json');
const setMails = (list: string[]) => writeFileSync(mails, JSON.stringify(list));

const createdAt = new Map<string, number>();
async function makeArt2(id: string, config: Config, perItem = false) {
  createdAt.set(id, Date.now());
  const path = join(work, `${id}.py`);
  writeFileSync(path, `import json\nprint(json.dumps({"summary": "new mail", "data": json.load(open(${JSON.stringify(mails)}))}))\n`);
  const p = await prepareCheckSource(id, { description: 'mail that needs an answer today', scriptPath: path, mode: 'watch', interval: '5m', decision: { questions, wake: { question: 'urgent', minProbability: 0.8 }, ...(perItem ? { perItem: true } : {}) } }, config, new Date(createdAt.get(id)!));
  assert.equal(p.ok, true, JSON.stringify(p));
  if (!p.ok) throw new Error('unreachable');
  const t: Trigger = { id, name: id, ownerAgent: 'ada', source: p.source, evaluator: p.evaluator, dispatch: { agent: 'ada', session: 'main', prompt: 'triage' }, createdAt: new Date().toISOString(), status: 'active', fireCount: 0, errorStreak: 0 };
  await saveTrigger(t);
}

function harness(config: () => Config) {
  const wakes: CheckWake[] = [];
  return { wakes, deps: { config, reschedule: () => {}, fire: async (_t: Trigger, w: CheckWake): Promise<FireOutcome> => { wakes.push(w); return 'started'; } } };
}
// Minutes after the trigger was created (a busy test run can take
// seconds between two tests, which would make the first check "not due").
const check = (id: string, deps: ReturnType<typeof harness>['deps'], m: number) => runDueCheck(getTrigger(id)!, deps, () => new Date(createdAt.get(id)! + m * 60_000));

test('Art 2 watch: starting state, same data asks nobody, new data wakes only above the threshold', async () => {
  calls = [];
  setMails(['Newsletter', 'Receipt']);
  await makeArt2('mail-a', withModel);
  const h = harness(() => withModel);
  await check('mail-a', h.deps, 0); // starting state: no model call
  assert.equal(calls.length, 0);
  await check('mail-a', h.deps, 5); // same data
  assert.equal(calls.length, 0, 'the same data is never sent twice');
  setMails(['Newsletter', 'Receipt', 'Lunch next week?']);
  await check('mail-a', h.deps, 10);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.state, ['Newsletter', 'Receipt', 'Lunch next week?'], 'the data is the state');
  assert.equal(h.wakes.length, 0, '0.08 is below 0.8');
  await check('mail-a', h.deps, 15);
  assert.equal(calls.length, 1, 'judged data is not judged again');
  setMails(['Invoice overdue, pay by tonight']);
  await check('mail-a', h.deps, 20);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0]!.reason, 'decision');
  assert.deepEqual(h.wakes[0]!.data, ['Invoice overdue, pay by tonight']);
  assert.equal(h.wakes[0]!.state.last?.decision?.value, 0.93);
  assert.equal(getTrigger('mail-a')!.status, 'active', 'watch keeps going');
});

test('an outage wakes nobody, counts as a check error, and the data is judged once the model is back', async () => {
  calls = [];
  setMails(['a']);
  await makeArt2('mail-b', withModel);
  const h = harness(() => withModel);
  await check('mail-b', h.deps, 0);
  setMails(['a', 'Call me tonight']);
  mode = 'down';
  await check('mail-b', h.deps, 5);
  mode = 'ok';
  assert.equal(h.wakes.length, 0);
  const s = (await loadCheckState('mail-b'))!;
  assert.equal(s.errorStreak, 1);
  assert.match(s.last?.error ?? '', /decision model: not-ready|decision model: transport/);
  await check('mail-b', h.deps, 10);
  assert.equal(h.wakes.length, 1, 'the unseen data was judged on the next check');
});

test('a decision model removed from config pauses the trigger at once', async () => {
  setMails(['x']);
  await makeArt2('mail-c', withModel);
  const h = harness(() => without);
  await check('mail-c', h.deps, 0); // starting state needs no model
  setMails(['x', 'y']);
  await check('mail-c', h.deps, 5);
  const t = getTrigger('mail-c')!;
  assert.equal(t.status, 'error');
  assert.match(t.statusReason ?? '', /no decision model is configured/);
});

test('perItem: each new mail asked about alone and in parallel, a wake carries just the hit, history says what was judged', async () => {
  calls = [];
  maxInflight = 0;
  delayMs = 150;
  const m = (id: number, subject: string) => ({ id, subject });
  writeFileSync(mails, JSON.stringify([m(1, 'Newsletter'), m(2, 'Receipt')]));
  await makeArt2('mail-p', withModel, true);
  assert.equal(getTrigger('mail-p')!.evaluator.type === 'decision' && (getTrigger('mail-p')!.evaluator as { perItem?: true }).perItem, true);
  const h = harness(() => withModel);
  await check('mail-p', h.deps, 0); // starting items: known, nobody asked
  assert.equal(calls.length, 0);
  const six = [m(1, 'Newsletter'), m(2, 'Receipt'), m(3, 'Lunch?'), m(4, 'Pay by tonight'), m(5, 'Offer'), m(6, 'Update'), m(7, 'Digest'), m(8, 'Ticket')];
  writeFileSync(mails, JSON.stringify(six));
  const started = Date.now();
  await check('mail-p', h.deps, 5);
  const took = Date.now() - started;
  assert.equal(calls.length, 6, 'only the six new mails, one question each');
  assert.deepEqual(calls.map((c) => (c.state as { id: number }).id).sort(), [3, 4, 5, 6, 7, 8]);
  assert.equal(maxInflight, 4, 'parallelDecisions: 4 at a time');
  assert.ok(took < 6 * 150, `in parallel, not one after another (${took} ms)`);
  assert.equal(h.wakes.length, 1);
  assert.deepEqual(h.wakes[0]!.data, [m(4, 'Pay by tonight')], 'just the mail above the rule');
  const hist = await getHistory('mail-p', 5);
  assert.equal(hist[0]!.outcome, 'judged');
  assert.equal(hist[0]!.note, 'urgent: id:3 0.08, id:4 0.93 (wakes), id:5 0.08, id:6 0.08, id:7 0.08, id:8 0.08; 1 above the wake rule — wakes', 'each item named with its answer');
  calls = [];
  await check('mail-p', h.deps, 10);
  assert.equal(calls.length, 0, 'judged mails are not asked about again');
  delayMs = 0;
});

test('perItem: a mail without an answer is asked about again, the others are not', async () => {
  calls = [];
  const m = (id: number, subject: string) => ({ id, subject });
  writeFileSync(mails, JSON.stringify([]));
  await makeArt2('mail-q', withModel, true);
  const h = harness(() => withModel);
  await check('mail-q', h.deps, 0);
  writeFileSync(mails, JSON.stringify([m(1, 'a'), m(2, 'flaky tonight')]));
  mode = 'flaky';
  await check('mail-q', h.deps, 5);
  assert.equal(h.wakes.length, 0);
  assert.equal((await loadCheckState('mail-q'))!.errorStreak, 0, 'one answer came: not a check error');
  mode = 'ok';
  calls = [];
  await check('mail-q', h.deps, 10);
  assert.deepEqual(calls.map((c) => (c.state as { id: number }).id), [2]);
  assert.equal(h.wakes.length, 1);
});

test('without perItem a list of several mails gets a warning in the state and the history', async () => {
  writeFileSync(mails, JSON.stringify([]));
  await makeArt2('mail-w', withModel);
  const h = harness(() => withModel);
  await check('mail-w', h.deps, 0);
  writeFileSync(mails, JSON.stringify([{ id: 1, subject: 'a' }, { id: 2, subject: 'b' }]));
  await check('mail-w', h.deps, 5);
  assert.match((await loadCheckState('mail-w'))!.last?.warning ?? '', /list of 2 items, judged as one/);
  assert.match((await getHistory('mail-w', 1))[0]!.note ?? '', /Warning: the data is a list of 2 items/);
});

// ── review 2026-10-26 ──

const m = (id: number, subject: string) => ({ id, subject });

test('a trigger deleted while its items are judged stays deleted and wakes nobody', async () => {
  writeFileSync(mails, JSON.stringify([]));
  await makeArt2('mail-del', withModel, true);
  // a once trigger: a hit would complete it — and used to save it back
  const t = getTrigger('mail-del')!;
  await saveTrigger({ ...t, source: { ...(t.source as object), mode: 'once', deadline: new Date(Date.now() + 3_600_000).toISOString() } as Trigger['source'] });
  const h = harness(() => withModel);
  writeFileSync(mails, JSON.stringify([m(1, 'pay by tonight')]));
  delayMs = 300;
  const run = check('mail-del', h.deps, 0);
  await new Promise((r) => setTimeout(r, 150)); // the model is answering now
  await deleteTrigger('mail-del');
  await run;
  delayMs = 0;
  assert.equal(h.wakes.length, 0, 'no wake for a deleted trigger');
  assert.equal(getTrigger('mail-del') ?? null, null, 'not saved back as completed');
});

test('a trigger changed while judging keeps its fresh start', async () => {
  writeFileSync(mails, JSON.stringify([]));
  await makeArt2('mail-upd', withModel, true);
  const h = harness(() => withModel);
  await check('mail-upd', h.deps, 0); // starting items (none)
  writeFileSync(mails, JSON.stringify([m(1, 'pay by tonight')]));
  delayMs = 300;
  const run = check('mail-upd', h.deps, 5);
  await new Promise((r) => setTimeout(r, 150));
  const t = getTrigger('mail-upd')!;
  await saveTrigger({ ...t, source: { ...(t.source as object), interval: '10m' } as Trigger['source'] });
  await run;
  delayMs = 0;
  assert.equal(h.wakes.length, 0);
  assert.equal((await loadCheckState('mail-upd'))!.seenItems?.['id:1'], undefined, 'the old run saved nothing');
});

test('a decision model that stays down pauses the trigger after errorStreak checks', async () => {
  writeFileSync(mails, JSON.stringify([]));
  await makeArt2('mail-down', withModel, true);
  const h = harness(() => withModel);
  await check('mail-down', h.deps, 0);
  writeFileSync(mails, JSON.stringify([m(1, 'a'), m(2, 'b')]));
  mode = 'down';
  for (const [i, min] of [5, 10, 20].entries()) {
    await check('mail-down', h.deps, min);
    if (i < 2) assert.equal((await loadCheckState('mail-down'))!.errorStreak, i + 1, `failure ${i + 1} counted`);
  }
  mode = 'ok';
  const t = getTrigger('mail-down')!;
  assert.equal(t.status, 'error', 'paused after three checks without an answer');
  const hist = await getHistory('mail-down', 10);
  assert.ok(hist.some((e) => e.outcome === 'judged' && /id:1, id:2\): no answer from the decision model/.test(e.note ?? '')), 'the history names the unanswered items');
});

test('a first wake that cannot start leaves no charge on the day', async () => {
  writeFileSync(mails, JSON.stringify([]));
  await makeArt2('mail-skip', withModel, true);
  const skipped = { config: () => withModel, reschedule: () => {}, fire: async (): Promise<FireOutcome> => 'skipped' };
  await check('mail-skip', skipped, 0);
  writeFileSync(mails, JSON.stringify([m(1, 'pay by tonight')]));
  await check('mail-skip', skipped, 5);
  const s = (await loadCheckState('mail-skip'))!;
  assert.equal(s.wakesToday, undefined, 'the skipped wake is not counted');
  assert.equal(s.seenItems?.['id:1'], undefined, 'and the item stays new');
});

test('judged entries do not push fires out of the history ring', () => {
  const fire = (i: number) => JSON.stringify({ firedAt: `t${i}`, outcome: 'success' });
  const judged = (i: number) => JSON.stringify({ firedAt: `t${i}`, outcome: 'judged' });
  const lines = [fire(0), ...Array.from({ length: 300 }, (_, i) => judged(i + 1)), fire(301)];
  const kept = keepNewest(lines, 200);
  assert.equal(kept.filter((l) => l.includes('success')).length, 2, 'both fires kept');
  assert.equal(kept.filter((l) => l.includes('judged')).length, 200);
  assert.equal(kept[0], fire(0), 'file order kept');
});

test('dry run, item by item: a script that reports final failed says so', async () => {
  const path = join(work, 'final-failed.py');
  writeFileSync(path, 'import json\nprint(json.dumps({"final": "failed", "summary": "job cancelled"}))\n');
  const r = await dryRunCheck({ agent: 'ada', source: { mode: 'watch' }, evaluator: { type: 'decision', questions, wake: { question: 'urgent', minProbability: 0.8 }, perItem: true }, config: withModel, scriptPath: path });
  assert.match(r.verdict, /final: "failed"/);
  assert.equal(r.items, undefined);
});
