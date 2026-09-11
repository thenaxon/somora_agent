// One voice call: a standing conversation bound to one agent and one
// session, in which a second model does the talking and the real agent
// does the knowing.
//
// The state machine lives here, deliberately free of any provider and
// of the HTTP server, so it can be driven by a fake provider in a test
// and by a real one in production without a second implementation.
//
// Design: private/realtime-voice-design.md

import { randomUUID } from 'node:crypto';
import type { Persona } from '../../persona/loader.ts';
import type { NormalizedEvent } from '../../types/events.ts';
import {
  CONSULT_TOOL_NAME,
  STATUS_TOOL_NAME,
  SWITCH_TOOL_NAME,
  consultToolSpec,
  parseConsultArgs,
  parseSwitchArgs,
  renderConsultTurnText,
  statusToolSpec,
  switchToolSpec,
} from './consult.ts';
import { buildVoiceInstructions } from './persona.ts';
import type { RealtimeEvent, RealtimeProvider, RealtimeSession } from './types.ts';

export type VoiceCallState =
  | 'connecting'
  | 'listening'
  | 'consulting'
  | 'speaking'
  | 'closed';

export interface VoiceCallTarget {
  agent: string;
  /** Resolved session id, never a slug — resolution happens before the
   *  call starts so a typo cannot become a new conversation. */
  session: string;
  /** For display and for the instructions. */
  slug: string;
}

export interface ConsultResult {
  text: string;
  outcome?: string;
  /** For correlating a spoken answer with the turn it came from. */
  turnId?: string;
  /**
   * The turn did not finish inside the call's patience, or the session
   * was busy with older work. The answer is a status, not a result —
   * the work keeps running and lands in the session either way.
   */
  pending?: boolean;
}

export interface SessionWorkStatus {
  busy: boolean;
  /** How long the current work has been running. */
  sinceMs?: number;
  /** Anything waiting behind it. */
  queued?: number;
}

export interface VoiceCallDeps {
  provider: RealtimeProvider;
  /** Runs ONE turn in the bound session, as `from_system: 'voice'`. */
  runConsult(args: { agent: string; session: string; text: string }): Promise<ConsultResult>;
  /**
   * Persists into the bound session's history AND puts it on the live
   * stream.
   *
   * Both, or the chat window tells two different stories: during a call
   * it showed only what the consult turn published, and a reload then
   * added the spoken lines that had been on disk all along (Rene,
   * 2026-09-12: "es war vorher anders gerendert … erst nach einem
   * browser reload so"). Whatever is written is published.
   */
  appendEvent(agent: string, session: string, ev: NormalizedEvent): Promise<void>;
  /** Is the bound session busy, and for how long? Must not wait. */
  sessionStatus?(agent: string, session: string): Promise<SessionWorkStatus>;
  /** Agents this call may be handed over to. Empty = switching off. */
  callableAgents?: readonly string[];
  /** Everything a call needs to continue as another agent. Rejects with
   *  a message the voice can say when the target does not exist. */
  resolveTarget?(agent: string, sessionRef: string | undefined): Promise<{
    persona: Persona;
    target: VoiceCallTarget;
    cfg: VoiceCallConfig;
  }>;
  /**
   * Every provider event, as the call processes it.
   *
   * There is exactly ONE consumer of the provider's event stream — this
   * class. An async generator hands each event to whoever asks first,
   * so a second reader (the route forwarding frames to the browser)
   * does not mirror the stream, it STEALS half of it. Measured through
   * the deployed server on 2026-09-11: the call machine got the tool
   * call and ran the turn while the browser saw neither transcript nor
   * audio. Anything that needs to watch a call subscribes here.
   */
  onEvent?(ev: RealtimeEvent, snapshot: VoiceCallSnapshot): void;
  /**
   * The call's own state, whenever it changes.
   *
   * Separate from `onEvent` because the interesting states are the ones
   * NO provider event announces: "asking the agent" begins when somora
   * decides to run a turn and ends when the turn returns. A watcher
   * that only mirrors provider events sees connecting → listening →
   * speaking and never learns why the pause in the middle happened
   * (measured through the deployed server, 2026-09-11).
   */
  onState?(snapshot: VoiceCallSnapshot): void;
  log?(entry: Record<string, unknown>): void;
  now?(): number;
}

