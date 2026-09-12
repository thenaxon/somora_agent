// Who may start a call, and how many at once (2026-09-12).
//
// Run: npx tsx src/voice/realtime/manager.test.mts
//
// The call machine is tested next door with a scripted provider. What
// the manager owns is the decision BEFORE any of that: is the feature
// on, may this agent be called at all, and is somebody already on the
// line. Each of those is a gate that costs money when it fails open — a
// realtime connection is billed per minute of standing, not per word.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SOMORA_HOME_DIR } from '../../server/logger.ts';
import { VoiceCallManager } from './manager.ts';
import { FakeRealtimeProvider, type FakeScriptStep } from './fake-provider.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

// Two agents on disk: one that may be called, one that may not.
async function writeAgent(name: string, voice: boolean): Promise<void> {
  const dir = join(SOMORA_HOME_DIR, 'agents', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'agent.yaml'),
    [
      `description: ${name} the tester`,
      'model: fake',
      ...(voice ? ['voice:', '  enabled: true', '  voice: marin'] : []),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(dir, 'AGENTS.md'), `You are ${name}.\n`, 'utf8');
}

await writeAgent('hans', true);
await writeAgent('lisa', true);
await writeAgent('stumm', false);

// A script that does nothing: these calls are opened and hung up, never
// spoken into.
const idle: FakeScriptStep[] = [{ emit: { kind: 'ready', ts: 1 } }];

const config = {
  realtimeVoice: {
    enabled: true,
    provider: 'openai' as const,
    model: 'fake-realtime',
    transport: 'websocket' as const,
    defaultVoice: 'marin',
    consultPolicy: 'always' as const,
    maxCallMinutes: 20,
    allowAgentSwitch: true,
  },
};

const manager = (): VoiceCallManager =>
  new VoiceCallManager({
    config: config as never,
    provider: new FakeRealtimeProvider(idle),
    runConsult: async () => ({ text: 'x' }),
    listAgentNames: async () => ['hans', 'lisa', 'stumm'],
  } as never);

// ── the third gate: who appears in the picker ───────────────────────
{
  const m = manager();
  const callable = await m.callableAgents(['hans', 'lisa', 'stumm']);
  check('agents with a voice are callable', callable.includes('hans') && callable.includes('lisa'), callable.join(','));
  check('an agent without one never appears', !callable.includes('stumm'), callable.join(','));
}

// ── one person, one somora, one conversation ────────────────────────
// A second window used to open a second paid connection writing into
// the same sessions as the first, with nothing to say so (Rene,
// 2026-09-12: "1 user 1 somora 1 gespräch per voice").
{
  const m = manager();
  const first = await m.start({ agent: 'hans', session: 'main' });
  check('the first call starts', first.call.snapshot().target.agent === 'hans');

  let refusal = '';
  try {
    await m.start({ agent: 'lisa', session: 'main' });
  } catch (err) {
    refusal = (err as Error).message;
  }
  check('a second call is refused', refusal.length > 0, refusal);
  check('and the refusal says who is on the line', /hans/.test(refusal), refusal);
  check('the running call is untouched', m.list().length === 1, String(m.list().length));

  // Hanging up frees the line again.
  await m.stop(first.call.id, 'test');
  const second = await m.start({ agent: 'lisa', session: 'main' });
  check('after hanging up, the next call starts', second.call.snapshot().target.agent === 'lisa');
  await m.stop(second.call.id, 'test');
}

// ── an agent without a voice cannot be called directly ──────────────
// The picker hides it; the route must refuse it too, or the gate is
// decoration.
{
  const m = manager();
  let refusal = '';
  try {
    await m.start({ agent: 'stumm', session: 'main' });
  } catch (err) {
    refusal = (err as Error).message;
  }
  check('starting a call with a voiceless agent fails', /has no voice/.test(refusal), refusal);
}

// ── the feature switch ──────────────────────────────────────────────
{
  const off = new VoiceCallManager({
    config: { realtimeVoice: { ...config.realtimeVoice, enabled: false } } as never,
    provider: new FakeRealtimeProvider(idle),
    runConsult: async () => ({ text: 'x' }),
    listAgentNames: async () => ['hans'],
  } as never);
  check('nobody is callable while it is off', (await off.callableAgents(['hans'])).length === 0);
  let refusal = '';
  try {
    await off.start({ agent: 'hans', session: 'main' });
  } catch (err) {
    refusal = (err as Error).message;
  }
  check('and no call can be started', /realtime voice is off/.test(refusal), refusal);
}

// ── the endpoint is configuration, not a constant ───────────────────
// The adapter is the protocol, not the vendor. A service of your own
// that speaks the same session and event language plugs in here rather
// than getting a second adapter (Rene, 2026-09-12).
{
  const { OpenAiRealtimeProvider } = await import('./openai-provider.ts');
  const seen: string[] = [];
  const headersSeen: Array<Record<string, string>> = [];
  const fakeSocket = () => ({
    on(event: string, cb: (...a: never[]) => void) { if (event === 'open') setTimeout(() => (cb as () => void)(), 0); },
    send() {},
    close() {},
  });
  const req = { model: 'my-voice-model', voice: 'marin', instructions: 'x', language: 'de', tools: [] } as never;

  const local = new OpenAiRealtimeProvider({
    url: 'ws://127.0.0.1:8787/realtime',
    connect: (url: string, headers: Record<string, string>) => {
      seen.push(url); headersSeen.push(headers); return fakeSocket() as never;
    },
  });
  await local.open(req);
  check('it connects where it was told', seen[0]?.startsWith('ws://127.0.0.1:8787/realtime') === true, seen[0]);
  check('and still names the model', seen[0]?.includes('model=my-voice-model') === true, seen[0]);
  // A service on localhost has no key to give, and demanding one would
  // make the override useless.
  check('no key, no Authorization header', Object.keys(headersSeen[0] ?? {}).length === 0, JSON.stringify(headersSeen[0]));

  const withKey = new OpenAiRealtimeProvider({
    url: 'wss://voice.example.internal/v1/realtime',
    apiKey: 'secret',
    connect: (url: string, headers: Record<string, string>) => {
      seen.push(url); headersSeen.push(headers); return fakeSocket() as never;
    },
  });
  await withKey.open(req);
  check('a key is sent when there is one', headersSeen[1]?.Authorization === 'Bearer secret', JSON.stringify(headersSeen[1]));

  // OpenAI's own endpoint still insists on a credential.
  let refusal = '';
  try {
    await new OpenAiRealtimeProvider({ connect: () => fakeSocket() as never }).open(req);
  } catch (err) {
    refusal = (err as Error).message;
  }
  check('OpenAI without a key is still refused', /no realtime key/.test(refusal), refusal);
}

// ── a local provider needs to say where ─────────────────────────────
{
  const m = new VoiceCallManager({
    config: { realtimeVoice: { ...config.realtimeVoice, provider: 'local' } } as never,
    runConsult: async () => ({ text: 'x' }),
    listAgentNames: async () => ['hans'],
  } as never);
  let refusal = '';
  try {
    await m.start({ agent: 'hans', session: 'main' });
  } catch (err) {
    refusal = (err as Error).message;
  }
  check('local without a url is refused, by name', /needs realtimeVoice\.url/.test(refusal), refusal);
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
