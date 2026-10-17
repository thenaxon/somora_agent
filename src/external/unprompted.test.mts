// What an external agent sends on its own between turns
// (src/external/unprompted.ts), against the fake ACP agent:
//   - a result after the turn is written into the session as its own
//     message — a note, the tool call, the reply — and shown live;
//   - a piece right after the turn ends (within the grace time) is not;
//   - a turn starting while something is collected writes it first;
//   - a reset throws away what was collected for the old conversation,
//     and waits for a write already running;
//   - before a rename, what was collected is written (it moves along).
import '../testing/own-home.mts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { setConfig } from '../server/server-state.ts';
import { registerSessionRoutes } from '../server/routes/sessions.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, type Config } from '../config/types.ts';
import { runExternalTurn } from '../engine/acp-external.ts';
import { getHistory } from '../storage/sessions.ts';
import type { SessionMetaStore } from '../engine/types.ts';
import type { NormalizedEvent, SseEvent } from '../types/events.ts';
import { closeAgentConnections, closeAllExternal, closeExternal } from './connection.ts';
import { getExternalAgent } from './registry.ts';
import { configureUnprompted, discardUnprompted, flushUnprompted, resetUnprompted } from './unprompted.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-acp-agent.mjs');
const cmd = (ms: number) => `FAKE_LATER_MS=${ms} ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)}`;
const cfg: Config = ConfigSchema.parse({
  providers: {},
  external: {
    systems: {
      lab: {
        transport: { local: true },
        agents: {
          lobo: { command: cmd(400) },
          slowpoke: { command: cmd(400) },
          resetter: { command: cmd(400) },
          molasses: { command: cmd(200) },
          mover: { command: cmd(300) },
        },
      },
    },
  },
});
setConfig(cfg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const meta = new Map<string, Record<string, unknown>>();
const store = {
  async get(a: string, s: string) { return { ...(meta.get(`${a}/${s}`) ?? {}) }; },
  async set(a: string, s: string, m: Record<string, unknown>) { meta.set(`${a}/${s}`, { ...m }); },
  async update(a: string, s: string, f: (m: Record<string, unknown>) => Record<string, unknown>) { const n = f({ ...(meta.get(`${a}/${s}`) ?? {}) }); meta.set(`${a}/${s}`, n); return n; },
} as unknown as SessionMetaStore;

const published: Array<{ agent: string; session: string; e: SseEvent }> = [];
configureUnprompted({
  publish: async (agent, session, e) => {
    published.push({ agent, session, e });
    // A slow client: molasses's writes take a while.
    if (agent === 'molasses') await sleep(80);
  },
  quietMs: 300,
  graceMs: 200,
});
const app = new Hono();
registerSessionRoutes(app, { nextTurnPrompt: undefined as never, publish: (async () => {}) as never, resolveEffectiveModel: undefined as never, streamKey: ((a: string, s: string) => `${a}::${s}`) as never, streams: new Map() as never });
const unpromptedNotes = async (agent: string, session: string) =>
  (await getHistory(agent, session)).filter((e) => e.kind === 'engine_meta' && (e as { itemType?: string }).itemType === 'external_unprompted').length;

async function turn(agent: string, session: string, text: string): Promise<NormalizedEvent[]> {
  const evs: NormalizedEvent[] = [];
  for await (const ev of runExternalTurn({ ext: getExternalAgent(agent, cfg)!, session, text, metaStore: store, config: () => cfg, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })) evs.push(ev);
  return evs;
}

after(() => {
  resetUnprompted();
  closeAllExternal();
});

test('a result after the turn becomes its own message in the session, shown live; a straggler right after the turn is not', async () => {
  const evs = await turn('lobo', 's1', 'do it later');
  assert.equal((evs.find((e) => e.kind === 'assistant_message') as { text: string }).text, 'on it');
  await sleep(400 + 300 + 400);
  const h = await getHistory('lobo', 's1');
  const kinds = h.map((e) => e.kind);
  assert.deepEqual(kinds, ['turn_start', 'engine_meta', 'tool_call', 'tool_result', 'assistant_message', 'turn_end']);
  const note = h[1] as { itemType: string; payload: { text: string } };
  assert.equal(note.itemType, 'external_unprompted');
  assert.match(note.payload.text, /lobo wrote this on its own/);
  assert.equal((h[4] as { text: string }).text, 'the late result is ready');
  assert.ok(!JSON.stringify(h).includes('straggler'), 'the piece within the grace time is not a message');
  const live = published.filter((p) => p.agent === 'lobo' && p.session === 's1').map((p) => p.e.event);
  assert.equal(live[0], 'agent');
  assert.equal(live.at(-1), 'agent');
  assert.deepEqual(live, ['agent', 'engine_meta', 'tool', 'tool', 'chat', 'chat', 'chat', 'chat', 'agent']);
  const start = published.find((p) => p.agent === 'lobo' && p.e.event === 'agent')!.e as unknown as { data: { external: { unprompted: boolean } } };
  assert.equal(start.data.external.unprompted, true);
});

test('a turn starting while something is collected writes it first', async () => {
  await turn('slowpoke', 's2', 'later please');
  await sleep(400 + 150); // collected, not yet quiet long enough
  await flushUnprompted('slowpoke', 's2');
  const h = await getHistory('slowpoke', 's2');
  assert.equal(h.filter((e) => e.kind === 'engine_meta' && (e as { itemType?: string }).itemType === 'external_unprompted').length, 1);
  await sleep(500);
  const again = await getHistory('slowpoke', 's2');
  assert.equal(again.length, h.length, 'written once, not again when the timer would have fired');
});

test('a reset throws away what was collected for the old conversation', async () => {
  await turn('resetter', 'main', 'later, please');
  await sleep(400 + 120); // the late result is in, not yet written
  const res = await app.request('/agents/resetter/sessions/main/reset', { method: 'POST' });
  assert.equal(res.status, 200);
  await sleep(300 + 300);
  assert.equal(await unpromptedNotes('resetter', 'main'), 0, 'nothing of the old conversation in the fresh session');
});

test('discard waits for a write already running', async () => {
  await turn('molasses', 's', 'later then');
  // Wait until its write has begun (the first live event is out).
  for (let i = 0; i < 100 && !published.some((p) => p.agent === 'molasses'); i++) await sleep(20);
  assert.ok(published.some((p) => p.agent === 'molasses'), 'the write started');
  closeExternal('molasses', 's');
  await discardUnprompted('molasses', 's');
  const h = await getHistory('molasses', 's');
  assert.equal(h.at(-1)?.kind, 'turn_end', 'the running write was complete when discard returned');
});

test('before a rename, what was collected is written for every session of the agent', async () => {
  await Promise.all([turn('mover', 'a', 'later a'), turn('mover', 'b', 'later b')]);
  await sleep(300 + 120); // both collected, neither quiet long enough
  closeAgentConnections('mover');
  await flushUnprompted('mover');
  assert.equal(await unpromptedNotes('mover', 'a'), 1);
  assert.equal(await unpromptedNotes('mover', 'b'), 1);
  await sleep(500);
  assert.equal(await unpromptedNotes('mover', 'a'), 1, 'written once');
});
