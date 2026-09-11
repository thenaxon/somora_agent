// Who is on a call, and the one place a call is started and stopped.
//
// The server owns calls because the browser is a dumb terminal here:
// microphone in, speaker out, state on screen. Everything that decides
// anything — which agent, which session, which provider, which key, who
// runs a tool — lives on this side.

import { loadPersona, type Persona } from '../../persona/loader.ts';
import { resolveSessionId } from '../../storage/sessions.ts';
import { appendEvent } from '../../storage/sessions.ts';
import { logger } from '../../server/logger.ts';
import type { Config } from '../../config/types.ts';
import { VoiceCall, type ConsultResult, type VoiceCallSnapshot } from './call.ts';
import { OpenAiRealtimeProvider } from './openai-provider.ts';
import type { RealtimeEvent, RealtimeProvider, RealtimeSession } from './types.ts';

export interface VoiceManagerDeps {
  config: Config;
  /** Runs one turn in the bound session as `from_system: 'voice'`. */
  runConsult(args: { agent: string; session: string; text: string }): Promise<ConsultResult>;
  /** Injectable for tests. */
  provider?: RealtimeProvider;
  /** Mirrors every provider event of every call to whoever is watching
   *  it — there is only one consumer of the provider stream. */
  watcher?(callId: string): ((ev: RealtimeEvent, snap: VoiceCallSnapshot) => void) | undefined;
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

export class VoiceCallManager {
  private calls = new Map<string, ActiveCall>();

  constructor(private readonly deps: VoiceManagerDeps) {}

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
    if (cfg.provider !== 'openai') {
      throw new Error(`realtime voice provider '${cfg.provider}' has no adapter yet`);
    }
    return new OpenAiRealtimeProvider({
      ...(cfg.apiKeyFile ? { apiKeyFile: cfg.apiKeyFile } : {}),
    });
  }

  async start(input: StartCallInput): Promise<ActiveCall> {
    const cfg = this.cfg();
    if (!cfg?.enabled) throw new Error('realtime voice is off (realtimeVoice.enabled)');
    const persona = await loadPersona(input.agent);
    if (!persona) throw new Error(`agent '${input.agent}' not found`);
    if (!persona.voice?.enabled) throw new Error(`agent '${input.agent}' has no voice (agent.yaml voice.enabled)`);

    // Resolve BEFORE opening anything: an unknown session must be an
    // error, never a quietly created new conversation.
    const session = await resolveSessionId(input.agent, input.session);
    if (!session) throw new Error(`session '${input.session}' not found for ${input.agent}`);

    const call = new VoiceCall(
      { agent: input.agent, session, slug: input.session },
      persona,
      {
        model: cfg.model,
        voice: persona.voice.voice ?? cfg.defaultVoice,
        language: persona.voice.language ?? this.deps.config.stt?.language ?? 'en',
        consultPolicy: persona.voice.consultPolicy ?? cfg.consultPolicy,
        maxCallMinutes: cfg.maxCallMinutes,
      },
      {
        provider: this.buildProvider(),
        runConsult: (args) => this.deps.runConsult(args),
        appendEvent,
        log: (entry) => logger.info(entry),
        onEvent: (ev, snap) => this.deps.watcher?.(snap.id)?.(ev, snap),
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
    await active.call.close(reason);
  }

  /** Hang up everything — server shutdown, config reload. */
  async stopAll(reason: string): Promise<void> {
    const ids = [...this.calls.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id, reason)));
  }
}
