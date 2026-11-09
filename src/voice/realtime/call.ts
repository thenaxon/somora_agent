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
  RESULT_TOOL_NAME,
  parseResultArgs,
  resultToolSpec,
  STATUS_TOOL_NAME,
  SWITCH_TOOL_NAME,
  consultToolSpec,
  parseConsultArgs,
  parseSwitchArgs,
  renderConsultTurn,
  statusToolSpec,
  switchToolSpec,
} from './consult.ts';
import { languageName, buildVoiceInstructions } from './persona.ts';
import { normalizeSpokenName } from './session-match.ts';
import type { RealtimeEvent, RealtimeProvider, RealtimeSession } from './types.ts';

/** How much of the conversation the call keeps in memory. */
/** An announcement waits for this much quiet from the caller … */
const ANNOUNCE_PAUSE_MS = 1_500;
/** … but not forever. */
const ANNOUNCE_MAX_WAIT_MS = 60_000;
/** A stored answer older than this is fetched with its time. */
const STALE_ANSWER_MS = 60_000;
const TRANSCRIPT_MEMORY = 24;
/** How much of it travels with a question to the agent. Six lines is
 *  about two exchanges: enough for "and how long does that take", short
 *  enough that it does not dominate the session it is written into. */
const CONSULT_TRANSCRIPT_LINES = 6;

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
  /** Phase 2 (2026-09-13): `answered` came back inside the patience;
   *  `handed_over` means the work goes on under `consultId` and the
   *  answer is delivered to the call when it lands. */
  state?: 'answered' | 'handed_over';
  consultId?: string;
  /** Place in the session's queue at hand-over (0 = already running). */
  position?: number;
}

/** What a handed-over consult looks like when the voice asks for it. */
export interface ConsultLookup {
  state: 'pending' | 'done' | 'failed';
  text?: string;
  error?: string;
  position?: number;
  /** When the consult's turn ended (ms). */
  finishedAt?: number;
  /** What the agent reported in this session about work that finished
   *  AFTER this consult did (its wake turns, oldest first). The answer
   *  itself is frozen at `finishedAt`; these are the newer state. */
  newer?: string[];
}

/** A consult of this session's voice calls, as the work ledger sees it
 *  now — from this call or an earlier one. */
export interface SessionVoiceWork {
  consultId: string;
  question: string;
  /** `running`: the consult itself is not answered yet. `working_on`:
   *  answered, but work it started (a sub, a question to another
   *  agent) is still running. `finished`: that work has finished since;
   *  `text` is what the agent reported about it. */
  state: 'running' | 'working_on' | 'finished';
  text?: string;
}

/** A delivery whose call is gone, handed to the next call that is on
 *  the same agent and session (manager.ts). */
export interface CarriedDelivery {
  res: ConsultDelivery;
  question: string;
}

/** A finished consult, brought to the call by the work ledger. */
export interface ConsultDelivery {
  consultId: string;
  state: 'done' | 'failed';
  text?: string;
  error?: string;
  /** Work the consult started finished after its answer (work-ledger
   *  maybeFollowUp): read out as a follow-up, even though the consult
   *  itself was already delivered. */
  followUp?: boolean;
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
  /** Runs ONE turn in the bound session, as `from_system: 'voice'`.
   *  `prefix` is scaffolding the model sees and the record does not. */
  runConsult(args: { agent: string; session: string; text: string; prefix?: string; callId?: string }): Promise<ConsultResult>;
  /**
   * Persists into the bound session's history AND puts it on the live
   * stream.
   *
   * Both, or the chat window tells two different stories: during a call
   * it showed only what the consult turn published, and a reload then
   * added what had been on disk all along (the operator, 2026-09-12: "es war
   * vorher anders gerendert … erst nach einem browser reload so").
   * Whatever is written is published.
   *
   * Used for the handover note only. Everything the call says and hears
   * stays in the call; what a session records is the question that
   * reached the agent and the answer it gave.
   */
  appendEvent(agent: string, session: string, ev: NormalizedEvent): Promise<void>;
  /** Is the bound session busy, and for how long? Must not wait. */
  sessionStatus?(agent: string, session: string): Promise<SessionWorkStatus>;
  /** A handed-over consult by id — reading it counts as fetched. */
  consultResult?(consultId: string): Promise<ConsultLookup | null>;
  /** The call read (or announced) a consult; no second delivery. */
  markConsultFetched?(consultId: string): Promise<void>;
  /** The voice consults of a session, from any call (the status tool). */
  sessionVoiceWork?(agent: string, session: string): Promise<SessionVoiceWork[]>;
  /** Deliveries from earlier calls waiting for this agent and session —
   *  taken (and so removed) whenever the call opens on a target. */
  takeCarried?(agent: string, session: string): CarriedDelivery[];
  /** A delivery this call could not read out (moved to another agent,
   *  closed): kept for the next call on that agent and session. */
  onUndelivered?(agent: string, session: string, item: CarriedDelivery): void;
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
  /** Write the call record into the session when the call ends. */
  keepTranscript?: boolean;
}

