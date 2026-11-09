// Who is on a call, and the one place a call is started and stopped.
//
// The server owns calls because the browser is a dumb terminal here:
// microphone in, speaker out, state on screen. Everything that decides
// anything — which agent, which session, which provider, which key, who
// runs a tool — lives on this side.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPersona, type Persona } from '../../persona/loader.ts';
import { SOMORA_HOME_DIR } from '../../server/logger.ts';
import { listSessions, resolveSessionId } from '../../storage/sessions.ts';
import { appendEvent } from '../../storage/sessions.ts';
import { matchSpokenSession, normalizeSpokenName } from './session-match.ts';
import { logger } from '../../server/logger.ts';
import type { Config } from '../../config/types.ts';
import {
  VoiceCall,
  type CarriedDelivery,
  type ConsultDelivery,
  type ConsultLookup,
  type ConsultResult,
  type SessionVoiceWork,
  type SessionWorkStatus,
  type VoiceCallSnapshot,
} from './call.ts';
import { onWorkFinished, onWorkFollowUp } from '../../server/work-ledger.ts';
import { CONSULT_TOOL_NAME } from './consult.ts';
import { buildVoiceInstructions } from './persona.ts';
import { OpenAiRealtimeProvider } from './openai-provider.ts';
import type { NormalizedEvent } from '../../types/events.ts';
import type { RealtimeEvent, RealtimeProvider, RealtimeSession } from './types.ts';

export interface VoiceManagerDeps {
  config: Config;
  /** Runs one turn in the bound session as `from_system: 'voice'`.
   *  `prefix` reaches the model but is not part of the record. */
  runConsult(args: { agent: string; session: string; text: string; prefix?: string; callId?: string }): Promise<ConsultResult>;
  /** Is that session busy, and for how long? Answers without waiting. */
  sessionStatus?(agent: string, session: string): Promise<SessionWorkStatus>;
  /** A handed-over consult by id (Phase 2). */
  consultResult?(consultId: string): Promise<ConsultLookup | null>;
  markConsultFetched?(consultId: string): Promise<void>;
  /** The voice consults of a session as the work ledger sees them. */
  sessionVoiceWork?(agent: string, session: string): Promise<SessionVoiceWork[]>;
  /** Puts an event on the live SSE stream of that session. */
  publishEvent?(agent: string, session: string, ev: NormalizedEvent): void;
  /** Every agent on this instance — filtered to the callable ones. */
  listAgentNames?(): Promise<string[]>;
  /** Injectable for tests. */
  provider?: RealtimeProvider;
  /** Mirrors every provider event of every call to whoever is watching
   *  it — there is only one consumer of the provider stream. */
  watcher?(callId: string): ((ev: RealtimeEvent, snap: VoiceCallSnapshot) => void) | undefined;
  /** Same, for state changes no provider event announces. */
  stateWatcher?(callId: string): ((snap: VoiceCallSnapshot) => void) | undefined;
}

export interface StartCallInput {
  agent: string;
  /** Session slug or id. Resolved before anything is opened. */
  session: string;
}

export interface ActiveCall {
  call: VoiceCall;
  session: RealtimeSession;
  persona: Persona;
}

/** How long a delivery waits for the next call on its agent and
 *  session, and how long an ended call's questions are remembered. */
const CARRY_TTL_MS = 24 * 60 * 60 * 1000;

export class VoiceCallManager {
  private calls = new Map<string, ActiveCall>();
  /** Questions of consults whose call has ended: a later delivery
   *  names the question it answers (consultId → question). */
  private endedQuestions = new Map<string, { question: string; at: number }>();
  /** Deliveries nobody could hear yet, per `agent/session`, in order. */
  private carried = new Map<string, Array<CarriedDelivery & { at: number }>>();

