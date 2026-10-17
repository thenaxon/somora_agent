// The sentinel routes for check triggers: the list and a single trigger
// carry the check counts, the script is readable (and flagged when it
// was changed), and test answers with a dry run instead of a fire.
import '../../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConfigSchema } from '../../config/types.ts';
import { prepareCheckSource } from '../../sentinel/check-create.ts';
import { checkScriptDir } from '../../sentinel/check-store.ts';
import { loadTriggers, saveTrigger } from '../../sentinel/store.ts';
import { setConfig } from '../server-state.ts';
import { registerSentinelRoutes } from './sentinel.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
const work = mkdtempSync(join(home, 'work-'));
const config = ConfigSchema.parse({ providers: {}, workspace: { default: work }, sentinel: { checks: { minIntervalOnceMs: 30_000 } } });
setConfig(config);
const app = new Hono();
registerSentinelRoutes(app);
const get = async (path: string, method = 'GET') => {
  const r = await app.request(path, { method });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

await loadTriggers();
const path = join(work, 'wait.sh');
writeFileSync(path, 'echo \'{"ready": false, "summary": "loading"}\'');
const p = await prepareCheckSource('wait-1', { description: 'loaded', scriptPath: path, mode: 'once', interval: '30s', deadline: '1h' }, config);
assert.equal(p.ok, true);
if (!p.ok) throw new Error('unreachable');
await saveTrigger({ id: 'wait-1', name: 'wait', ownerAgent: 'ada', source: { ...p.source, interval: '15s' }, evaluator: p.evaluator, dispatch: { agent: 'ada', session: 'main', prompt: 'go' }, createdAt: new Date().toISOString(), status: 'active', fireCount: 0, errorStreak: 0 });

test('list and single trigger carry the check view, with the interval config enforces', async () => {
  const list = await get('/sentinel/triggers');
  const t = list.body.triggers.find((x: { id: string }) => x.id === 'wait-1');
  assert.equal(t.check.checks, 0);
  assert.equal(t.check.wakes, 0);
  assert.ok(t.check.nextCheckAt);
  assert.equal(t.check.effectiveInterval, '30s', 'created at 15s, config now asks for 30s');
  const one = await get('/sentinel/triggers/wait-1');
  assert.equal(one.body.trigger.check.checks, 0);
});

test('test is a dry run for a check trigger', async () => {
  const r = await get('/sentinel/triggers/wait-1/test', 'POST');
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun.ok, true);
  assert.equal(r.body.dryRun.answer.summary, 'loading');
});

test('the script is readable, and flagged once changed', async () => {
  const a = await get('/sentinel/triggers/wait-1/script');
  assert.equal(a.body.matches, true);
  assert.match(a.body.text, /loading/);
  appendFileSync(join(checkScriptDir('wait-1'), 'check.sh'), '# x\n');
  const b = await get('/sentinel/triggers/wait-1/script');
  assert.equal(b.body.matches, false);
  assert.equal((await get('/sentinel/triggers/nope/script')).status, 404);
});
