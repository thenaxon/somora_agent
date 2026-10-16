// The external-agent engine against a real ACP process (a small fake agent
// on stdio, src/external/__fixtures__/fake-acp-agent.mjs): a turn, memory
// across turns on one connection, a session gone after a restart,
// permission allowed / denied, cancel, a crash in the middle, a command
// that does not start, images, and the quirks profile from the agent's
// own introduction.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigSchema, type Config } from '../config/types.ts';
import { fillCommand, runExternalTurn } from '../engine/acp-external.ts';
import { closeAllExternal, knownInfo } from './connection.ts';
import { getExternalAgent } from './registry.ts';
import type { SessionMetaStore } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';

const fake = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-acp-agent.mjs');
const node = process.execPath;
const cmd = (env = '') => `${env} ${JSON.stringify(node)} ${JSON.stringify(fake)}`.trim();

function config(agents: Record<string, { command: string }>, extra: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ providers: {}, external: { systems: { lab: { transport: { local: true }, agents, ...extra } } } });
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

async function turn(cfg: Config, agent: string, session: string, text: string, opts: { store: ReturnType<typeof memStore>; signal?: AbortSignal; permission?: 'allow' | 'deny' | 'cancel'; images?: Array<{ mimeType: string; data: string }> }) {
  const ext = getExternalAgent(agent, cfg)!;
  const events: NormalizedEvent[] = [];
  for await (const ev of runExternalTurn({
    ext,
    session,
    text,
    ...(opts.images ? { images: opts.images } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    metaStore: opts.store,
    config: () => cfg,
    onPermission: async (req) => {
      if (opts.permission === 'cancel' || !opts.permission) return { outcome: { outcome: 'cancelled' } };
      const want = opts.permission === 'allow' ? 'allow_once' : 'reject_once';
      return { outcome: { outcome: 'selected', optionId: req.options.find((o) => o.kind === want)!.optionId } };
    },
  })) events.push(ev);
  return events;
}
const finalText = (evs: NormalizedEvent[]) => (evs.find((e) => e.kind === 'assistant_message') as { text?: string } | undefined)?.text;

after(() => closeAllExternal());

test('a turn: thinking, a tool call with its result, the reply, usage — and the session id kept', async () => {
  const cfg = config({ claw: { command: cmd() } });
  const store = memStore();
  const evs = await turn(cfg, 'claw', 's1', 'hello there', { store });
  const kinds = evs.map((e) => e.kind);
  assert.equal(kinds[0], 'turn_start');
  assert.ok(kinds.includes('thinking_message'));
  assert.ok(kinds.indexOf('tool_call') < kinds.indexOf('tool_result'));
  assert.equal(finalText(evs), 'You said: hello there');
  const end = evs.find((e) => e.kind === 'turn_end') as { usage?: { context_tokens?: number; context_window?: number; tokens_in?: number } };
  assert.equal(end.usage?.context_tokens, 1234);
  assert.equal(end.usage?.context_window, 100000);
  assert.equal(end.usage?.tokens_in, 50);
  assert.match(String(store.data.get('claw/s1')?.externalSessionId), /^fake-/);
  assert.equal(knownInfo('claw')?.agentInfo?.version, '1.2.3');
});

test('the same connection carries the session: the agent remembers across turns', async () => {
  const cfg = config({ mem: { command: cmd() } });
  const store = memStore();
  assert.equal(finalText(await turn(cfg, 'mem', 's1', 'remember pelican', { store })), 'ok, pelican');
  assert.equal(finalText(await turn(cfg, 'mem', 's1', 'recall', { store })), 'you said pelican');
  // A second somora session is a second session on the other side.
  assert.equal(finalText(await turn(cfg, 'mem', 's2', 'recall', { store })), 'you said nothing');
  assert.notEqual(store.data.get('mem/s1')?.externalSessionId, store.data.get('mem/s2')?.externalSessionId);
});

test('after the connection closed, a session the agent no longer has becomes a new one, and the chat says so', async () => {
  const cfg = config({ gone: { command: cmd() } });
  const store = memStore();
  await turn(cfg, 'gone', 's1', 'remember heron', { store });
  const before = store.data.get('gone/s1')?.externalSessionId;
  closeAllExternal();
  const evs = await turn(cfg, 'gone', 's1', 'recall', { store });
  const note = evs.find((e) => e.kind === 'engine_meta' && e.itemType === 'external_session_new');
  assert.ok(note, 'a note row');
  assert.equal(finalText(evs), 'you said nothing');
  assert.notEqual(store.data.get('gone/s1')?.externalSessionId, before);
});

test('permission: allowed runs, denied does not, no answer counts as cancelled', async () => {
  const cfg = config({ perm: { command: cmd() } });
  const store = memStore();
  const yes = await turn(cfg, 'perm', 'a', 'needs permission', { store, permission: 'allow' });
  assert.equal(finalText(yes), 'allowed');
  assert.equal((yes.find((e) => e.kind === 'tool_result') as { error?: string }).error, undefined);
  const no = await turn(cfg, 'perm', 'b', 'needs permission', { store, permission: 'deny' });
  assert.equal(finalText(no), 'denied');
  assert.match(String((no.find((e) => e.kind === 'tool_result') as { error?: string }).error), /not allowed/);
  const none = await turn(cfg, 'perm', 'c', 'needs permission', { store, permission: 'cancel' });
  assert.equal(finalText(none), 'denied');
});

test('cancel stops a running turn quickly, and the session keeps working', async () => {
  const cfg = config({ slow: { command: cmd() } });
  const store = memStore();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 800);
  const t0 = Date.now();
  const evs = await turn(cfg, 'slow', 's', 'be slow', { store, signal: ctl.signal });
  assert.ok(Date.now() - t0 < 4000, `stopped in ${Date.now() - t0} ms`);
  assert.ok(evs.some((e) => e.kind === 'turn_end'));
  assert.ok(!evs.some((e) => e.kind === 'error'), 'a stop is not an error');
  assert.equal(finalText(await turn(cfg, 'slow', 's', 'remember owl', { store })), 'ok, owl');
});