  constructor(private readonly deps: VoiceManagerDeps) {
    // A consult that was handed over finishes in the work ledger; the
    // call it belongs to reads it out. The ledger is the single place
    // that knows when, so this is the single subscription.
    onWorkFinished((it) => {
      if (!it.requester || !('voiceCall' in it.requester)) return;
      const res: ConsultDelivery = {
        consultId: it.id,
        state: it.state === 'done' ? 'done' : 'failed',
        ...(it.result?.finalText ? { text: it.result.finalText } : {}),
        ...(it.error ? { error: it.error } : {}),
      };
      const active = this.calls.get(it.requester.voiceCall);
      if (!active) {
        // The call hung up before the answer landed. It stays in the
        // chat; and the next call on that agent and session hears it.
        if (it.resultFetched) return;
        this.reroute(it, res);
        return;
      }
      void active.call
        .deliver(res)
        .catch((err: unknown) => logger.warn({ msg: 'voice.consult_delivery_failed', consultId: it.id, err: (err as Error).message }));
    });
    // Work a consult started (a sub, a question to another agent) that
    // finished after the answer was read out: the call hears it as a
    // follow-up (work-ledger.ts maybeFollowUp).
    onWorkFollowUp((root, fu) => {
      if (!root.requester || !('voiceCall' in root.requester)) return;
      const res: ConsultDelivery = {
        consultId: root.id,
        state: fu.failed ? 'failed' : 'done',
        text: fu.text,
        ...(fu.failed ? { error: fu.failed } : {}),
        followUp: true,
      };
      const active = this.calls.get(root.requester.voiceCall);
      if (!active) {
        // 2026-11-06: the call that asked had hit its time limit, the
        // caller was already on the next call with the same agent and
        // session, and the follow-up was dropped here.
        this.reroute(root, res);
        return;
      }
      void active.call
        .deliver(res)
        .catch((err: unknown) => logger.warn({ msg: 'voice.consult_delivery_failed', consultId: root.id, err: (err as Error).message }));
    });
  }

  /**
   * A delivery whose call is gone: to the call that is on the same
   * agent and session now, or kept until the next one is. Exactly one
   * of the two, so it is read out once.
   */
  private reroute(item: { id: string; target: { agent: string; session: string }; preview: string }, res: ConsultDelivery): void {
    const question = this.endedQuestions.get(item.id)?.question ?? item.preview;
    const live = [...this.calls.values()].find((c) => {
      const snap = c.call.snapshot();
      return snap.state !== 'closed' && snap.target.agent === item.target.agent && snap.target.session === item.target.session;
    });
    if (live) {
      logger.info({ msg: 'voice.consult_delivery_rerouted', consultId: item.id, toCall: live.call.id, followUp: res.followUp ?? false });
      void live.call
        .carryOver({ res, question })
        .catch((err: unknown) => logger.warn({ msg: 'voice.consult_delivery_failed', consultId: item.id, err: (err as Error).message }));
      return;
    }
    this.keep(item.target.agent, item.target.session, { res, question });
  }

  private keep(agent: string, session: string, item: CarriedDelivery): void {
    const key = `${agent}/${session}`;
    const now = Date.now();
    const list = (this.carried.get(key) ?? []).filter((c) => now - c.at < CARRY_TTL_MS);
    // A newer delivery for the same consult and kind replaces the older.
    const rest = list.filter((c) => !(c.res.consultId === item.res.consultId && (c.res.followUp ?? false) === (item.res.followUp ?? false)));
    rest.push({ ...item, at: now });
    this.carried.set(key, rest);
    logger.info({ msg: 'voice.consult_delivery_kept', consultId: item.res.consultId, agent, session, followUp: item.res.followUp ?? false, waiting: rest.length });
  }

  /** Taken once: the call that gets them reads them out. */
  private takeCarried(agent: string, session: string): CarriedDelivery[] {
    const key = `${agent}/${session}`;
    const list = this.carried.get(key);
    if (!list) return [];
    this.carried.delete(key);
    const now = Date.now();
    return list.filter((c) => now - c.at < CARRY_TTL_MS).map(({ res, question }) => ({ res, question }));
  }

  /** Deliveries waiting for a call on that agent and session (tests,
   *  diagnostics). */
  waitingDeliveries(agent: string, session: string): number {
    return this.carried.get(`${agent}/${session}`)?.length ?? 0;
  }

  private cfg() {
    return this.deps.config.realtimeVoice;
  }

