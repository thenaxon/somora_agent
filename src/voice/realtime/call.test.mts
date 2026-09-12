// A voice call, driven by a scripted provider (2026-09-11).
//
// Run: npx tsx src/voice/realtime/call.test.mts
//
// What is worth pinning here is not "audio works" — that needs a phone.
// It is the contract between the talking model and the working agent:
// the question reaches the RIGHT session as the agent's own voice
// channel and not as agent mail, it carries enough of the conversation
// to be answerable, and every way the middle can break leaves the call
// alive.
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
  consults: Array<{ agent: string; session: string; text: string; prefix?: string }>;
}

function harness(
  script: FakeScriptStep[],
  consult: (args: { agent: string; session: string; text: string }) => Promise<ConsultResult>,
  p: Persona = persona(),
): Harness {
  const provider = new FakeRealtimeProvider(script);
  const events: NormalizedEvent[] = [];
  const consults: Array<{ agent: string; session: string; text: string; prefix?: string }> = [];
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
    /voice call/i.test(h.consults[0]?.prefix ?? '') && !/Message from agent/i.test(h.consults[0]?.prefix ?? ''),
    h.consults[0]?.prefix?.slice(0, 120),
  );
  // The framing is scaffolding for the model and must not be part of
  // what the session records — that text is read later by the dream
  // phase and by the recall search.
  check(
    'and the framing is not part of the question itself',
    !/voice call/i.test(h.consults[0]?.text ?? ''),
    h.consults[0]?.text,
  );
  check(
    'the agent\'s answer went back to the talking model',
    h.provider.lastSession?.toolResults[0]?.result.includes('3 von 40') === true,
    JSON.stringify(h.provider.lastSession?.toolResults),
  );
  // What a call leaves in a session is what A2A leaves: the question
  // that reached the agent, and the answer it gave. The talking around
  // it stays in the call — written as user messages it broke three
  // readers at once (CLI replay, REM, the session lock).
  check('nothing was written into the session besides the turn', h.events.length === 0, JSON.stringify(h.events));
  check(
    'what the caller said travels WITH the question instead',
    h.consults[0]?.text.includes('Wie weit ist der Umbau?') === true,
    h.consults[0]?.text,
  );
  check('the call counted what was said to it', h.call.snapshot().spokenTurns === 1, String(h.call.snapshot().spokenTurns));
  check('the call counted its consults', h.call.snapshot().consults === 1);
}

// ── the question carries the conversation around it ──────────────────
// "what time is it" is unanswerable without knowing what the caller is
// doing. Since the spoken lines are not written into the session any
// more, the few lines before a question travel with it — which is also
// what makes the session readable afterwards.
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'ich sitz grad am deploy von somora', final: true } },
    { emit: { kind: 'model_transcript', ts: 3, text: 'verstanden, sag bescheid wenn du was brauchst', final: true } },
    { emit: { kind: 'user_transcript', ts: 4, text: 'wie spät ist es eigentlich', final: true } },
    { emit: { kind: 'tool_call', ts: 5, callId: 'c1', name: CONSULT_TOOL_NAME, args: JSON.stringify({ question: 'Wie spät ist es?' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 6, reason: 'hung up' } },
  ];
  const h = harness(script, async () => ({ text: 'Es ist 10:30, Mittwoch.' }));
  await drain(h.call);

  const asked = h.consults[0]?.text ?? '';
  const around = h.consults[0]?.prefix ?? '';
  check('the question itself is there', asked.includes('Wie spät ist es?'));
  check('and it is the ONLY thing the session records', asked.trim() === 'Wie spät ist es?', asked);
  check('what the caller was doing rides along beside it', around.includes('deploy von somora'), around);
  check('including what the voice already answered', around.includes('sag bescheid'), around);
  check('the caller is named as the speaker', /the user: ich sitz/.test(around), around);
  check('nothing of it was written into the session', h.events.length === 0, JSON.stringify(h.events));
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

// ── "how far are you?" must not start anything ──────────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: 'somora_work_status', args: '{}' } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 3, reason: 'hung up' } },
  ];
  const provider = new FakeRealtimeProvider(script);
  const consultsRun: string[] = [];
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid', slug: 'main' },
    persona(),
    { model: 'm', voice: 'v', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async ({ text }) => { consultsRun.push(text); return { text: 'x' }; },
      appendEvent: async () => {},
      sessionStatus: async () => ({ busy: true, sinceMs: 200_000, queued: 1 }),
    },
  );
  await drain(call);
  const answer = provider.lastSession?.toolResults[0]?.result ?? '';
  check('the status came back without running a turn', consultsRun.length === 0, String(consultsRun.length));
  check('and it says how long', /3 minute/.test(answer), answer);
  check('and what is waiting behind it', /1 waiting/.test(answer), answer);
}

