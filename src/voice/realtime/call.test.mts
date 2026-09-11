// A voice call, driven by a scripted provider (2026-09-11).
//
// Run: npx tsx src/voice/realtime/call.test.mts
//
// What is worth pinning here is not "audio works" — that needs a phone.
// It is the contract between the talking model and the working agent:
// the question reaches the RIGHT session as the agent's own voice
// channel and not as agent mail, the spoken conversation is readable
// afterwards, and every way the middle can break leaves the call alive.
import assert from 'node:assert/strict';

import { VoiceCall, type ConsultResult, type VoiceCallDeps } from './call.ts';
import { CONSULT_TOOL_NAME } from './consult.ts';
import { FakeRealtimeProvider, type FakeScriptStep } from './fake-provider.ts';
import { buildVoiceInstructions } from './persona.ts';
import type { Persona } from '../../persona/loader.ts';
import type { NormalizedEvent } from '../../types/events.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

const persona = (over: Partial<Persona> = {}): Persona =>
  ({
    name: 'hans',
    description: 'Engineer. Baut und prüft, redet knapp.',
    icon: undefined,
    model: 'fable',
    fallback: [],
    thinking: undefined,
    sampling: undefined,
    workspace: undefined,
    resourceDeny: [],
    skillGating: undefined,
    toolGating: undefined,
    rem: undefined,
    imageReview: undefined,
    voice: { enabled: true, maxSpokenSentences: 4, style: 'trocken, kein Smalltalk' },
    systemPrompt: 'you are hans',
    ...over,
  }) as Persona;

interface Harness {
  call: VoiceCall;
  provider: FakeRealtimeProvider;
  events: NormalizedEvent[];
  consults: Array<{ agent: string; session: string; text: string }>;
}

function harness(
  script: FakeScriptStep[],
  consult: (args: { agent: string; session: string; text: string }) => Promise<ConsultResult>,
  p: Persona = persona(),
): Harness {
  const provider = new FakeRealtimeProvider(script);
  const events: NormalizedEvent[] = [];
  const consults: Array<{ agent: string; session: string; text: string }> = [];
  const deps: VoiceCallDeps = {
    provider,
    runConsult: async (args) => {
      consults.push(args);
      return consult(args);
    },
    appendEvent: async (_a, _s, ev) => { events.push(ev); },
  };
  const call = new VoiceCall(
    { agent: 'hans', session: '20260911-120000_projektA', slug: 'projektA' },
    p,
    { model: 'fake-realtime', voice: 'marin', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    deps,
  );
  return { call, provider, events, consults };
}

const drain = async (call: VoiceCall): Promise<void> => { for await (const _ of call.run()) { /* states */ } };

// ── the normal path: hear, ask the agent, speak the answer ───────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'Wie weit ist der Umbau?', final: true } },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c1', name: CONSULT_TOOL_NAME, args: JSON.stringify({ question: 'Wie weit ist der Umbau?' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'model_transcript', ts: 4, text: 'Der Umbau ist fertig, die Tests laufen.', final: true } },
    { emit: { kind: 'closed', ts: 5, reason: 'hung up' } },
  ];
  const h = harness(script, async () => ({ text: 'Umbau fertig. Tests laufen noch, 3 von 40 offen.', outcome: 'completed' }));
  await drain(h.call);

  check('the agent was asked exactly once', h.consults.length === 1, String(h.consults.length));
  check('in the BOUND session', h.consults[0]?.session === '20260911-120000_projektA', String(h.consults[0]?.session));
  check('the question reached the agent', h.consults[0]?.text.includes('Wie weit ist der Umbau?') === true);
  check(
    'framed as the agent\'s own voice channel, not as agent mail',
    /voice call/i.test(h.consults[0]?.text ?? '') && !/Message from agent/i.test(h.consults[0]?.text ?? ''),
    h.consults[0]?.text.slice(0, 120),
  );
  check(
    'the agent\'s answer went back to the talking model',
    h.provider.lastSession?.toolResults[0]?.result.includes('3 von 40') === true,
    JSON.stringify(h.provider.lastSession?.toolResults),
  );
  const spoken = h.events.filter((e) => e.kind === 'user_message');
  check('the spoken question is in the session', spoken.length === 1 && (spoken[0] as { text: string }).text === 'Wie weit ist der Umbau?');
  check(
    'marked as voice, so a reader sees it was said, not typed',
    (spoken[0] as unknown as { input?: { modality?: string } }).input?.modality === 'voice',
  );
  const said = h.events.filter((e) => e.kind === 'engine_meta');
  check('what was SAID is kept apart from what the agent wrote', said.length === 1, String(said.length));
  check('the call counted its consults', h.call.snapshot().consults === 1);
}