  enabled(): boolean {
    return Boolean(this.cfg()?.enabled);
  }

  /** Agents that can be called: voice on globally, `voice.enabled` on
   *  the agent, and a model to speak with. Anything else must not show
   *  up in a picker — the third gate of an opt-in feature. */
  async callableAgents(names: readonly string[]): Promise<string[]> {
    if (!this.enabled()) return [];
    const out: string[] = [];
    for (const name of names) {
      const persona = await loadPersona(name);
      if (persona?.voice?.enabled) out.push(name);
    }
    return out;
  }

  private buildProvider(): RealtimeProvider {
    if (this.deps.provider) return this.deps.provider;
    const cfg = this.cfg();
    if (!cfg) throw new Error('realtimeVoice is not configured');
    // 'local' is the same protocol somewhere else. It gets the same
    // adapter on purpose: a second implementation of a protocol we
    // already speak would drift from this one within a week. What makes
    // it local is the endpoint, so that one is required.
    if (cfg.provider === 'local' && !cfg.url) {
      throw new Error("realtime voice provider 'local' needs realtimeVoice.url");
    }
    if (cfg.provider !== 'openai' && cfg.provider !== 'local') {
      throw new Error(`realtime voice provider '${cfg.provider}' has no adapter yet`);
    }
    return new OpenAiRealtimeProvider({
      ...(cfg.apiKeyFile ? { apiKeyFile: cfg.apiKeyFile } : {}),
      // Same adapter, different service: the protocol is what this
      // speaks, not the vendor.
      ...(cfg.url ? { url: cfg.url } : {}),
      // A local service (somora_realtimevoice) confirms a barge-in on
      // real speech itself; OpenAI's keeps the immediate cancel.
      serviceConfirmsBargeIn: cfg.provider === 'local',
    });
  }