export interface VoiceCallConfig {
  model: string;
  voice: string;
  language: string;
  consultPolicy: 'auto' | 'substantive' | 'always';
  maxCallMinutes: number;
  /** Interruption sensitivity, from config. */
  turnDetection?: { threshold: number; prefixPaddingMs: number; silenceDurationMs: number };
  /** Hand-written character from VOICE.md, when there is one. */
  personaOverride?: string;
}

export interface VoiceCallSnapshot {
  id: string;
  target: VoiceCallTarget;
  state: VoiceCallState;
  startedAt: number;
  /** Consults asked and answered — the number that says whether the
   *  voice self is actually delegating. */
  consults: number;
  /** Utterances persisted into the session. */
  spokenTurns: number;
  lastError?: string;
}

export class VoiceCall {
  readonly id = randomUUID();
  private state: VoiceCallState = 'connecting';
  private session: RealtimeSession | undefined;
  /** Set by the switch tool; the run loop picks it up when the old
   *  provider session ends. */
  private pendingSwitch: { agent: string; session?: string } | undefined;
  private consults = 0;
  private spokenTurns = 0;
  private lastError: string | undefined;
  private readonly startedAt: number;
  private deadlineTimer: NodeJS.Timeout | undefined;

  constructor(
    private target: VoiceCallTarget,
    private persona: Persona,
    private cfg: VoiceCallConfig,
    private readonly deps: VoiceCallDeps,
  ) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setState(next: VoiceCallState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.onState?.(this.snapshot());
  }

  /** Who this call may be handed to: never itself, never an agent the
   *  operator did not allow. */
  private switchable(): string[] {
    return (this.deps.callableAgents ?? []).filter((a) => a !== this.target.agent);
  }

  private log(entry: Record<string, unknown>): void {
    this.deps.log?.({ call: this.id, agent: this.target.agent, session: this.target.session, ...entry });
  }