test('a crash in the middle is an error with the reason, and the next turn starts the agent again', async () => {
  const cfg = config({ boom: { command: cmd() } });
  const store = memStore();
  const evs = await turn(cfg, 'boom', 's', 'please crash', { store });
  const err = evs.find((e) => e.kind === 'error') as { message?: string } | undefined;
  assert.ok(err, 'an error event');
  assert.match(String(err!.message), /exit 3|ended/);
  assert.ok(evs.some((e) => e.kind === 'turn_end'));
  const again = await turn(cfg, 'boom', 's', 'hello again', { store });
  assert.equal(finalText(again), 'You said: hello again');
});

test('a command that does not start: an error naming the agent and what it wrote', async () => {
  const cfg = config({ dead: { command: cmd('FAKE_FAIL_INIT=1') } });
  const evs = await turn(cfg, 'dead', 's', 'hi', { store: memStore() });
  const err = evs.find((e) => e.kind === 'error') as { message?: string };
  assert.match(err.message!, /dead could not be reached/);
  assert.match(err.message!, /refusing to start|exit 7/);
  const missing = config({ nope: { command: 'definitely-not-a-command-xyz' } });
  const evs2 = await turn(missing, 'nope', 's', 'hi', { store: memStore() });
  assert.match((evs2.find((e) => e.kind === 'error') as { message?: string }).message!, /not found|exit 127/);
});

test('images go along when the agent takes them', async () => {
  const cfg = config({ eye: { command: cmd() } });
  const evs = await turn(cfg, 'eye', 's', 'look', { store: memStore(), images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] });
  assert.equal(finalText(evs), 'You said: look (+1 image)');
});

test('the quirks profile comes from the agent\'s introduction; config can set it', async () => {
  const cfg = config({ oc: { command: cmd('FAKE_AGENT_NAME=openclaw-acp') } });
  await turn(cfg, 'oc', 's', 'hi', { store: memStore() });
  assert.equal(knownInfo('oc')?.profile.name, 'openclaw');
  assert.equal(knownInfo('oc')?.profile.badge, '🦞');
  const forced = config({ hm: { command: cmd() } }, { profile: 'hermes' });
  await turn(forced, 'hm', 's', 'hi', { store: memStore() });
  assert.equal(knownInfo('hm')?.profile.name, 'hermes');
});

test('{session} and {agent} in the command are filled in, safely', () => {
  assert.equal(fillCommand('openclaw acp --session agent:main:somora-{session}', { session: '20261016-1_x y', agent: 'claw' }), 'openclaw acp --session agent:main:somora-20261016-1_x-y');
  assert.equal(fillCommand('x --as {agent}; rm', { session: 's', agent: 'a;b' }), 'x --as a-b; rm');
});