/** Marks an answer that was cut: the text is what the voice generated up
 *  to the cut; how much of it the caller heard is not known (the service
 *  sends audio ahead of playback). */
const CUT_MARK = ' (cut off)';

/** "45 s", "3 min" — the length of a call for its record. */
function callLength(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** One line of the call record: who said it (or what happened), when. */
export interface VoiceCallRecordLine {
  /** Milliseconds since the call started. */
  at: number;
  who: 'caller' | 'voice' | 'event';
  text: string;
}

export interface VoiceCallSnapshot {
  id: string;
  target: VoiceCallTarget;
  state: VoiceCallState;
  startedAt: number;
  /** Consults asked and answered — the number that says whether the
   *  voice self is actually delegating. */
  consults: number;
  /** Sentences the caller has said in this call. Counted, not kept:
   *  the session records the questions that reached the agent. */
  spokenTurns: number;
  /** Set while a handover is in flight: who the call is moving to.
   *  `target` still names the agent that is talking until the new one
   *  is actually on the line. */
  handoverTo?: string;
  lastError?: string;
}

export class VoiceCall {
  readonly id = randomUUID();
  private state: VoiceCallState = 'connecting';
  private session: RealtimeSession | undefined;
  /** Set by the switch tool; the run loop picks it up when the old
   *  provider session ends. */
  private pendingSwitch: { agent: string; session?: string } | undefined;
  /**
   * The conversation itself — kept here and nowhere else.
   *
   * Spoken sentences used to be appended into the agent's session as
   * user messages, and what the voice said back as a meta row. That
   * made three different readers stumble: the CLI engines drop a user
   * turn that never got an answer, REM and recall saw every question
   * twice (once as said, once as asked), and a sentence written outside
   * the session lock could land inside a running turn and break its
   * pair. The operator, 2026-09-12: "es ist viel viel wartbarer code".
   *
   * What a session records now is exactly what A2A records: the
   * question this call put to the agent, and the agent's answer. The
   * talking around it lives for the length of the call, the way
   * OpenClaw keeps it on its call object.
   */
  private transcript: Array<{ role: 'caller' | 'voice'; text: string }> = [];
  /** The whole call, for the folded record in the session. */
  private record: VoiceCallRecordLine[] = [];
  /** What the model has said of the answer that is running. */
  private partialAnswer = '';
  private recordStartedAt = 0;
  /** The start of an answer recorded as cut: its final transcript, if
   *  the service still sends one after the cancel, is the same answer. */
  private cutAnswer = '';
  /** The response the running answer belongs to, and the one recorded as
   *  cut (when the service names responses). */
  private answerResponseId: string | undefined;
  private cutResponseId: string | undefined;
  /** The record line of the latest finished answer, while it may still be
   *  playing: an interruption after its final transcript marks it cut. */
  private lastAnswerLine: VoiceCallRecordLine | null = null;
  /** Consults that came back handed over: what was asked, when, and
   *  for whom — a result for a previous agent is not read out as this
   *  one's after a switch. */
  private openConsults = new Map<string, { question: string; startedAt: number; agent: string; session: string; fetched: boolean; earlier?: boolean }>();
  /** A result that landed before the hand-over was recorded (the turn
   *  finished in the same tick the patience ran out). */
  private earlyDeliveries = new Map<string, ConsultDelivery>();
  /** When the caller last said something — an announcement waits for a
   *  pause. */
  private lastHeardAt = 0;
  /**
   * Who the window is showing. Lags `target` across a handover.
   *
   * The old agent's last sentence is still in the browser's playback
   * queue when the new provider session opens. Announcing the new name
   * at that moment makes bea finish her sentence under ada's name and
   * colour (the operator, 2026-09-12: "es spricht aber noch Bea"). The call
   * says who is on the line only once that is true; the browser adds
   * its own queue to the same question.
   */
  private announced: VoiceCallTarget;
  /**
   * Targets that could not be reached, and what to say about them.
   *
   * Every switch attempt ends the provider session so the next voice can
   * start, so a target that does not resolve costs a restart. Asking for
   * the same impossible thing twice must not cost a second one — the
   * answer is already known and goes straight back to the model.
   */
  private unreachable = new Map<string, string>();
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
    this.recordStartedAt = this.startedAt;
    this.announced = { ...target };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setState(next: VoiceCallState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.onState?.(this.snapshot());
  }

  /**
   * Where this call may be moved: any agent the operator allowed —
   * INCLUDING the one already on the line.
   *
   * Filtering itself out made a whole dimension unreachable: an agent
   * has many sessions, and "put me into your craftbox session" was
   * impossible while the tool only offered other agents (the operator,
   * 2026-09-12). Same agent plus a different session is a move like any
   * other; the voice stays the same, the conversation does not.
   */
  private switchable(): string[] {
    return [...(this.deps.callableAgents ?? [])];
  }

  /**
   * Is this name just the session the call is already in?
   *
   * The voice self knows which session it sits in, and on a handover it
   * passes that name along unless something stops it — which is how
   * asking for nova landed in nova's "craftbox", because bea had
   * been in hers (the operator, 2026-09-12: "es muss nicht immer zwingend der
   * fall sein das der andere agent überhaupt eine session hat die so
   * benannt ist"). Nobody said that name, so it is not a wish.
   *
   * Anything ELSE the model passes did not come from itself, so it came
   * from the caller and is taken at face value. An earlier version
   * checked the name against the transcript instead and threw away a
   * real wish: speech recognition wrote the session differently than the
   * model did, and the two never matched.
   */
  private isOwnSessionName(name: string): boolean {
    return normalizeSpokenName(name) === normalizeSpokenName(this.target.slug);
  }

  private log(entry: Record<string, unknown>): void {
    this.deps.log?.({ call: this.id, agent: this.target.agent, session: this.target.session, ...entry });
  }

  snapshot(): VoiceCallSnapshot {
    const moving = this.announced.agent !== this.target.agent || this.announced.slug !== this.target.slug;
    return {
      id: this.id,
      target: this.announced,
      ...(moving ? { handoverTo: this.target.agent } : {}),
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
      // The instruction names the OTHERS — "ask for someone else" reads
      // oddly with your own name in the list. The tool spec carries the
      // full list, own name included, because moving to another session
      // of yourself goes through the same call.
      ...(this.switchable().filter((a) => a !== this.target.agent).length > 0
        ? { switchTo: this.switchable().filter((a) => a !== this.target.agent) }
        : {}),
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
        resultToolSpec(),
        ...(this.switchable().length > 0 ? [switchToolSpec(this.switchable(), this.target.agent)] : []),
      ],
    });
    // The meter runs while nobody speaks, so the cap is wall-clock and
    // enforced here rather than left to whoever forgets the tab.
    //
    // Measured from the START of the call, not of this session: start()
    // runs again on every move. Re-arming it with the full budget would
    // make a handover a way to talk for as long as you like, and leaving
    // the old timer in place left one ticking per move.
    this.clearDeadline();
    const budgetLeft = Math.max(0, this.cfg.maxCallMinutes * 60_000 - (this.now() - this.startedAt));
    this.deadlineTimer = setTimeout(
      () => void this.close('call time limit reached'),
      budgetLeft,
    );
    this.deadlineTimer.unref?.();
    // What finished while no call was on this agent and session (an
    // earlier call hit its time limit, was hung up, or moved away):
    // read out now, once (the 2026-11-06 report: the follow-up of a
    // call that had ended was dropped while the next call ran).
    for (const item of this.deps.takeCarried?.(this.target.agent, this.target.session) ?? []) {
      void this.carryOver(item).catch((err: unknown) => this.log({ msg: 'voice.consult_delivery_failed', consultId: item.res.consultId, err: (err as Error).message }));
    }
    return this.session;
  }

  /** The consults this call knows, for the manager to remember when the
   *  call ends: a later delivery for one of them goes to the next call. */
  consultQuestions(): Array<{ consultId: string; question: string }> {
    return [...this.openConsults].map(([consultId, c]) => ({ consultId, question: c.question }));
  }

  /**
   * A delivery for a consult an EARLIER call made, on this call's agent
   * and session: the call takes the consult over and reads it out as
   * one from that earlier call.
   */
  async carryOver(item: CarriedDelivery): Promise<void> {
    const { res, question } = item;
    const known = this.openConsults.get(res.consultId);
    if (!known) {
      this.openConsults.set(res.consultId, {
        question,
        startedAt: this.now(),
        agent: this.target.agent,
        session: this.target.session,
        fetched: false,
        earlier: true,
      });
    } else if (!res.followUp) {
      known.fetched = false;
    }
    this.log({ msg: 'voice.consult_carried_over', consultId: res.consultId, followUp: res.followUp ?? false });
    await this.deliver(res);
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
          // The new session is live, so the new name is now the honest
          // one. Announced here rather than when the switch was decided.
          this.announced = { ...this.target };
          this.setState('listening');
          this.deps.onState?.(this.snapshot());
          yield this.snapshot();
          break;
        case 'model_speech':
          this.setState(ev.phase === 'start' ? 'speaking' : 'listening');
          yield this.snapshot();
          break;
        case 'user_transcript':
          this.lastHeardAt = this.now();
          if (ev.final && ev.text.trim().length > 0) {
            this.remember('caller', ev.text.trim());
            this.recordLine('caller', ev.text.trim());
            this.lastAnswerLine = null;
            yield this.snapshot();
          }
          break;
        case 'model_transcript':
          // the rest of an answer that was already recorded as cut (OpenAI
          // still sends its deltas and full text after the cancel): skip
          if (ev.responseId && ev.responseId === this.cutResponseId) {
            if (ev.final) this.remember('voice', ev.text.trim());
            break;
          }
          if (!ev.final) {
            // a new answer begins: an earlier cut one's late final is no longer expected
            if (this.partialAnswer === '') this.cutAnswer = '';
            this.partialAnswer += ev.text;
            if (ev.responseId) this.answerResponseId = ev.responseId;
          }
          else {
            const text = ev.text.trim();
            if (text.length > 0) {
              this.remember('voice', text);
              // OpenAI sends the cancelled answer's full text after the
              // cancel: it is already recorded, up to where it was cut
              // by response when the service names it; by text only without
              const sameAsCut = ev.responseId
                ? ev.responseId === this.cutResponseId
                : this.cutAnswer !== '' && text.startsWith(this.cutAnswer);
              if (!sameAsCut) {
                this.recordLine('voice', text);
                this.lastAnswerLine = this.record[this.record.length - 1] ?? null;
              }
            }
            this.partialAnswer = '';
            this.cutAnswer = '';
          }
          break;
        case 'notice':
          this.log({ msg: 'voice.provider_notice', notice: ev.message });
          this.recordLine('event', `service: ${ev.message}`);
          break;
        case 'tool_call':
          // Not awaited: a consult can take the whole patience, and the
          // call must keep hearing the caller, honouring barge-in and
          // taking the next question meanwhile (birdseye L10). The
          // handler answers the tool call when it is done.
          void this.handleToolCall(session, ev.callId, ev.name, ev.args).catch((err) => {
            this.log({ msg: 'voice.tool_failed', tool: ev.name, err: (err as Error).message });
          });
          yield this.snapshot();
          break;
        case 'interrupted':
          this.setState('listening');
          this.log({ msg: 'voice.interrupted' });
          // what was said of the answer before it was cut, and that it was
          if (this.partialAnswer.trim()) {
            this.cutAnswer = this.partialAnswer.trim();
            this.cutResponseId = this.answerResponseId;
            this.recordLine('voice', `${this.cutAnswer}${CUT_MARK}`);
          } else if (this.lastAnswerLine && !this.lastAnswerLine.text.endsWith(CUT_MARK)) {
            // the answer was fully sent and still playing: heard only in part
            this.lastAnswerLine.text += CUT_MARK;
          }
          this.lastAnswerLine = null;
          this.partialAnswer = '';
          this.recordLine('event', 'interrupted');
          yield this.snapshot();
          break;
        case 'error':
          this.lastError = ev.message;
          this.log({ msg: 'voice.error', err: ev.message, fatal: ev.fatal });
          this.recordLine('event', `${ev.fatal ? 'error, call ended' : 'error'}: ${ev.message}`);
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
          await this.writeRecord(this.target, ev.reason);
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

  /**
   * Continue the same call somewhere else: another agent, or another
   * session of the agent already on the line.
   *
   * A failure here used to end the call. It must not: the caller asked
   * for a session that may not exist, and being hung up on for a typo
   * is the worst possible answer. The call comes back as the agent it
   * was and says so.
   */
  private async performSwitch(request: { agent: string; session?: string }): Promise<boolean> {
    const from = { ...this.target };
    const fromPersona = this.persona;
    const fromCfg = this.cfg;
    const wanted = request.session;
    // Carried over rather than asked for: dropped, so the caller lands
    // in the other agent's main session.
    const inherited = wanted !== undefined && request.agent !== this.target.agent && this.isOwnSessionName(wanted);
    const session = inherited ? undefined : wanted;
    if (inherited) {
      this.log({ msg: 'voice.switch_session_dropped', to: request.agent, session: wanted });
    }
    try {
      const next = await this.deps.resolveTarget!(request.agent, session);
      await this.session?.close('handed over').catch(() => {});
      this.session = undefined;
      this.target = next.target;
      this.persona = next.persona;
      this.cfg = next.cfg;
      this.setState('connecting');
      this.deps.onState?.(this.snapshot());
      await this.start();
      this.log({ msg: 'voice.switched', from: `${from.agent}/${from.slug}`, to: `${this.target.agent}/${this.target.slug}` });
      await this.writeRecord(from, 'handed over', fromCfg.voice);
      const moved = from.agent !== this.target.agent;
      // A line in both places, so reading either conversation later
      // shows where it went and where it came from. Moving between two
      // sessions of the SAME agent writes the same pair — the agent is
      // one, the conversations are two.
      await this.note(
        from.agent,
        from.session,
        moved
          ? `[voice] handed this call over to ${this.target.agent} (session "${this.target.slug}")`
          : `[voice] this call moved to the "${this.target.slug}" session`,
      );
      await this.note(
        this.target.agent,
        this.target.session,
        moved
          ? `[voice] took this call over from ${from.agent} (session "${from.slug}")`
          : `[voice] this call came over from the "${from.slug}" session`,
      );
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.unreachable.set(`${request.agent}/${request.session ?? 'main'}`, this.lastError);
      this.log({ msg: 'voice.switch_failed', to: request.agent, session: request.session ?? 'main', err: this.lastError });
      // Back to where we were. The old provider session is already
      // closing (the switch tool ends it so the new voice can start),
      // so this opens a fresh one for the same agent.
      try {
        this.target = from;
        this.persona = fromPersona;
        this.cfg = fromCfg;
        this.announced = { ...from };
        this.setState('connecting');
        const recovered = await this.start();
        // The reason is the useful part: "there is main and craftbox"
        // is what lets the caller pick, where "that did not work" makes
        // them guess again.
        void recovered
          .speak?.(
            'Say ONE short sentence, in the language of this conversation: the move did not work and they are ' +
              `still with you. Put this into your own words, briefly: ${this.lastError ?? 'the target could not be reached'}`,
          )
          .catch(() => {});
        this.log({ msg: 'voice.switch_recovered', agent: from.agent, session: from.slug });
        return true;
      } catch (recoveryErr) {
        this.log({ msg: 'voice.switch_recovery_failed', err: (recoveryErr as Error).message });
        this.setState('closed');
        this.clearDeadline();
        return false;
      }
    }
  }

  /**
   * Come back on the line as the agent we already are.
   *
   * The switch tool ends its own provider session so the next voice can
   * start, so "nothing to move to" is not a no-op: there is no session
   * left to talk through. This opens a fresh one for the same target and
   * has the voice say that the caller is still here.
   */
  private async stayPut(reason: string): Promise<boolean> {
    this.log({ msg: 'voice.switch_stayed', agent: this.target.agent, session: this.target.slug, reason });
    try {
      this.announced = { ...this.target };
      this.setState('connecting');
      const recovered = await this.start();
      void recovered
        .speak?.(
          'Say ONE short sentence that they are still with you and ask which session they meant. Keep it under ten words.',
        )
        .catch(() => {});
      return true;
    } catch (err) {
      this.log({ msg: 'voice.stay_failed', err: (err as Error).message });
      this.setState('closed');
      this.clearDeadline();
      return false;
    }
  }

  /**
   * Microphone audio for whatever session the call is on RIGHT NOW.
   *
   * After a handover the provider session is a different object. The
   * route used to hold the one it was given at the start, so once the
   * call continued as another agent the microphone was still feeding a
   * closed session: the window switched to bea, bea heard nothing,
   * and the call had to be restarted (the operator, 2026-09-12). Anything that
   * talks to the provider goes through the call, never around it.
   */
  async sendAudio(chunk: { base64: string; rateHz: number }): Promise<void> {
    await this.session?.sendAudio?.(chunk);
  }

  async interrupt(): Promise<void> {
    await this.session?.interrupt();
  }

  /**
   * An answer that came back inside the patience goes to the talking
   * model as a tool result. Handed the raw text, the small local model
   * treated "shortened for the ear" as "leave it out": asked for the
   * team structure, ada answered with 1239 characters and the voice
   * spoke 25 (the operator, 2026-09-13). The hand-over announcement always
   * carried an instruction; the quick path now does too — English,
   * naming the call's language and the persona's sentence budget, the
   * wording still the model's.
   */
  private frameAnswer(text: string): string {
    const sentences = this.persona.voice?.maxSpokenSentences ?? 4;
    return (
      `The agent answered. Tell the user the substance of this answer in ${languageName(this.cfg.language)}, ` +
      `in at most ${sentences} sentences: the names, facts and numbers in it, as the agent gave them, ` +
      'without reading lists or paths aloud. Never replace it with saying that you have it, that it is ' +
      'done, or that it is in the chat.\n' +
      text
    );
  }

  /**
   * A stored answer fetched by id. It is frozen at the moment its turn
   * ended: "still running" in it may long be over. Fetched a second time
   * on 2026-11-06, a minute after the work had finished, it was spoken
   * as the current state. Newer reports from the session win; an old or
   * re-read answer carries its time.
   */
  private frameStored(text: string, look: ConsultLookup, readBefore: boolean): string {
    const at = look.finishedAt;
    const clock = at ? new Date(at).toTimeString().slice(0, 5) : undefined;
    if (look.newer && look.newer.length > 0) {
      // The newer reports are the session's, not only this consult's:
      // on 2026-11-06 the stale answer was a status check that started
      // nothing, and the report that made it stale belonged to another
      // request. So they correct the old answer where they speak about
      // the same work, and do not replace it where they do not.
      return (
        `This answer is from ${clock ?? 'earlier'}. Since then, the agent has reported FINISHED work in this session ` +
        '(below the old answer; it may be about this or about other requests). Where a newer report says work that the ' +
        'old answer calls running or pending has finished, that is the current state: say so, and do not repeat the ' +
        'old "still running". Otherwise give the old answer and say when it is from. Answer in ' +
        `${languageName(this.cfg.language)}, at most ${this.persona.voice?.maxSpokenSentences ?? 4} sentences.\n` +
        `Old answer (${clock ?? 'earlier'}):\n${text}\n\nNewer reports:\n${look.newer.join('\n\n')}`
      );
    }
    const age = at ? this.now() - at : 0;
    if (readBefore || age > STALE_ANSWER_MS) {
      const minutes = Math.max(1, Math.round(age / 60_000));
      return (
        `This answer is from ${clock ?? 'earlier'}${at ? ` (${minutes} min ago)` : ''} and was already given. Anything in it about ` +
        `work still running may be out of date: say when it is from, and check with ${STATUS_TOOL_NAME} before saying it is still running.\n` +
        this.frameAnswer(text)
      );
    }
    return this.frameAnswer(text);
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
      const own: string[] = [];
      for (const [id, c] of this.openConsults) {
        if (c.fetched) continue;
        const look = await this.deps.consultResult?.(id).catch(() => null);
        if (look?.state === 'done' || look?.state === 'failed') {
          // Reading it here counts as fetched: it is answered on this line.
          c.fetched = true;
          own.push(`your request "${c.question.slice(0, 80)}" is finished — answer: ${look.state === 'done' ? (look.text ?? '') : `could not: ${look.error ?? 'unknown error'}`}`);
        } else if (look) {
          own.push(`your request "${c.question.slice(0, 80)}" is still ${look.position ? `waiting (position ${look.position})` : 'running'}`);
        }
      }
      // The ledger's view of this session's voice consults, this call's
      // and earlier calls': the open consults above only know this
      // call, and an answered consult whose sub still runs (or has
      // finished since) is not "open" at all (the 2026-11-06 report:
      // the next call said "still running" about finished work).
      const ledger = (await this.deps.sessionVoiceWork?.(this.target.agent, this.target.session).catch(() => [])) ?? [];
      for (const w of ledger) {
        const mine = this.openConsults.get(w.consultId);
        if (w.state === 'running' && mine && !mine.fetched) continue; // said above
        const where = mine && !mine.earlier ? '' : ' (asked in an earlier call)';
        const q = `"${w.question.slice(0, 80)}"${where}`;
        if (w.state === 'running') own.push(`${q} is still running`);
        else if (w.state === 'working_on') own.push(`${q} was answered, but the work it started is still running`);
        else own.push(`the work started for ${q} has FINISHED — what the agent reported: ${w.text ?? ''}`);
      }
      const base = status.busy
        ? `still working on something you started ${minutes} minute(s) ago${status.queued ? `, ${status.queued} waiting behind it` : ''} — say so, and offer to look again in a moment`
        : 'nothing running right now';
      await session.sendToolResult(callId, own.length > 0 ? `${base}; ${own.join('; ')}` : base);
      return;
    }
    if (name === RESULT_TOOL_NAME) {
      const parsed = parseResultArgs(rawArgs);
      if (!parsed.ok) {
        await session.sendToolResult(callId, parsed.error);
        return;
      }
      const open = this.openConsults.get(parsed.consultId);
      const look = await this.deps.consultResult?.(parsed.consultId).catch(() => null);
      if (!look) {
        await session.sendToolResult(callId, 'nothing was handed over under that id — say so');
        return;
      }
      if (look.state === 'pending') {
        await session.sendToolResult(callId, `still working on it${look.position ? ` (position ${look.position} in the queue)` : ''} — say so, do not invent an answer`);
        return;
      }
      const readBefore = open?.fetched === true;
      if (open) open.fetched = true;
      this.log({ msg: 'voice.consult_fetched', consultId: parsed.consultId, state: look.state, ...(readBefore ? { again: true } : {}), ...(look.newer?.length ? { newer: look.newer.length } : {}) });
      await session.sendToolResult(
        callId,
        look.state === 'done'
          ? (look.text?.trim() ? this.frameStored(look.text.trim(), look, readBefore) : 'no answer this time — say so, do not invent one')
          : `the agent could not answer: ${look.error ?? 'unknown error'}`,
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
      const request = parsed.args;
      // Already tried and already impossible: answer from memory rather
      // than tearing the line down again.
      const known = this.unreachable.get(`${request.agent}/${request.session ?? 'main'}`);
      if (known) {
        await session.sendToolResult(callId, known);
        return;
      }
      // Asking to go where you already are is a model slip, not a wish.
      // Caught here because it is the one case decidable on the spot,
      // and tearing a session down for it would be an audible pause for
      // nothing.
      const staying =
        request.agent === this.target.agent &&
        (request.session === undefined
          ? this.target.slug === 'main'
          : request.session === this.target.slug);
      if (staying) {
        await session.sendToolResult(
          callId,
          'that is the conversation you are already in — say so, and ask which session they mean',
        );
        return;
      }
      // Answer BEFORE the session goes away: the tool result has to
      // reach the model that asked, not its successor.
      await session.sendToolResult(
        callId,
        request.agent === this.target.agent
          ? `moving you into the "${request.session ?? 'main'}" session now`
          : `putting them through to ${request.agent} now`,
      );
      this.pendingSwitch = request;
      this.log({ msg: 'voice.switch_requested', to: request.agent, session: request.session ?? 'main' });
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
    const turn = renderConsultTurn(parsed.args, 'the user', this.recentTranscript());
    this.log({ msg: 'voice.consult_start', question: parsed.args.question.slice(0, 160) });
    this.recordLine('event', `asked ${this.target.agent}: ${parsed.args.question}`);
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
        text: turn.text,
        prefix: turn.prefix,
        callId: this.id,
      });
      if (result.state === 'handed_over' && result.consultId) {
        const id = result.consultId;
        this.openConsults.set(id, { question: parsed.args.question, startedAt, agent: this.target.agent, session: this.target.session, fetched: false });
        this.log({ msg: 'voice.consult_handed_over', consultId: id, position: result.position ?? 0, ms: this.now() - startedAt });
        this.recordLine('event', `${this.target.agent} is still working on it; the answer follows`);
        if (this.state !== 'closed' && session === this.session) {
          await session.sendToolResult(
            callId,
            `handed over (consult ${id}${result.position ? `, position ${result.position} in the queue` : ''}). ` +
              'Tell the user you passed it on and keep talking. The answer is read out to them when it ' +
              `arrives; if they ask whether it is done, ${RESULT_TOOL_NAME} fetches it.`,
          );
        }
        const early = this.earlyDeliveries.get(id);
        if (early) {
          this.earlyDeliveries.delete(id);
          void this.deliver(early);
        }
        return;
      }
      // Answered at once, but it may have started work (a sub) whose
      // follow-up comes later: remember the question, already read.
      if (result.consultId && !this.openConsults.has(result.consultId)) {
        this.openConsults.set(result.consultId, { question: parsed.args.question, startedAt, agent: this.target.agent, session: this.target.session, fetched: true });
      }
      const answer = result.text.trim();
      this.log({
        msg: 'voice.consult_done',
        ms: this.now() - startedAt,
        outcome: result.outcome ?? null,
        pending: result.pending ?? false,
        chars: answer.length,
      });
      // The session may be gone or replaced by the time a long answer
      // lands: never write into a closed line or the successor's.
      if (this.state === 'closed' || session !== this.session) {
        this.log({ msg: 'voice.consult_answer_after_session', ms: this.now() - startedAt });
        return;
      }
      await session.sendToolResult(
        callId,
        answer.length > 0
          ? this.frameAnswer(answer)
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

  /**
   * A handed-over consult finished. Read it out — once, on this line,
   * for the agent that was asked, at a pause in the conversation.
   * Anything else stays in the agent's chat where it landed.
   */
  async deliver(res: ConsultDelivery): Promise<void> {
    const open = this.openConsults.get(res.consultId);
    if (res.followUp) {
      if (!open) {
        this.log({ msg: 'voice.consult_delivery_skipped', consultId: res.consultId, reason: 'follow-up for a consult this call does not know' });
        return;
      }
      if (this.state === 'closed' || !this.session) {
        this.park(open, res, 'call closed');
        return;
      }
      if (open.agent !== this.target.agent) {
        this.park(open, res, 'call moved to another agent');
        return;
      }
      if (!(await this.announce(open.question, res, open.earlier))) this.park(open, res, 'call ended before it was read out');
      return;
    }
    if (!open) {
      // Finished before the hand-over was recorded: keep it for a moment.
      this.earlyDeliveries.set(res.consultId, res);
      setTimeout(() => this.earlyDeliveries.delete(res.consultId), 30_000).unref?.();
      return;
    }
    if (open.fetched) return;
    if (this.state === 'closed' || !this.session) {
      this.park(open, res, 'call closed');
      return;
    }
    if (open.agent !== this.target.agent) {
      this.park(open, res, 'call moved to another agent');
      return;
    }
    open.fetched = true;
    await this.deps.markConsultFetched?.(res.consultId).catch(() => {});
    if (!(await this.announce(open.question, res, open.earlier))) {
      // Closed while waiting for a pause: kept for the next call, not lost
      // (a carried answer was already taken from the manager).
      open.fetched = false;
      this.park(open, res, 'call ended before it was read out');
    }
  }

  /** Not readable on this line: kept for the next call on the agent and
   *  session the consult was asked in, or dropped when nobody keeps it. */
  private park(open: { question: string; agent: string; session: string }, res: ConsultDelivery, reason: string): void {
    if (this.deps.onUndelivered) {
      this.deps.onUndelivered(open.agent, open.session, { res, question: open.question });
      this.log({ msg: 'voice.consult_delivery_parked', consultId: res.consultId, reason });
      return;
    }
    this.log({ msg: 'voice.consult_delivery_skipped', consultId: res.consultId, reason });
  }

  /** Wait for a pause (the model not speaking, the caller quiet for a
   *  moment), then have the model read the answer. Never a fixed
   *  sentence: the instruction is English, names the call's language,
   *  and the wording is the model's (the operator, 2026-09-13). */
  /** True when it was handed to the model to speak. */
  private async announce(question: string, res: ConsultDelivery, earlier = false): Promise<boolean> {
    const deadline = this.now() + ANNOUNCE_MAX_WAIT_MS;
    while (this.now() < deadline) {
      if (this.state === 'closed') return false;
      const quiet = this.state === 'listening' && this.now() - this.lastHeardAt >= ANNOUNCE_PAUSE_MS;
      if (quiet) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.state === 'closed' || !this.session) return false;
    const body = res.state === 'done'
      ? (res.text?.trim() || 'the agent had no answer')
      : `the agent could not answer: ${res.error ?? 'unknown error'}`;
    const asked = earlier ? 'the question the user asked in an earlier call' : 'the question the user asked earlier';
    const instruction = res.followUp
      ? `The agent has a follow-up on ${asked} about "${question.slice(0, 120)}": ` +
        'work it had started for that question has now finished. ' +
        `Start by saying, in ${this.cfg.language}, that this is a follow-up to that earlier question, ` +
        'then give it as it is. Do not add anything else.\n' +
        body
      : `Read the user the answer to ${asked} about "${question.slice(0, 120)}". ` +
        `Start by saying, in ${this.cfg.language}, that this is the answer to that earlier question${earlier ? ' from the earlier call' : ''}, ` +
        'then give the answer as it is. Do not add anything else.\n' +
        body;
    try {
      // deliver: the model may be mid-sentence (its own "still working"
      // after a status check); the announcement is kept for the pause
      // instead of dropped like a filler (2026-09-13, ada counting to
      // forty went silent while the log said announced).
      await this.session.speak?.(instruction, { deliver: true });
      this.log({ msg: 'voice.consult_announced', consultId: res.consultId, state: res.state, chars: body.length, ...(res.followUp ? { followUp: true } : {}) });
      this.recordLine('event', `${this.target.agent} answered (${res.state})`);
      return true;
    } catch (err) {
      this.log({ msg: 'voice.consult_announce_failed', consultId: res.consultId, err: (err as Error).message });
      return false;
    }
  }

  /**
   * One line of the conversation, held for the length of the call.
   *
   * Nothing here reaches disk. Its one job is to give the agent the
   * couple of sentences around a question: asked "what time is it", the
   * agent otherwise has no idea what the caller was talking about.
   * OpenClaw hands its consulting agent the last twelve lines for the
   * same reason.
   */
  private remember(role: 'caller' | 'voice', text: string): void {
    if (role === 'caller') this.spokenTurns += 1;
    this.transcript.push({ role, text });
    if (this.transcript.length > TRANSCRIPT_MEMORY) {
      this.transcript.splice(0, this.transcript.length - TRANSCRIPT_MEMORY);
    }
  }

  /** The tail of the conversation that travels with a question. Short
   *  on purpose: it is written into the agent's session, so it is part
   *  of the record and part of every later context. */
  private recentTranscript(): Array<{ role: 'caller' | 'voice'; text: string }> {
    return this.transcript.slice(-CONSULT_TRANSCRIPT_LINES);
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
      await this.writeRecord(this.target, reason);
    }
  }

  private recordLine(who: VoiceCallRecordLine['who'], text: string): void {
    this.record.push({ at: this.now() - this.recordStartedAt, who, text });
  }

  /**
   * The call as one folded record in the session it talked to (a handover
   * writes the part before it into the session it left). An engine_meta
   * row: the chat shows it folded; the agent's context, memory and dreams
   * read only user and assistant messages, so it never reaches them.
   */
  private async writeRecord(target: VoiceCallTarget, reason: string, voice: string = this.cfg.voice): Promise<void> {
    // an answer still being spoken when the call ended or moved: what of
    // it was said so far
    if (this.partialAnswer.trim()) this.recordLine('voice', `${this.partialAnswer.trim()}${CUT_MARK}`);
    const lines = this.record;
    this.record = [];
    this.partialAnswer = '';
    this.cutAnswer = '';
    this.lastAnswerLine = null;
    const startedAt = this.recordStartedAt;
    // a call that goes on (a handover) starts the next record's clock here
    this.recordStartedAt = this.now();
    if (this.cfg.keepTranscript === false || lines.length === 0) return;
    const said = lines.filter((l) => l.who !== 'event').length;
    try {
      await this.deps.appendEvent(target.agent, target.session, {
        kind: 'engine_meta',
        ts: this.now(),
        engine: 'voice',
        itemType: 'voice_call_record',
        payload: {
          text: `call · ${callLength(this.now() - startedAt)} · ${said} ${said === 1 ? 'line' : 'lines'} · ${reason}`,
          startedAt,
          endedAt: this.now(),
          reason,
          voice,
          lines,
        },
      } as NormalizedEvent);
    } catch (err) {
      this.log({ msg: 'voice.call_record_failed', err: (err as Error).message });
    }
  }
}
