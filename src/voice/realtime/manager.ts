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
import { resolveSessionId } from '../../storage/sessions.ts';
import { appendEvent } from '../../storage/sessions.ts';
import { logger } from '../../server/logger.ts';
import type { Config } from '../../config/types.ts';
import { VoiceCall, type ConsultResult, type SessionWorkStatus, type VoiceCallSnapshot } from './call.ts';
import { CONSULT_TOOL_NAME } from './consult.ts';
import { buildVoiceInstructions } from './persona.ts';
import { OpenAiRealtimeProvider } from './openai-provider.ts';
import type { NormalizedEvent } from '../../types/events.ts';
import type { RealtimeEvent, RealtimeProvider, RealtimeSession } from './types.ts';

export interface VoiceManagerDeps {
  config: Config;
  /** Runs one turn in the bound session as `from_system: 'voice'`. */
  runConsult(args: { agent: string; session: string; text: string }): Promise<ConsultResult>;
  /** Is that session busy, and for how long? Answers without waiting. */
  sessionStatus?(agent: string, session: string): Promise<SessionWorkStatus>;
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
   * is no way to read what the model is actually told (Rene,
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
    const built = buildVoiceInstructions({
      persona,
      consultPolicy,
      language,
      consultToolName: CONSULT_TOOL_NAME,
      sessionSlug,
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
      personaOverride?: string;
      turnDetection?: { threshold: number; prefixPaddingMs: number; silenceDurationMs: number };
    };
  }> {
    const cfg = this.cfg();
    if (!cfg?.enabled) throw new Error('realtime voice is off');
    const persona = await loadPersona(agent);
    if (!persona) throw new Error(`agent '${agent}' not found`);
    if (!persona.voice?.enabled) throw new Error(`${agent} cannot be reached by voice`);
    const slug = sessionRef ?? 'main';
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
    // either (Rene, 2026-09-12). The running call keeps the line.
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
    await active.call.close(reason);
  }

  /** Hang up everything — server shutdown, config reload. */
  async stopAll(reason: string): Promise<void> {
    const ids = [...this.calls.keys()];
    await Promise.allSettled(ids.map((id) => this.stop(id, reason)));
  }
}