  /** Hand-written voice character, when the operator wrote one. */
  private async voiceOverride(agent: string): Promise<string | undefined> {
    try {
      const text = await readFile(join(SOMORA_HOME_DIR, 'agents', agent, 'VOICE.md'), 'utf8');
      // Strip a frontmatter block and headings: what belongs in the
      // model's context is the prose, not the file's furniture.
      const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^#.*$/gm, '').trim();
      return body.length > 0 ? body : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The instructions a call WOULD open with, without opening one.
   *
   * The derived voice self lives nowhere on disk — it is built per call
   * from the persona plus `agent.yaml voice:` — so without this there
   * is no way to read what the model is actually told (the operator,
   * 2026-09-12: "wo lebt jetzt diese abgeleitete version … ich würd das
   * gerne sehen"). Same idea as prompt-preview for a normal turn.
   */
  async previewInstructions(agent: string, sessionSlug = 'main'): Promise<{
    text: string;
    chars: number;
    source: 'VOICE.md' | 'derived';
    voice: string;
    language: string;
    consultPolicy: string;
  } | null> {
    const cfg = this.cfg();
    const persona = await loadPersona(agent);
    if (!cfg || !persona?.voice?.enabled) return null;
    const override = await this.voiceOverride(agent);
    const consultPolicy = persona.voice.consultPolicy ?? cfg.consultPolicy;
    const language = persona.voice.language ?? this.deps.config.stt?.language ?? 'en';
    // Including who the call could be handed to — without it the preview
    // ends on "you cannot switch to another agent or session" while a
    // real call is told the opposite. A preview that differs from the
    // thing it previews is worse than none.
    const switchTo = cfg.allowAgentSwitch
      ? (await this.callableAgents((await this.deps.listAgentNames?.()) ?? [])).filter((a) => a !== agent)
      : [];
    const built = buildVoiceInstructions({
      persona,
      consultPolicy,
      language,
      consultToolName: CONSULT_TOOL_NAME,
      sessionSlug,
      ...(switchTo.length > 0 ? { switchTo } : {}),
      ...(override ? { override } : {}),
    });
    return {
      text: built.text,
      chars: built.chars,
      source: override ? 'VOICE.md' : 'derived',
      voice: persona.voice.voice ?? cfg.defaultVoice,
      language,
      consultPolicy,
    };
  }

  /**
   * Turn what the caller said into a session that exists.
   *
   * Rejects by throwing, with a sentence the voice can say out loud:
   * the whole point is that a wrong guess lands the conversation in
   * somebody else's work, so an unclear name becomes a question.
   */
  private async resolveSpokenSession(agent: string, spoken: string): Promise<string> {
    const sessions = await listSessions(agent);
    const slugs = sessions.map((s) => s.slug);
    const match = matchSpokenSession(spoken, slugs);
    if (match.kind === 'one') {
      if (normalizeSpokenName(match.slug) !== normalizeSpokenName(spoken)) {
        logger.info({ msg: 'voice.session_matched', agent, heard: spoken, slug: match.slug });
      }
      return match.slug;
    }
    if (match.kind === 'many') {
      throw new Error(
        `${agent} has more than one session that sounds like "${spoken}": ${match.candidates.join(', ')} — ask which one`,
      );
    }
    // Naming a few real ones beats "not found": the caller usually knows
    // the session by a word from it.
    const shown = ['main', ...slugs.filter((s) => s !== 'main')].slice(0, 6);
    throw new Error(`${agent} has no session like "${spoken}" — there is ${shown.join(', ')}`);
  }

  /** Everything a call needs to continue as another agent. */
  private async buildTarget(agent: string, sessionRef: string | undefined): Promise<{
    persona: Persona;
    target: { agent: string; session: string; slug: string };
    cfg: {
      model: string;
      voice: string;
      language: string;
      consultPolicy: 'auto' | 'substantive' | 'always';
      maxCallMinutes: number;
      keepTranscript?: boolean;
      personaOverride?: string;
      turnDetection?: { threshold: number; prefixPaddingMs: number; silenceDurationMs: number };
    };
  }> {
    const cfg = this.cfg();
    if (!cfg?.enabled) throw new Error('realtime voice is off');
    const persona = await loadPersona(agent);
    if (!persona) throw new Error(`agent '${agent}' not found`);
    if (!persona.voice?.enabled) throw new Error(`${agent} cannot be reached by voice`);
    // A name that came through a microphone is matched by sound-ish
    // shape, not by spelling — see session-match.ts for why every
    // attempt missed before. Only here: a typed session name anywhere
    // else in somora must still mean exactly what it says.
    const slug = sessionRef === undefined ? 'main' : await this.resolveSpokenSession(agent, sessionRef);
    const session = await resolveSessionId(agent, slug);
    if (!session) throw new Error(`${agent} has no session '${slug}'`);
    const personaOverride = await this.voiceOverride(agent);
    return {
      persona,
      target: { agent, session, slug },
      cfg: {
        model: cfg.model,
        voice: persona.voice.voice ?? cfg.defaultVoice,
        language: persona.voice.language ?? this.deps.config.stt?.language ?? 'en',
        consultPolicy: persona.voice.consultPolicy ?? cfg.consultPolicy,
        maxCallMinutes: cfg.maxCallMinutes,
        keepTranscript: cfg.keepTranscript,
        ...(personaOverride ? { personaOverride } : {}),
        ...(cfg.turnDetection
          ? {
              turnDetection: {
                threshold: cfg.turnDetection.threshold,
                prefixPaddingMs: cfg.turnDetection.prefixPaddingMs,
                silenceDurationMs: cfg.turnDetection.silenceDurationMs,
              },
            }
          : {}),
      },
    };
  }

  async start(input: StartCallInput): Promise<ActiveCall> {
    const cfg = this.cfg();
    if (!cfg?.enabled) throw new Error('realtime voice is off (realtimeVoice.enabled)');
    // One person, one somora, one conversation. A second window used to
    // open a second paid connection that wrote into the same session
    // alongside the first; nothing stopped it, and nothing said so
    // either (the operator, 2026-09-12). The running call keeps the line.
    const running = [...this.calls.values()].find((c) => c.call.snapshot().state !== 'closed');
    if (running) {
      const t = running.call.snapshot().target;
      throw new Error(`already on a call with ${t.agent} (${t.slug}) — hang that up first`);
    }
    const persona = await loadPersona(input.agent);
    if (!persona) throw new Error(`agent '${input.agent}' not found`);
    if (!persona.voice?.enabled) throw new Error(`agent '${input.agent}' has no voice (agent.yaml voice.enabled)`);

    // Resolve BEFORE opening anything: an unknown session must be an
    // error, never a quietly created new conversation.
    const session = await resolveSessionId(input.agent, input.session);
    if (!session) throw new Error(`session '${input.session}' not found for ${input.agent}`);

    const personaOverride = await this.voiceOverride(input.agent);
    const call = new VoiceCall(
      { agent: input.agent, session, slug: input.session },
      persona,
      {
        ...(personaOverride ? { personaOverride } : {}),
        model: cfg.model,
        voice: persona.voice.voice ?? cfg.defaultVoice,
        language: persona.voice.language ?? this.deps.config.stt?.language ?? 'en',
        consultPolicy: persona.voice.consultPolicy ?? cfg.consultPolicy,
        maxCallMinutes: cfg.maxCallMinutes,
        keepTranscript: cfg.keepTranscript,
        ...(cfg.turnDetection
          ? {
              turnDetection: {
                threshold: cfg.turnDetection.threshold,
                prefixPaddingMs: cfg.turnDetection.prefixPaddingMs,
                silenceDurationMs: cfg.turnDetection.silenceDurationMs,
              },
            }
          : {}),
      },
      {
        provider: this.buildProvider(),
        runConsult: (args) => this.deps.runConsult(args),
        ...(this.deps.sessionStatus
          ? { sessionStatus: (a: string, s: string) => this.deps.sessionStatus!(a, s) }
          : {}),
        ...(this.deps.consultResult ? { consultResult: (id: string) => this.deps.consultResult!(id) } : {}),
        ...(this.deps.markConsultFetched ? { markConsultFetched: (id: string) => this.deps.markConsultFetched!(id) } : {}),
        ...(this.deps.sessionVoiceWork ? { sessionVoiceWork: (a: string, s: string) => this.deps.sessionVoiceWork!(a, s) } : {}),
        takeCarried: (a, s) => this.takeCarried(a, s),
        onUndelivered: (a, s, item) => this.keep(a, s, item),
        // Written AND published: a reload must not reveal lines the
        // live view never showed.
        appendEvent: async (a, sess, ev) => {
          await appendEvent(a, sess, ev);
          this.deps.publishEvent?.(a, sess, ev);
        },
        log: (entry) => logger.info(entry),
        ...(cfg.allowAgentSwitch
          ? {
              callableAgents: await this.callableAgents(
                (await this.deps.listAgentNames?.()) ?? [],
              ),
              resolveTarget: (a: string, sref: string | undefined) => this.buildTarget(a, sref),
            }
          : {}),
        onEvent: (ev, snap) => this.deps.watcher?.(snap.id)?.(ev, snap),
        onState: (snap) => this.deps.stateWatcher?.(snap.id)?.(snap),
      },
    );
    const providerSession = await call.start();
    const active: ActiveCall = { call, session: providerSession, persona };
    this.calls.set(call.id, active);
    return active;
  }

  get(id: string): ActiveCall | undefined {
    return this.calls.get(id);
  }

  list(): VoiceCallSnapshot[] {
    return [...this.calls.values()].map((c) => c.call.snapshot());
  }

  async stop(id: string, reason: string): Promise<void> {
    const active = this.calls.get(id);
    if (!active) return;
    this.calls.delete(id);
    // What this call asked stays known: a delivery that lands later
    // names its question on the next call.
    const now = Date.now();
    for (const [k, v] of this.endedQuestions) if (now - v.at > CARRY_TTL_MS) this.endedQuestions.delete(k);
    for (const q of active.call.consultQuestions()) this.endedQuestions.set(q.consultId, { question: q.question, at: now });
    await active.call.close(reason);
  }

  /** Hang up everything — server shutdown, config reload. */
  async stopAll(reason: string): Promise<void> {
    const ids = [...this.calls.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id, reason)));
  }
}
