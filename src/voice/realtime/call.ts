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
  consultToolSpec,
  parseConsultArgs,
  renderConsultTurnText,
  statusToolSpec,
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
  /** Persists into the bound session's history. */
  appendEvent(agent: string, session: string, ev: NormalizedEvent): Promise<void>;
  /** Is the bound session busy, and for how long? Must not wait. */
  sessionStatus?(agent: string, session: string): Promise<SessionWorkStatus>;
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
  private consults = 0;
  private spokenTurns = 0;
  private lastError: string | undefined;
  private readonly startedAt: number;
  private deadlineTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly target: VoiceCallTarget,
    private readonly persona: Persona,
    private readonly cfg: VoiceCallConfig,
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
    });
    this.log({ msg: 'voice.call_start', model: this.cfg.model, voice: this.cfg.voice, instructionChars: instructions.chars });
    this.session = await this.deps.provider.open({
      model: this.cfg.model,
      voice: this.cfg.voice,
      instructions: instructions.text,
      language: this.cfg.language,
      tools: [consultToolSpec(this.persona.name), statusToolSpec()],
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
    const session = this.session ?? (await this.start());
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
            return;
          }
          break;
        case 'closed':
          this.setState('closed');
          this.clearDeadline();
          this.log({ msg: 'voice.call_end', reason: ev.reason, consults: this.consults, spokenTurns: this.spokenTurns });
          yield this.snapshot();
          return;
        default:
          break;
      }
    }
    this.state = 'closed';
    this.clearDeadline();
    yield this.snapshot();
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
      input: { modality: 'voice' },
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
