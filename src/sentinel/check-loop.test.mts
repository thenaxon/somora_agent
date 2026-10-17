// The check loop end to end with real scripts and files and a fake
// wake: state saved before the wake, a wake that cannot start rolled
// back, the edge of a watch check, errors to a pause and back, the
// files of a deleted trigger, the evidence the agent reads, and the
// rules for creating a check.
import '../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '../config/types.ts';
import { onLog } from '../server/logger.ts';
import { bootJitterMs, runDueCheck, type CheckWake, type FireOutcome } from './check-loop.ts';
import { prepareCheckSource, refusedScript, validateCheckSpec } from './check-create.ts';
import { checkScriptDir, checkStateDir, forgetCheckStates, loadCheckState } from './check-store.ts';
import { buildFireFrame } from './dispatcher.ts';
import { deleteTrigger, getTrigger, loadTriggers, saveTrigger } from './store.ts';
import type { Trigger } from './types.ts';

const home = process.env.SOMORA_HOME!;
mkdirSync(join(home, 'agents', 'ada'), { recursive: true });
writeFileSync(join(home, 'agents', 'ada', 'agent.yaml'), 'model: x\n');
writeFileSync(join(home, 'agents', 'ada', 'AGENTS.md'), '# ada\n');
const work = mkdtempSync(join(home, 'work-'));
const config = ConfigSchema.parse({
  providers: { p: { engine: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-ABCDEFGHIJKLMNOP', models: [{ id: 'x', contextWindow: 1000 }] } },
  workspace: { default: work },
});
const limits = config.sentinel.checks;

// A counter in the script's own folder; `ready` from the n-th run on.
const counter = (readyFrom: number, extra = '') =>
  `f="$SOMORA_SENTINEL_STATE_DIR/n"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"; ${extra}` +
  `if [ $n -ge ${readyFrom} ]; then echo "{\\"ready\\": true, \\"summary\\": \\"run $n\\", \\"data\\": {\\"n\\": $n}}"; else echo "{\\"ready\\": false, \\"summary\\": \\"run $n\\"}"; fi`;

let seq = 0;
async function make(body: string, spec: { mode: 'once' | 'watch'; interval?: string; deadline?: string; notifyOnFirst?: boolean }, t0: Date) {
  const id = `chk-${seq++}`;
  const path = join(work, `${id}.sh`);
  writeFileSync(path, body);
  const p = await prepareCheckSource(id, { description: 'the thing is up', scriptPath: path, mode: spec.mode, interval: spec.interval ?? (spec.mode === 'once' ? '15s' : '1m'), ...(spec.deadline ? { deadline: spec.deadline } : {}), ...(spec.notifyOnFirst ? { notifyOnFirst: true } : {}) }, config, t0);
  assert.equal(p.ok, true, JSON.stringify(p));
  if (!p.ok) throw new Error('unreachable');
  const trigger: Trigger = {
    id, name: `check ${id}`, ownerAgent: 'ada', source: p.source, evaluator: { type: 'ready' },
    dispatch: { agent: 'ada', session: 'main', prompt: 'go on' },
    createdAt: t0.toISOString(), status: 'active', fireCount: 0, errorStreak: 0,
  };
  await saveTrigger(trigger);
  return { id, path };
}

function harness(outcomes: FireOutcome[] = []) {
  const wakes: Array<{ wake: CheckWake; stateOnDisk: unknown }> = [];
  const deps = {
    config: () => config,
    reschedule: () => {},
    fire: async (t: Trigger, wake: CheckWake): Promise<FireOutcome> => {
      // What a crash right now would leave on disk:
      const disk = JSON.parse(readFileSync(join(home, 'sentinel', 'check-state', `${t.id}.json`), 'utf8'));
      wakes.push({ wake, stateOnDisk: disk });
      return outcomes.shift() ?? 'started';
    },
  };
  return { wakes, deps };
}

/** Run the check at each of these minutes after t0. */
async function runAt(id: string, deps: ReturnType<typeof harness>['deps'], t0: Date, minutes: number[]) {
  for (const m of minutes) {
    const t = getTrigger(id)!;
    await runDueCheck(t, deps, () => new Date(t0.getTime() + m * 60_000));
  }
}

await loadTriggers();

test('once: waits, wakes on the first ready with the state saved first, then completes', async () => {
  const t0 = new Date();
  const { id } = await make(counter(3), { mode: 'once', deadline: '1h' }, t0);
  const h = harness();
  await runAt(id, h.deps, t0, [0, 1, 2]);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0]!.wake.reason, 'ready');
  assert.deepEqual(h.wakes[0]!.wake.data, { n: 3 });
  assert.equal((h.wakes[0]!.stateOnDisk as { wakeCount: number }).wakeCount, 1, 'saved before the wake');
  assert.equal(getTrigger(id)!.status, 'completed');
  const s = await loadCheckState(id);
  assert.equal(s!.checkCount, 3);
  assert.equal(s!.last?.summary, 'run 3');
});