// ── an idle session says so ─────────────────────────────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: 'somora_work_status', args: '{}' } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 3, reason: 'hung up' } },
  ];
  const provider = new FakeRealtimeProvider(script);
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid', slug: 'main' },
    persona(),
    { model: 'm', voice: 'v', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    { provider, runConsult: async () => ({ text: 'x' }), appendEvent: async () => {}, sessionStatus: async () => ({ busy: false }) },
  );
  await drain(call);
  check('nothing running is said plainly', /nothing running/.test(provider.lastSession?.toolResults[0]?.result ?? ''));
}

// ── both tools are offered, and only those ──────────────────────────
{
  const provider = new FakeRealtimeProvider([{ emit: { kind: 'closed', ts: 1, reason: 'done' } }]);
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid', slug: 'main' },
    persona(),
    { model: 'm', voice: 'v', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    { provider, runConsult: async () => ({ text: 'x' }), appendEvent: async () => {} },
  );
  await call.start();
  const names = provider.lastSession?.request.tools.map((t) => t.name) ?? [];
  check('exactly the lookup and the status tool', names.join(',') === 'somora_agent_consult,somora_work_status', names.join(','));
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

// ── handing the call to another agent ───────────────────────────────
// The caller names the session out loud, so the call honours it.
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'verbinde mich mit lisa in ihre ProjektA session', final: true } },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'lisa', session: 'projektA' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 4, reason: 'handing over' } },
  ];
  const provider = new FakeRealtimeProvider(script);
  const notes: Array<{ agent: string; session: string; text: string }> = [];
  const states: Array<{ agent: string; to?: string }> = [];
  const lisa = persona({ name: 'lisa', description: 'Researcher.' } as Partial<Persona>);
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid-hans', slug: 'main' },
    persona(),
    { model: 'm', voice: 'marin', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async () => ({ text: 'x' }),
      appendEvent: async (agent, session, ev) => {
        const payload = (ev as { payload?: { text?: string } }).payload;
        if (payload?.text) notes.push({ agent, session, text: payload.text });
      },
      callableAgents: ['hans', 'lisa', 'naxon'],
      onState: (snap) => { states.push({ agent: snap.target.agent, ...(snap.handoverTo ? { to: snap.handoverTo } : {}) }); },
      resolveTarget: async (agent, sessionRef) => ({
        persona: lisa,
        target: { agent, session: `sid-${agent}`, slug: sessionRef ?? 'main' },
        cfg: { model: 'm', voice: 'cedar', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
      }),
    },
  );
  await drain(call);

  const snap = call.snapshot();
  check('the call continues as the other agent', snap.target.agent === 'lisa', JSON.stringify(snap.target));
  check('in the session the caller named out loud', snap.target.slug === 'projektA', snap.target.slug);
  check('the old session says where it went', notes.some((n) => n.agent === 'hans' && /handed this call over to lisa/.test(n.text)), JSON.stringify(notes));
  check('and the new one where it came from', notes.some((n) => n.agent === 'lisa' && /took this call over from hans/.test(n.text)));
  check('the new voice is used', provider.lastSession?.request.voice === 'cedar', String(provider.lastSession?.request.voice));
  check('and the new persona speaks', provider.lastSession?.request.instructions.includes('You are lisa') === true);
  // The window must not put lisa's name on hans's last sentence: while
  // the new session is opening, the old agent is still the one being
  // heard (Rene, 2026-09-12: "es spricht aber noch Lisa").
  check(
    'while handing over, the call still names the agent that is talking',
    states.some((st) => st.agent === 'hans' && st.to === 'lisa'),
    JSON.stringify(states),
  );
  check(
    'and only names the new one once it is on the line',
    states.some((st) => st.agent === 'lisa' && st.to === undefined),
    JSON.stringify(states),
  );
}