  snapshot(): VoiceCallSnapshot {
    return {
      id: this.id,
      target: this.target,
      state: this.state,
      startedAt: this.startedAt,
      consults: this.consults,
      spokenTurns: this.spokenTurns,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  /** Open the provider session. The audio itself flows browser ↔
   *  provider; what comes back here is the control channel. */
  async start(): Promise<RealtimeSession> {
    const instructions = buildVoiceInstructions({
      persona: this.persona,
      consultPolicy: this.cfg.consultPolicy,
      language: this.cfg.language,
      consultToolName: CONSULT_TOOL_NAME,
      sessionSlug: this.target.slug,
      ...(this.cfg.personaOverride ? { override: this.cfg.personaOverride } : {}),
      ...(this.switchable().length > 0 ? { switchTo: this.switchable() } : {}),
    });
    this.log({
      msg: 'voice.call_start',
      model: this.cfg.model,
      voice: this.cfg.voice,
      instructionChars: instructions.chars,
      personaSource: this.cfg.personaOverride ? 'VOICE.md' : 'derived',
    });
    this.session = await this.deps.provider.open({
      model: this.cfg.model,
      voice: this.cfg.voice,
      instructions: instructions.text,
      language: this.cfg.language,
      ...(this.cfg.turnDetection ? { turnDetection: this.cfg.turnDetection } : {}),
      tools: [
        consultToolSpec(this.persona.name),
        statusToolSpec(),
        ...(this.switchable().length > 0 ? [switchToolSpec(this.switchable())] : []),
      ],
    });
    // The meter runs while nobody speaks, so the cap is wall-clock and
    // enforced here rather than left to whoever forgets the tab.
    this.deadlineTimer = setTimeout(
      () => void this.close('call time limit reached'),
      this.cfg.maxCallMinutes * 60_000,
    );
    this.deadlineTimer.unref?.();
    return this.session;
  }

  /** Drive the call. Ends when the provider session ends. */
  async *run(): AsyncGenerator<VoiceCallSnapshot> {
    // The loop outlives a single provider session: handing the call to
    // another agent means a new voice, and a voice cannot be changed
    // once a session has spoken (measured 2026-09-11). So the call
    // stays, the session underneath is replaced.
    while (true) {
      const session = this.session ?? (await this.start());
      const ended = yield* this.pump(session);
      if (!this.pendingSwitch) {
        if (ended) return;
        continue;
      }
      const request = this.pendingSwitch;
      this.pendingSwitch = undefined;
      const ok = await this.performSwitch(request);
      yield this.snapshot();
      if (!ok) return;
    }
  }

  /** One provider session's worth of events. Returns true when the call
   *  is over, false when it ended to make room for a switch. */
  private async *pump(session: RealtimeSession): AsyncGenerator<VoiceCallSnapshot, boolean> {
    for await (const ev of session.events()) {
      // Mirror first, act second: a watcher must see the event even if
      // handling it throws.
      this.deps.onEvent?.(ev, this.snapshot());
      switch (ev.kind) {
        case 'ready':
          this.setState('listening');
          yield this.snapshot();
          break;
        case 'model_speech':
          this.setState(ev.phase === 'start' ? 'speaking' : 'listening');
          yield this.snapshot();
          break;
        case 'user_transcript':
          if (ev.final && ev.text.trim().length > 0) {
            await this.persistSpoken(ev.text.trim());
            yield this.snapshot();
          }
          break;
        case 'model_transcript':
          if (ev.final && ev.text.trim().length > 0) {
            await this.persistSpokenAnswer(ev.text.trim());
          }
          break;
        case 'tool_call':
          await this.handleToolCall(session, ev.callId, ev.name, ev.args);
          yield this.snapshot();
          break;
        case 'interrupted':
          this.setState('listening');
          this.log({ msg: 'voice.interrupted' });
          yield this.snapshot();
          break;
        case 'error':
          this.lastError = ev.message;
          this.log({ msg: 'voice.error', err: ev.message, fatal: ev.fatal });
          yield this.snapshot();
          if (ev.fatal) {
            await this.close(`provider error: ${ev.message}`);
            return true;
          }
          break;
        case 'closed':
          if (this.pendingSwitch) return false;
          this.setState('closed');
          this.clearDeadline();
          this.log({ msg: 'voice.call_end', reason: ev.reason, consults: this.consults, spokenTurns: this.spokenTurns });
          yield this.snapshot();
          return true;
        default:
          break;
      }
    }
    if (this.pendingSwitch) return false;
    this.setState('closed');
    this.clearDeadline();
    yield this.snapshot();
    return true;
  }

  /** Continue the same call as another agent, in a named session. */
  private async performSwitch(request: { agent: string; session?: string }): Promise<boolean> {
    const from = { ...this.target };
    try {
      const next = await this.deps.resolveTarget!(request.agent, request.session);
      await this.session?.close('handed over').catch(() => {});
      this.session = undefined;
      this.target = next.target;
      this.persona = next.persona;
      this.cfg = next.cfg;
      this.setState('connecting');
      await this.start();
      this.log({ msg: 'voice.switched', from: `${from.agent}/${from.slug}`, to: `${this.target.agent}/${this.target.slug}` });
      // A line in both places, so reading either conversation later
      // shows where it went and where it came from.
      await this.note(from.agent, from.session, `[voice] handed this call over to ${this.target.agent} (session "${this.target.slug}")`);
      await this.note(this.target.agent, this.target.session, `[voice] took this call over from ${from.agent} (session "${from.slug}")`);
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log({ msg: 'voice.switch_failed', to: request.agent, err: this.lastError });
      this.setState('closed');
      this.clearDeadline();
      return false;
    }
  }

  private async note(agent: string, session: string, text: string): Promise<void> {
    await this.deps.appendEvent(agent, session, {
      kind: 'engine_meta',
      ts: this.now(),
      engine: 'voice',
      itemType: 'voice_handover',
      payload: { text },
    } as NormalizedEvent);
  }

  private async handleToolCall(session: RealtimeSession, callId: string, name: string, rawArgs: string): Promise<void> {
    if (name === STATUS_TOOL_NAME) {
      const status = (await this.deps.sessionStatus?.(this.target.agent, this.target.session)) ?? { busy: false };
      const minutes = status.sinceMs ? Math.max(1, Math.round(status.sinceMs / 60_000)) : 0;
      await session.sendToolResult(
        callId,
        status.busy
          ? `still working on something you started ${minutes} minute(s) ago${status.queued ? `, ${status.queued} waiting behind it` : ''} — say so, and offer to look again in a moment`
          : 'nothing running right now',
      );
      return;
    }
    if (name === SWITCH_TOOL_NAME) {
      const parsed = parseSwitchArgs(rawArgs);
      if (!parsed.ok) {
        await session.sendToolResult(callId, parsed.error);
        return;
      }
      const allowed = this.switchable();
      if (!allowed.includes(parsed.args.agent)) {
        await session.sendToolResult(
          callId,
          `${parsed.args.agent} cannot be reached by voice — say so. Available: ${allowed.join(', ') || 'nobody else'}`,
        );
        return;
      }
      // Answer BEFORE the session goes away: the tool result has to
      // reach the model that asked, not its successor.
      await session.sendToolResult(callId, `putting them through to ${parsed.args.agent} now`);
      this.pendingSwitch = parsed.args;
      this.log({ msg: 'voice.switch_requested', to: parsed.args.agent, session: parsed.args.session ?? 'main' });
      // Give the sentence a moment to be spoken, then end this session;
      // the run loop opens the next one.
      setTimeout(() => void session.close('handing over').catch(() => {}), 2_500).unref?.();
      return;
    }
    if (name !== CONSULT_TOOL_NAME) {
      // The voice self only ever gets the tools we hand it. Anything
      // else is a provider or prompt bug, and answering it with an
      // error keeps the conversation alive instead of wedging it.
      this.log({ msg: 'voice.unknown_tool', tool: name });
      await session.sendToolResult(callId, `unknown tool '${name}' — you only have ${CONSULT_TOOL_NAME}`);
      return;
    }
    const parsed = parseConsultArgs(rawArgs);
    if (!parsed.ok) {
      this.log({ msg: 'voice.consult_bad_args', err: parsed.error });
      await session.sendToolResult(callId, parsed.error);
      return;
    }
    this.setState('consulting');
    this.consults += 1;
    const startedAt = this.now();
    const text = renderConsultTurnText(parsed.args, 'the user');
    this.log({ msg: 'voice.consult_start', question: parsed.args.question.slice(0, 160) });
    // Fill the silence from here rather than asking the model to
    // announce its own lookup: told to do that, it announced and never
    // called (both models, 2026-09-11).
    void session
      .speak?.('Say ONE short sentence that you are looking it up right now. Nothing else, no promises about what you will find.')
      .catch(() => {});
    try {
      const result = await this.deps.runConsult({
        agent: this.target.agent,
        session: this.target.session,
        text,
      });
      const answer = result.text.trim();
      this.log({
        msg: 'voice.consult_done',
        ms: this.now() - startedAt,
        outcome: result.outcome ?? null,
        pending: result.pending ?? false,
        chars: answer.length,
      });
      await session.sendToolResult(
        callId,
        answer.length > 0
          ? answer
          : `no answer this time — say so, do not invent one`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.lastError = message;
      this.log({ msg: 'voice.consult_failed', err: message });
      // The failure is told to the voice self so it can say something
      // true ("I could not reach him"), rather than being swallowed
      // into a silence the user has to interpret.
      await session.sendToolResult(callId, `asking ${this.persona.name} failed: ${message}`);
    } finally {
      this.setState('listening');
    }
  }

  /** The user's finalized utterance becomes a normal user message —
   *  that is what makes the call continuable by keyboard afterwards. */
  private async persistSpoken(text: string): Promise<void> {
    this.spokenTurns += 1;
    await this.deps.appendEvent(this.target.agent, this.target.session, {
      kind: 'user_message',
      ts: this.now(),
      engine: 'voice',
      text,
      // A live call, not the dictation button: `source` keeps the two
      // spoken paths apart everywhere they are read.
      input: { modality: 'voice', source: 'realtime' },
    } as NormalizedEvent);
  }

  /** What was actually SAID, kept apart from what the agent wrote. The
   *  spoken version is a rendering, not the record. */
  private async persistSpokenAnswer(text: string): Promise<void> {
    await this.deps.appendEvent(this.target.agent, this.target.session, {
      kind: 'engine_meta',
      ts: this.now(),
      engine: 'voice',
      itemType: 'voice_spoken',
      payload: { text },
    } as NormalizedEvent);
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
  }

  async close(reason: string): Promise<void> {
    this.clearDeadline();
    if (this.state !== 'closed') {
      this.state = 'closed';
      await this.session?.close(reason).catch(() => {});
      this.log({ msg: 'voice.call_closed', reason, consults: this.consults, spokenTurns: this.spokenTurns });
    }
  }
}