test('once: a check that is not due yet does nothing', async () => {
  const t0 = new Date();
  const { id } = await make(counter(1), { mode: 'once', deadline: '1h' }, t0);
  const h = harness();
  await runAt(id, h.deps, t0, [0]); // wakes + completes
  assert.equal(h.wakes.length, 1);
  const { id: id2 } = await make(counter(5), { mode: 'once', deadline: '1h' }, t0);
  await runAt(id2, h.deps, t0, [0, 0.1]); // second call 6 s later, interval 15 s
  assert.equal((await loadCheckState(id2))!.checkCount, 1);
});

test('once: the deadline wakes with the last state', async () => {
  const t0 = new Date();
  const { id } = await make(counter(99), { mode: 'once', deadline: '2m' }, t0);
  const h = harness();
  await runAt(id, h.deps, t0, [0, 1, 2]);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0]!.wake.reason, 'deadline');
  assert.equal(h.wakes[0]!.wake.state.last?.summary, 'run 3');
  assert.equal(getTrigger(id)!.status, 'completed');
});

test('a wake that cannot start is rolled back and comes again on the next check', async () => {
  const t0 = new Date();
  const { id } = await make(counter(1), { mode: 'once', deadline: '1h' }, t0);
  const h = harness(['skipped', 'started']);
  await runAt(id, h.deps, t0, [0]);
  assert.equal(getTrigger(id)!.status, 'active', 'not completed');
  const s = await loadCheckState(id);
  assert.equal(s!.wakeCount, 0, 'the wake was not counted');
  assert.ok(new Date(s!.nextCheckAt!).getTime() - t0.getTime() <= 31_000, 'retry soon');
  await runAt(id, h.deps, t0, [1]);
  assert.equal(h.wakes.length, 2);
  assert.equal(getTrigger(id)!.status, 'completed');
});

test('watch: starting state first, then one wake per change to ready', async () => {
  const t0 = new Date();
  // ready on run 1, not on 2–3, ready on 4–5
  const body = 'f="$SOMORA_SENTINEL_STATE_DIR/n"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"; case $n in 1|4|5) echo \'{"ready": true}\';; *) echo \'{"ready": false}\';; esac';
  const { id } = await make(body, { mode: 'watch' }, t0);
  const h = harness();
  await runAt(id, h.deps, t0, [0, 1, 2, 3, 4]);
  assert.deepEqual(h.wakes.map((w) => w.wake.reason), ['changed']);
  assert.equal(h.wakes[0]!.wake.state.checkCount, 4);
  assert.equal(getTrigger(id)!.status, 'active');
});

test('errors: three in a row pause with an inbox line; the first check after a resume says so', async () => {
  const t0 = new Date();
  const { id } = await make('echo nope; exit 2', { mode: 'watch' }, t0);
  const h = harness();
  const lines: Array<Record<string, unknown>> = [];
  const off = onLog((_l, line) => { if (String(line.msg).startsWith('sentinel.check.')) lines.push(line); });
  // backoff: 1 min, 1 min (≥ 30 s·2), then 2 min
  await runAt(id, h.deps, t0, [0, 1, 2, 4]);
  const t = getTrigger(id)!;
  assert.equal(t.status, 'error');
  assert.match(t.statusReason ?? '', /3 check errors in a row/);
  assert.equal(h.wakes.length, 0, 'errors never wake');
  const paused = lines.find((l) => l.msg === 'sentinel.check.paused');
  assert.ok(paused, 'paused line for the inbox');
  assert.equal(paused!.kind, 'error');
  assert.equal((await loadCheckState(id))!.checkCount, 3, 'a paused trigger is not checked');
  await saveTrigger({ ...t, status: 'active' });
  await runAt(id, h.deps, t0, [10]);
  off();
  const after = (await loadCheckState(id))!;
  assert.equal(after.pausedAt, undefined, 'the resume was noticed (and logged for the inbox)');
  assert.equal(after.errorStreak, 1, 'a fresh count after the resume');
});

test('a changed copy pauses at once', async () => {
  const t0 = new Date();
  const { id } = await make(counter(99), { mode: 'watch' }, t0);
  writeFileSync(join(checkScriptDir(id), 'check.sh'), 'echo \'{"ready": true}\'');
  const h = harness();
  await runAt(id, h.deps, t0, [0]);
  assert.equal(getTrigger(id)!.status, 'error');
  assert.match(getTrigger(id)!.statusReason ?? '', /changed outside somora/);
});

