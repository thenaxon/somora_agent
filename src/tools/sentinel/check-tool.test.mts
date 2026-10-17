// The sentinel tool for check triggers: no create without a dry run of
// exactly this script, the dry run's verdict, create/get/update/test,
// and Art 2 only offered when a decision model is configured.
import '../../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '../../config/types.ts';
import { checkStateDir } from '../../sentinel/check-store.ts';
import { getHistory } from '../../sentinel/store.ts';
import { sentinel } from './tools.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
const work = mkdtempSync(join(home, 'work-'));
mkdirSync(join(work, 'checks'));
const base = {
  providers: { p: { engine: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-ABCDEFGHIJKLMNOP', models: [{ id: 'x', contextWindow: 1000 }] } },
  workspace: { default: work },
};
const config = ConfigSchema.parse(base);
const withModel = ConfigSchema.parse({ ...base, decisions: { model: 'clef', models: [{ name: 'clef', baseUrl: 'http://127.0.0.1:1/clef', model: 'clef' }] } });
const ctx = { agent: 'ada', session: 'main', config } as never;

type R = Record<string, any>;
const call = (input: Record<string, unknown>, c = ctx) => sentinel.handler(sentinel.inputSchema.parse(input) as never, c) as Promise<R>;

const script = (name: string, body: string) => { writeFileSync(join(work, 'checks', name), body); return `checks/${name}`; };
const src = (path: string, extra: Record<string, unknown> = {}) => ({ type: 'check', script: path, description: 'the build has passed', mode: 'once', interval: '15s', deadline: '2h', ...extra });

test('create refuses without a dry run of exactly this script; dry run then create works', async () => {
  const path = script('build.sh', 'echo \'{"ready": false, "summary": "build running"}\'');
  const before = await call({ action: 'create', name: 'build', source: src(path), dispatch: { agent: 'ada', prompt: 'report the build' } });
  assert.equal(before.ok, false);
  assert.match(before.error, /no successful dry run/);

  const dry = await call({ action: 'dry_run', source: src(path) });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.deepEqual(dry.answer, { ready: false, summary: 'build running' });
  assert.match(dry.verdict, /keep checking/);
  assert.match(dry.next, /create the trigger/);
  assert.match(dry.next, /Compare the answer with the real situation/);
  assert.equal(readdirSync(join(home, 'sentinel', 'scripts')).filter((d) => d.startsWith('dry-')).length, 0, 'the dry run left nothing behind');

  const made = await call({ action: 'create', name: 'build', source: src(path), dispatch: { agent: 'ada', prompt: 'report the build' } });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.trigger.source.type, 'check');
  assert.equal(made.trigger.source.script.file, 'check.sh');
  assert.match(made.hint, /first check runs now/);
  assert.match(made.hint, /do not poll/);

  const got = await call({ action: 'get', id: made.trigger.id });
  assert.equal(got.check.checks, 0);
  assert.match(got.describe, /check once, every 15s until/);
});

test('a script edited after its dry run needs another one', async () => {
  const path = script('edit.sh', 'echo \'{"ready": false}\'');
  assert.equal((await call({ action: 'dry_run', source: src(path) })).ok, true);
  appendFileSync(join(work, path), '# changed\n');
  const r = await call({ action: 'create', name: 'edit', source: src(path), dispatch: { agent: 'ada', prompt: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no successful dry run/);
});

test('a failing dry run says why and does not count', async () => {
  const path = script('bad.py', 'print("hello")');
  const dry = await call({ action: 'dry_run', source: src(path) });
  assert.equal(dry.ok, false);
  assert.match(dry.error, /not JSON/);
  assert.match(dry.next, /Fix the script/);
  const r = await call({ action: 'create', name: 'bad', source: src(path), dispatch: { agent: 'ada', prompt: 'x' } });
  assert.match(r.error, /no successful dry run/);
});

test('the rules apply to the dry run already: deadline, interval, refused commands', async () => {
  const path = script('ok.sh', 'echo \'{"ready": true}\'');
  assert.match((await call({ action: 'dry_run', source: src(path, { deadline: undefined }) })).error, /needs a deadline/);
  assert.match((await call({ action: 'dry_run', source: src(path, { mode: 'watch', interval: '10s', deadline: undefined }) })).error, /below the 60 s minimum/);
  const restart = script('restart.sh', 'somora server restart\necho \'{"ready": true}\'');
  assert.match((await call({ action: 'dry_run', source: src(restart) })).error, /refused/);
  const ready = await call({ action: 'dry_run', source: src(path) });
  assert.match(ready.verdict, /reads the data wrongly/, 'a once check that is ready right away says so');
});

test('update: a new script needs its dry run, then replaces the copy and is noted in the history', async () => {
  const v1 = script('up.sh', 'echo \'{"ready": false}\'');
  await call({ action: 'dry_run', source: src(v1, { mode: 'watch', interval: '1m', deadline: undefined }) });
  const made = await call({ action: 'create', name: 'up', source: src(v1, { mode: 'watch', interval: '1m', deadline: undefined }), dispatch: { agent: 'ada', prompt: 'x' } });
  assert.equal(made.ok, true, JSON.stringify(made));
  const id = made.trigger.id;
  const v2 = script('up2.sh', 'echo \'{"ready": true, "summary": "v2"}\'');
  const watch2 = src(v2, { mode: 'watch', interval: '5m', deadline: undefined });
  assert.match((await call({ action: 'update', id, source: watch2 })).error, /no successful dry run/);
  await call({ action: 'dry_run', source: watch2 });
  const up = await call({ action: 'update', id, source: watch2, prompt: 'new prompt' });
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.deepEqual(up.changed, ['prompt', 'script']);
  const got = await call({ action: 'get', id });
  assert.equal(got.trigger.source.interval, '5m');
  assert.equal(got.trigger.dispatch.prompt, 'new prompt');
  assert.notEqual(got.trigger.source.script.sha256, made.trigger.source.script.sha256);
  const hist = await getHistory(id, 10);
  assert.equal(hist[0]!.outcome, 'updated');
  assert.match(hist[0]!.note ?? '', /prompt, script by ada/);
  // test = a dry run of the copy, without touching the state folder
  const t = await call({ action: 'test', id });
  assert.equal(t.ok, true);
  assert.equal(t.answer.summary, 'v2');
  assert.deepEqual(readdirSync(checkStateDir(id)), [], 'state folder untouched');
});

test('Art 2: the decision block is offered and accepted only with a decision model', async () => {
  const plain = sentinel.forContext!({ agent: 'ada', config } as never);
  const judged = sentinel.forContext!({ agent: 'ada', config: withModel } as never);
  assert.doesNotMatch(plain.description!, /JUDGED CHECK/);
  assert.match(judged.description!, /JUDGED CHECK/);
  assert.match(judged.description!, /only items that are NEW/);
  const hasDecision = (j: Record<string, any>) => JSON.stringify(j).includes('"decision"');
  assert.equal(hasDecision(plain.jsonSchema!), false);
  assert.equal(hasDecision(judged.jsonSchema!), true);
  const path = script('mail.py', 'import json\nprint(json.dumps({"data": []}))');
  const decision = { questions: { urgent: { type: 'boolean', instructions: 'Needs an answer today?' } }, wake: { question: 'urgent', minProbability: 0.8 } };
  const r = await call({ action: 'dry_run', source: src(path, { mode: 'watch', interval: '5m', deadline: undefined, decision }) });
  assert.match(r.error, /none is configured/);
  const ok = await call({ action: 'dry_run', source: src(path, { mode: 'watch', interval: '5m', deadline: undefined, decision }) }, { agent: 'ada', session: 'main', config: withModel } as never);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(ok.verdict, /data is empty/);
  void existsSync;
});