// ── a session nobody asked for does not travel with the call ────────
// Live on 2026-09-12: from lisa's cerebrocraft session, "connect me to
// naxon" put the caller into naxon's cerebrocraft. The voice self knows
// which session it is in and passes that name along; nobody asked for
// it, and the other agent need not even have a session by that name.
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'verbinde mich weiter zu naxon', final: true } },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'naxon', session: 'cerebrocraft' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 4, reason: 'handing over' } },
  ];
  const provider = new FakeRealtimeProvider(script, {}, [
    { emit: { kind: 'ready', ts: 5 } },
    { emit: { kind: 'closed', ts: 6, reason: 'hung up' } },
  ]);
  const asked: Array<string | undefined> = [];
  const call = new VoiceCall(
    { agent: 'lisa', session: 'sid-lisa-cc', slug: 'cerebrocraft' },
    persona({ name: 'lisa' } as Partial<Persona>),
    { model: 'm', voice: 'marin', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async () => ({ text: 'x' }),
      appendEvent: async () => {},
      callableAgents: ['lisa', 'naxon'],
      resolveTarget: async (agent, sessionRef) => {
        asked.push(sessionRef);
        return {
          persona: persona({ name: agent } as Partial<Persona>),
          target: { agent, session: `sid-${agent}`, slug: sessionRef ?? 'main' },
          cfg: { model: 'm', voice: 'cedar', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
        };
      },
    },
  );
  await drain(call);
  check('the inherited session name was dropped', asked[0] === undefined, JSON.stringify(asked));
  check('so the call lands in the new agent\'s main session', call.snapshot().target.slug === 'main', call.snapshot().target.slug);
}

// ── the sentence arrives after the tool call ────────────────────────
// Transcription lands after the model has acted on what it heard. The
// session name in a switch is checked against what the caller said, so
// without a short wait the real live ordering would throw away exactly
// the wish it is meant to protect.
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'naxon', session: 'cerebrocraft' }) } },
    // The caller's sentence catches up only now — as it does live.
    { emit: { kind: 'user_transcript', ts: 3, text: 'bring mich zu naxon in die Cerebro Craft session', final: true } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 4, reason: 'handing over' } },
  ];
  const provider = new FakeRealtimeProvider(script, {}, [
    { emit: { kind: 'ready', ts: 5 } },
    { emit: { kind: 'closed', ts: 6, reason: 'hung up' } },
  ]);
  const asked: Array<string | undefined> = [];
  const call = new VoiceCall(
    { agent: 'lisa', session: 'sid-lisa', slug: 'main' },
    persona({ name: 'lisa' } as Partial<Persona>),
    { model: 'm', voice: 'marin', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async () => ({ text: 'x' }),
      appendEvent: async () => {},
      callableAgents: ['lisa', 'naxon'],
      resolveTarget: async (agent, sessionRef) => {
        asked.push(sessionRef);
        return {
          persona: persona({ name: agent } as Partial<Persona>),
          target: { agent, session: `sid-${agent}`, slug: sessionRef ?? 'main' },
          cfg: { model: 'm', voice: 'cedar', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
        };
      },
    },
  );
  await drain(call);
  check('the late sentence still counts as having asked', asked[0] === 'cerebrocraft', JSON.stringify(asked));
  // "Cerebro Craft" as two words is what speech recognition produces for
  // a slug written as one.
  check('and the call lands there', call.snapshot().target.slug === 'cerebrocraft', call.snapshot().target.slug);
}

// ── the same agent, a different session ─────────────────────────────
// "I wanted your cerebrocraft session" had no answer at all: the tool
// offered every agent except the one on the line (Rene, 2026-09-12).
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'geh mal in deine cerebrocraft session', final: true } },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'lisa', session: 'cerebrocraft' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 4, reason: 'handing over' } },
  ];
  const provider = new FakeRealtimeProvider(script);
  const notes: Array<{ agent: string; session: string; text: string }> = [];
  const call = new VoiceCall(
    { agent: 'lisa', session: 'sid-lisa-main', slug: 'main' },
    persona({ name: 'lisa' } as Partial<Persona>),
    { model: 'm', voice: 'marin', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async () => ({ text: 'x' }),
      appendEvent: async (agent, session, ev) => {
        const payload = (ev as { payload?: { text?: string } }).payload;
        if (payload?.text) notes.push({ agent, session, text: payload.text });
      },
      callableAgents: ['lisa', 'naxon'],
      resolveTarget: async (agent, sessionRef) => ({
        persona: persona({ name: agent } as Partial<Persona>),
        target: { agent, session: `sid-${agent}-${sessionRef ?? 'main'}`, slug: sessionRef ?? 'main' },
        cfg: { model: 'm', voice: 'marin', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
      }),
    },
  );
  await drain(call);
  const snap = call.snapshot();
  check('the agent stays the same', snap.target.agent === 'lisa', snap.target.agent);
  check('the session changed', snap.target.slug === 'cerebrocraft', snap.target.slug);
  check('the tool offered the agent itself', provider.sessions[0]?.request.tools?.some((t) => t.name === 'somora_switch_agent' && t.description.includes('lisa')) === true);
  check('both conversations record the move, not a handover', notes.length === 2 && notes.every((n) => /moved to|came over/.test(n.text)), JSON.stringify(notes));
}