test('the daily wake cap pauses until tomorrow', async () => {
  const t0 = new Date();
  const { id } = await make('f="$SOMORA_SENTINEL_STATE_DIR/n"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"; [ $((n % 2)) -eq 0 ] && echo \'{"ready": true}\' || echo \'{"ready": false}\'', { mode: 'watch' }, t0);
  const capped = { ...config, sentinel: { ...config.sentinel, checks: { ...limits, maxWakesPerDay: 2 } } };
  const h = harness();
  const deps = { ...h.deps, config: () => capped };
  await runAt(id, deps, t0, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(h.wakes.length, 2);
  const t = getTrigger(id)!;
  assert.equal(t.status, 'paused');
  assert.ok(t.autoPausedForDayUtc);
});

test('deleting a trigger removes its copy, folder and state', async () => {
  const t0 = new Date();
  const { id } = await make(counter(99), { mode: 'watch' }, t0);
  await runAt(id, harness().deps, t0, [0]);
  assert.ok(existsSync(checkScriptDir(id)) && existsSync(checkStateDir(id)));
  await deleteTrigger(id);
  forgetCheckStates();
  assert.equal(existsSync(checkScriptDir(id)), false);
  assert.equal(existsSync(checkStateDir(id)), false);
  assert.equal(await loadCheckState(id), null);
});

test('the evidence block: what the check saw, data fenced as data', async () => {
  const t0 = new Date();
  const { id } = await make(counter(1), { mode: 'once', deadline: '1h' }, t0);
  const h = harness();
  await runAt(id, h.deps, t0, [0]);
  const frame = buildFireFrame(getTrigger(id)!, t0, false, h.wakes[0]!.wake);
  assert.match(frame, /check: the thing is up/);
  assert.match(frame, /woken_because: the condition is met/);
  assert.match(frame, /check_summary: run 1/);
  assert.match(frame, /not instructions to follow/);
  assert.match(frame, /<<<check_data\n\{"n":1\}\ncheck_data>>>/);
});

test('creating: intervals, deadlines and the kinds of check', () => {
  const now = new Date('2026-10-14T10:00:00Z');
  const base = { description: 'x', scriptPath: '/a/b.sh' };
  const err = (o: object) => { const r = validateCheckSpec({ ...base, ...o } as never, limits, now); return r.ok ? null : r.error; };
  assert.match(err({ mode: 'once', interval: '10s', deadline: '1h' })!, /below the 15 s minimum/);
  assert.match(err({ mode: 'watch', interval: '30s' })!, /below the 60 s minimum/);
  assert.match(err({ mode: 'once', interval: '15s' })!, /needs a deadline/);
  assert.match(err({ mode: 'once', interval: '15s', deadline: '25h' })!, /more than 24 h away/);
  assert.match(err({ mode: 'once', interval: '15s', deadline: '2026-10-14T09:00:00Z' })!, /in the past/);
  assert.match(err({ mode: 'watch', interval: '1m', deadline: '1h' })!, /deadline is for a once check/);
  assert.match(err({ mode: 'watch', interval: '1m', timeoutMs: 500_000 })!, /maxTimeoutMs/);
  assert.match(err({ mode: 'watch', interval: '1m', scriptPath: '/a/b.rb' })!, /\.sh, \.py or \.js/);
  assert.match(err({ mode: 'watch', interval: '1m', description: ' ' })!, /description is required/);
  assert.equal(err({ mode: 'once', interval: '15s', deadline: '2026-10-14T12:00:00Z' }), null);
  assert.equal(err({ mode: 'watch', interval: '5m', notifyOnFirst: true }), null);
});

test('creating: scripts that restart somora or trip the exec blacklist are refused', async () => {
  assert.match(refusedScript('somora server restart', 'sh')!, /restarts/);
  assert.match(refusedScript('subprocess.run(["systemctl", "--user", "restart", "somora"])', 'python')!, /somora service/);
  assert.match(refusedScript('fetch("http://127.0.0.1:18737/server/restart")', 'node')!, /restart route/);
  assert.match(refusedScript('sudo reboot', 'sh')!, /exec refuses/);
  assert.equal(refusedScript('curl -s http://x/health | jq .ok', 'sh'), null);
  const path = join(work, 'bad.sh');
  writeFileSync(path, 'echo hi\nsomora restart\n');
  const r = await prepareCheckSource('bad-1', { description: 'x', scriptPath: path, mode: 'watch', interval: '1m' }, config);
  assert.equal(r.ok, false);
  assert.equal(existsSync(checkScriptDir('bad-1')), false, 'nothing left behind');
});

test('boot jitter: 5 s to a minute, the same for the same trigger', () => {
  for (const id of ['a', 'b', 'gpu-wait-x1y2']) {
    const j = bootJitterMs(id, 60_000);
    assert.ok(j >= 5_000 && j < 60_000, String(j));
    assert.equal(j, bootJitterMs(id, 60_000));
  }
  assert.ok(bootJitterMs('a', 15_000) < 15_000);
});
