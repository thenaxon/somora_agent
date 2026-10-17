// The life of an external agent's connection (src/external/connection.ts),
// against the fake ACP agent:
//   - the idle sweeper leaves a connection alone while a turn runs, however
//     long it takes (a permission question waiting for the person), and the
//     idle clock starts when the turn ends;
//   - Stop pressed while the connection or the agent's session is still
//     being set up ends the turn as stopped and sends no prompt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, type Config } from '../config/types.ts';
import { runExternalTurn } from '../engine/acp-external.ts';
import type { SessionMetaStore } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { closeAllExternal, connectionSnapshot, sweepExternal } from './connection.ts';
import { getExternalAgent } from './registry.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-acp-agent.mjs');
const cmd = (env = '') => `${env} ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config(agents: Record<string, { command: string }>): Config {
  return ConfigSchema.parse({ providers: {}, external: { systems: { lab: { transport: { local: true }, agents } } } });
}

function memStore(): SessionMetaStore & { data: Map<string, Record<string, unknown>> } {
  const data = new Map<string, Record<string, unknown>>();
  const k = (a: string, s: string) => `${a}/${s}`;
  return {
    data,
    async get(a: string, s: string) { return { ...(data.get(k(a, s)) ?? {}) }; },
    async set(a: string, s: string, m: Record<string, unknown>) { data.set(k(a, s), { ...m }); },
    async update(a: string, s: string, merge: (m: Record<string, unknown>) => Record<string, unknown>) { const next = merge({ ...(data.get(k(a, s)) ?? {}) }); data.set(k(a, s), next); return next; },
  } as never;
}

async function turn(
  cfg: Config,
  agent: string,
  session: string,
  text: string,
  opts: { store: ReturnType<typeof memStore>; signal?: AbortSignal; onPermission?: () => Promise<'allow' | 'deny'> },
): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const ev of runExternalTurn({
    ext: getExternalAgent(agent, cfg)!,
    session,
    text,
    ...(opts.signal ? { signal: opts.signal } : {}),
    metaStore: opts.store,
    config: () => cfg,
    onPermission: async (req) => {
      const want = (await opts.onPermission?.()) === 'allow' ? 'allow_once' : 'reject_once';
      return { outcome: { outcome: 'selected', optionId: req.options.find((o) => o.kind === want)!.optionId } };
    },
  })) events.push(ev);
  return events;
}
const finalText = (evs: NormalizedEvent[]) => (evs.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined)?.text;
const open = (agent: string) => connectionSnapshot().filter((c) => c.agent === agent).length;

after(() => closeAllExternal());

test('the idle sweeper does not close a connection whose turn is still running, however long it waits', async () => {
  const cfg = config({ patient: { command: cmd() } });
  const store = memStore();
  // The agent asks for permission; while the question waits, the sweeper
  // runs as if idleMinutes had long passed.
  const evs = await turn(cfg, 'patient', 's', 'needs permission', {
    store,
    onPermission: async () => {
      await sleep(200);
      sweepExternal(0, Date.now() + 60 * 60_000);
      await sleep(200);
      return 'allow';
    },
  });
  assert.ok(!evs.some((e) => e.kind === 'error'), `no error: ${JSON.stringify(evs.filter((e) => e.kind === 'error'))}`);
  assert.equal(finalText(evs), 'allowed');
  assert.equal(open('patient'), 1, 'the connection is still open');
});

test('a streaming turn longer than idleMinutes is not cut off', async () => {
  const cfg = config({ streamer: { command: cmd() } });
  const store = memStore();
  const ctl = new AbortController();
  const running = turn(cfg, 'streamer', 's', 'be slow', { store, signal: ctl.signal });
  await sleep(700);
  sweepExternal(0, Date.now() + 60 * 60_000);
  await sleep(300);
  assert.equal(open('streamer'), 1, 'still open in the middle of the turn');
  ctl.abort();
  const evs = await running;
  assert.ok(!evs.some((e) => e.kind === 'error'), 'stopped, not failed');
  assert.match(String(finalText(evs)), /^0 1 /);
});

test('the idle clock starts when the turn ends', async () => {
  const cfg = config({ idler: { command: cmd() } });
  const store = memStore();
  await turn(cfg, 'idler', 's', 'remember finch', { store });
  sweepExternal(10 * 60_000, Date.now() + 5 * 60_000);
  assert.equal(open('idler'), 1, 'five minutes after the turn: still open');
  sweepExternal(10 * 60_000, Date.now() + 11 * 60_000);
  assert.equal(open('idler'), 0, 'eleven minutes after the turn: closed as idle');
});

test('Stop while the connection is still being opened: the turn ends as stopped and no prompt is sent', async () => {
  // FAKE_INIT_DELAY_MS holds the agent's answer to initialize.
  const cfg = config({ sleepy: { command: cmd('FAKE_INIT_DELAY_MS=1500') } });
  const store = memStore();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 300);
  const t0 = Date.now();
  const evs = await turn(cfg, 'sleepy', 's', 'remember otter', { store, signal: ctl.signal });
  assert.ok(Date.now() - t0 < 1200, `the stop is not held up by the setup (${Date.now() - t0} ms)`);
  assert.equal(finalText(evs), '[somora] aborted by user');
  assert.ok(!evs.some((e) => e.kind === 'error'), 'a stop is not an error');
  assert.equal(evs.at(-1)?.kind, 'turn_end');
  // The setup finished in the background; the prompt never reached the
  // agent — it has nothing remembered.
  await sleep(1500);
  assert.equal(finalText(await turn(cfg, 'sleepy', 's', 'recall', { store })), 'you said nothing');
});

test('Stop while the agent sets up its session: the turn ends as stopped and no prompt is sent', async () => {
  // FAKE_SESSION_DELAY_MS holds the answer to session/new.
  const cfg = config({ slowsession: { command: cmd('FAKE_SESSION_DELAY_MS=1500') } });
  const store = memStore();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 400);
  const t0 = Date.now();
  const evs = await turn(cfg, 'slowsession', 's', 'remember badger', { store, signal: ctl.signal });
  assert.ok(Date.now() - t0 < 1200, `the stop is not held up by the setup (${Date.now() - t0} ms)`);
  assert.equal(finalText(evs), '[somora] aborted by user');
  assert.ok(!evs.some((e) => e.kind === 'error'));
  // The session that was being set up is kept for the next turn.
  await sleep(1500);
  assert.match(String(store.data.get('slowsession/s')?.externalSessionId), /^fake-/);
  assert.equal(finalText(await turn(cfg, 'slowsession', 's', 'recall', { store })), 'you said nothing');
});

test('a turn right after one stopped during setup uses the session that setup makes, not a second one', async () => {
  const cfg = config({ hasty: { command: cmd('FAKE_SESSION_DELAY_MS=800') } });
  const store = memStore();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 200);
  await turn(cfg, 'hasty', 's', 'remember lynx', { store, signal: ctl.signal });
  // The next message at once, while the first setup still runs.
  const evs = await turn(cfg, 'hasty', 's', 'remember wolf', { store });
  assert.equal(finalText(evs), 'ok, wolf');
  assert.ok(!evs.some((e) => e.kind === 'engine_meta'), 'no "new session" note');
  assert.equal(finalText(await turn(cfg, 'hasty', 's', 'recall', { store })), 'you said wolf');
  assert.match(String(store.data.get('hasty/s')?.externalSessionId), /^fake-1-/, 'only one session was made on the other side');
});

test('a signal stopped before the turn starts sends nothing', async () => {
  const cfg = config({ early: { command: cmd() } });
  const store = memStore();
  const ctl = new AbortController();
  ctl.abort();
  const evs = await turn(cfg, 'early', 's', 'remember mole', { store, signal: ctl.signal });
  assert.equal(finalText(evs), '[somora] aborted by user');
  assert.equal(finalText(await turn(cfg, 'early', 's', 'recall', { store })), 'you said nothing');
});