// ── a move that cannot be made keeps the call alive ─────────────────
// The caller asks for a session that does not exist. Ending the call on
// a typo is the worst possible answer.
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'verbinde mich in die quartalsplanung session', final: true } },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'naxon', session: 'quartalsplanung' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 4, reason: 'handing over' } },
  ];
  // The session it comes back on does nothing but exist, then hangs up.
  const backOnTheLine: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 5 } },
    { emit: { kind: 'closed', ts: 6, reason: 'hung up' } },
  ];
  const provider = new FakeRealtimeProvider(script, {}, backOnTheLine);
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid-hans', slug: 'main' },
    persona(),
    { model: 'm', voice: 'ash', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async () => ({ text: 'x' }),
      appendEvent: async () => {},
      callableAgents: ['hans', 'naxon'],
      resolveTarget: async () => { throw new Error("naxon has no session 'quartalsplanung'"); },
    },
  );
  await drain(call);
  const snap = call.snapshot();
  check('the call is still on the line', snap.state !== 'closed' || provider.sessions.length === 2, `${snap.state} / ${provider.sessions.length}`);
  check('with the agent it had', snap.target.agent === 'hans', snap.target.agent);
  check('in the session it had', snap.target.slug === 'main', snap.target.slug);
  check('a second session was opened to come back on', provider.sessions.length === 2, String(provider.sessions.length));
}

// ── after a handover the microphone reaches the NEW agent ───────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'lisa' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 3, reason: 'handing over' } },
  ];
  const provider = new FakeRealtimeProvider(script);
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid-hans', slug: 'main' },
    persona(),
    { model: 'm', voice: 'marin', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async () => ({ text: 'x' }),
      appendEvent: async () => {},
      callableAgents: ['hans', 'lisa'],
      resolveTarget: async (agent) => ({
        persona: persona({ name: agent } as Partial<Persona>),
        target: { agent, session: `sid-${agent}`, slug: 'main' },
        cfg: { model: 'm', voice: 'cedar', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
      }),
    },
  );
  await drain(call);
  // The route feeds audio through the CALL. Before 2026-09-12 it held
  // the session it was handed at the start, so after a handover the
  // microphone fed a closed session: the window said lisa, lisa heard
  // nothing, and the call had to be restarted.
  const before = provider.lastSession;
  await call.sendAudio({ base64: 'AAAA', rateHz: 24_000 });
  check('the new session is the one being fed', provider.lastSession === before && before?.request.voice === 'cedar');
  check('and it is lisa speaking now', call.snapshot().target.agent === 'lisa');
}

// ── switching is refused where it is not allowed ────────────────────
{
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'tool_call', ts: 2, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'buffet' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 3, reason: 'hung up' } },
  ];
  const provider = new FakeRealtimeProvider(script);
  let resolved = 0;
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid', slug: 'main' },
    persona(),
    { model: 'm', voice: 'v', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    {
      provider,
      runConsult: async () => ({ text: 'x' }),
      appendEvent: async () => {},
      callableAgents: ['hans', 'lisa'],
      resolveTarget: async () => { resolved += 1; throw new Error('should not be reached'); },
    },
  );
  await drain(call);
  check('an agent without a voice is refused', provider.lastSession?.toolResults[0]?.result.includes('cannot be reached') === true);
  check('and nothing was switched', resolved === 0 && call.snapshot().target.agent === 'hans');
}