// ── a consult that fails must not kill the call ──────────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: CONSULT_TOOL_NAME, args: JSON.stringify({ question: 'Status?' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c2', name: CONSULT_TOOL_NAME, args: JSON.stringify({ question: 'Und jetzt?' }) } },
    { awaitToolResult: 'c2' },
    { emit: { kind: 'closed', ts: 4, reason: 'hung up' } },
  ];
  let first = true;
  const h = harness(script, async () => {
    if (first) { first = false; throw new Error('model backend refused'); }
    return { text: 'Jetzt geht es wieder.' };
  });
  await drain(h.call);
  const results = h.provider.lastSession?.toolResults ?? [];
  check('the failure was told to the talking model', results[0]?.result.includes('failed') === true, results[0]?.result);
  check('and it names the cause', results[0]?.result.includes('model backend refused') === true);
  check('the call carried on and asked again', results.length === 2 && results[1]?.result.includes('wieder') === true);
}

// ── a cut-off tool call is answered, not executed ────────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: CONSULT_TOOL_NAME, args: '{"question": "Wie weit ist ' } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 3, reason: 'hung up' } },
  ];
  const h = harness(script, async () => ({ text: 'should not be reached' }));
  await drain(h.call);
  check('no turn was run on a broken call', h.consults.length === 0, String(h.consults.length));
  check(
    'the model was told to ask again',
    h.provider.lastSession?.toolResults[0]?.result.includes('ask again') === true,
    h.provider.lastSession?.toolResults[0]?.result,
  );
}

// ── an unknown tool cannot wedge the conversation ────────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: 'somora_switch_target', args: '{"agent":"lisa"}' } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 3, reason: 'hung up' } },
  ];
  const h = harness(script, async () => ({ text: 'nope' }));
  await drain(h.call);
  check('an unlisted tool is refused', h.provider.lastSession?.toolResults[0]?.result.includes('unknown tool') === true);
  check('and the session target was never touched', h.consults.length === 0);
}

// ── an empty answer must not become an invented one ──────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: CONSULT_TOOL_NAME, args: JSON.stringify({ question: 'Status?' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 3, reason: 'hung up' } },
  ];
  const h = harness(script, async () => ({ text: '   ', outcome: 'degraded' }));
  await drain(h.call);
  check(
    'silence is reported as silence',
    h.provider.lastSession?.toolResults[0]?.result.includes('do not invent') === true,
    h.provider.lastSession?.toolResults[0]?.result,
  );
}

// ── a watcher sees everything, and does not steal it ────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'Status?', final: true } },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c1', name: CONSULT_TOOL_NAME, args: JSON.stringify({ question: 'Status?' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 4, reason: 'hung up' } },
  ];
  const provider = new FakeRealtimeProvider(script);
  const seen: string[] = [];
  const consultsRun: string[] = [];
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid', slug: 'main' },
    persona(),
    { model: 'm', voice: 'v', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async ({ text }) => { consultsRun.push(text); return { text: 'fertig' }; },
      appendEvent: async () => {},
      onEvent: (ev) => seen.push(ev.kind),
    },
  );
  await drain(call);
  // The regression this pins: a second reader of the provider stream
  // does not mirror it, it takes half. The watcher must see every event
  // AND the call must still do its work.
  check('the watcher saw every event', seen.join(',') === 'ready,user_transcript,tool_call,closed', seen.join(','));
  check('while the call still ran the turn', consultsRun.length === 1, String(consultsRun.length));
}

// ── the instructions the talking model is given ──────────────────────
{
  const built = buildVoiceInstructions({
    persona: persona(),
    consultPolicy: 'always',
    language: 'de',
    consultToolName: CONSULT_TOOL_NAME,
    sessionSlug: 'projektA',
  });
  // Rene, 2026-09-11: asked who he was, the voice self looked its own
  // name up and then said "ich bin hans und nicht er". Identity is its
  // own; only the work belongs to the agent.
  check('it IS the agent, in the first person', built.text.includes('You are hans, speaking out loud'));
  check('it is told not to speak about the agent as someone else', /never talk about hans as someone else/i.test(built.text));
  check('and not to narrate the lookup as asking a third party', /not asking someone else/i.test(built.text));
  check('identity needs no lookup', /who you are.*need no call/i.test(built.text) || /Answer it yourself/i.test(built.text));
  check('it carries the agent\'s own character', built.text.includes('Engineer'));
  check('it carries the spoken style', built.text.includes('trocken'));
  check('it is forbidden to invent', /never invent/i.test(built.text));
  check('it must ask before answering anything of substance', built.text.includes(CONSULT_TOOL_NAME));
  check('it knows it cannot change target', /cannot switch to another agent or session/i.test(built.text));
  check('the name leads the answer', /Asked who you are: "Ich bin hans"/i.test(built.text));
  // An instruction that comments on the answer gets spoken aloud by a
  // small model; describe behaviour, not the rule about it.
  check('no meta-commentary the model can read out', !/headline|footnote/i.test(built.text));
  check('it does not pass itself off as a person', /not a human/i.test(built.text));
  check('facts still go through the tool', built.text.includes(CONSULT_TOOL_NAME));
  check('it is short enough to stay fast', built.chars < 1600, `${built.chars} chars`);
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