// ── without permission there is no switch tool at all ───────────────
{
  const provider = new FakeRealtimeProvider([{ emit: { kind: 'closed', ts: 1, reason: 'done' } }]);
  const call = new VoiceCall(
    { agent: 'hans', session: 'sid', slug: 'main' },
    persona(),
    { model: 'm', voice: 'v', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
    { provider, runConsult: async () => ({ text: 'x' }), appendEvent: async () => {} },
  );
  await call.start();
  const names = provider.lastSession?.request.tools.map((t) => t.name) ?? [];
  check('only the two working tools are offered', names.join(',') === 'somora_agent_consult,somora_work_status', names.join(','));
}

// ── a hand-written voice character replaces the derived one ─────────
{
  const built = buildVoiceInstructions({
    persona: persona(),
    consultPolicy: 'always',
    language: 'de',
    consultToolName: CONSULT_TOOL_NAME,
    sessionSlug: 'main',
    override: 'Ich bin knapp, ein bisschen mürrisch, und ich rede wie am Telefon mit einem Kollegen.',
  });
  // Rene has eight agents: deriving costs nothing to maintain, writing
  // by hand gives control. The override buys the second without giving
  // up the first — and the rules that keep it honest stay either way.
  check('the written character is used', built.text.includes('mürrisch'));
  check('and the derived one is gone', !built.text.includes('Engineer'));
  check('but the rules still stand', built.text.includes(CONSULT_TOOL_NAME) && /never invent/i.test(built.text));
  check('and so does the identity rule', /You are hans, speaking out loud/.test(built.text));
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
  check('it speaks the language by name, not by code', /Speak German\./.test(built.text), built.text.slice(0, 80));
  check('and may not drift out of it mid-call', /never switch language mid-call/i.test(built.text));
  check('no introductions', /do not introduce yourself/i.test(built.text));
  check('and no recital of what it can do', /do not list what you can do/i.test(built.text));
  check('identity still needs no lookup', /needs no lookup/i.test(built.text));
  // An instruction that comments on the answer gets spoken aloud by a
  // small model; describe behaviour, not the rule about it.
  check('no meta-commentary the model can read out', !/headline|footnote/i.test(built.text));
  check('it does not pass itself off as a person', /not a human/i.test(built.text));
  check('facts still go through the tool', built.text.includes(CONSULT_TOOL_NAME));
  // Rene, 2026-09-11: asked to open somora's browser, it refused on its
  // own authority instead of passing the request on.
  check('it may not judge what it can do', /not yours to judge/.test(built.text));
  check('and may not refuse a task itself', /never say you cannot do something/i.test(built.text));
  check('and may not announce a lookup instead of making it', /do not announce it/i.test(built.text));
  check('capabilities are not part of its self-knowledge', !/what you can or cannot do/i.test(built.text));
  check('it stays inside the context budget', built.chars < 1950, `${built.chars} chars`);
  check('it forwards statements, not only requests', /state or correct/i.test(built.text));
}

// ── the clock does not restart on a move ────────────────────────────
// A new provider session opens on every move, and arming the cap again
// there would make a handover a way to talk past maxCallMinutes.
{
  let now = 1_000_000;
  const script: FakeScriptStep[] = [
    { emit: { kind: 'ready', ts: 1 } },
    { emit: { kind: 'user_transcript', ts: 2, text: 'verbinde mich mit lisa', final: true } },
    { emit: { kind: 'tool_call', ts: 3, callId: 'c1', name: 'somora_switch_agent', args: JSON.stringify({ agent: 'lisa' }) } },
    { awaitToolResult: 'c1' },
    { emit: { kind: 'closed', ts: 4, reason: 'handing over' } },
  ];
  const provider = new FakeRealtimeProvider(script, {}, [
    { emit: { kind: 'ready', ts: 5 } },
    { emit: { kind: 'closed', ts: 6, reason: 'hung up' } },
  ]);
  const timers: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  // Only the call's own deadline is interesting; it is the one armed
  // with minutes, everything else here is milliseconds.
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
    if ((ms ?? 0) > 10_000) timers.push(ms ?? 0);
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout;
  try {
    const call = new VoiceCall(
      { agent: 'hans', session: 'sid-hans', slug: 'main' },
      persona(),
      { model: 'm', voice: 'ash', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
      {
        provider,
        runConsult: async () => ({ text: 'x' }),
        appendEvent: async () => {},
        callableAgents: ['hans', 'lisa'],
        now: () => now,
        resolveTarget: async (agent, sessionRef) => {
          now += 8 * 60_000; // eight minutes into the call
          return {
            persona: persona({ name: agent } as Partial<Persona>),
            target: { agent, session: `sid-${agent}`, slug: sessionRef ?? 'main' },
            cfg: { model: 'm', voice: 'cedar', language: 'de', consultPolicy: 'always', maxCallMinutes: 20 },
          };
        },
      },
    );
    await drain(call);
    check('the first session gets the whole budget', timers[0] === 20 * 60_000, String(timers[0]));
    check('the one after the move gets what is left', timers[1] === 12 * 60_000, String(timers[1]));
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
