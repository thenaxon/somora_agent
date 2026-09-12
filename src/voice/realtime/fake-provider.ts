// A provider that speaks the contract and nothing else.
//
// Everything in a voice call that can go wrong — a cut-off tool call, a
// consult that throws, a hang-up mid-answer, a model that answers
// without asking — is a sequence of control events. Scripting them here
// makes the call state machine testable without a microphone, without a
// network and without a single billed second.
//
// It is also the honesty check on the contract itself: whatever this
// file cannot express, a real adapter will have to smuggle past the
// interface.

import { randomUUID } from 'node:crypto';
import type {
  RealtimeCapabilities,
  RealtimeClientHandshake,
  RealtimeEvent,
  RealtimeProvider,
  RealtimeSession,
  RealtimeSessionRequest,
} from './types.ts';

export interface FakeScriptStep {
  /** An event the "provider" emits. */
  emit?: RealtimeEvent;
  /** Wait for somora to answer the given tool call before continuing. */
  awaitToolResult?: string;
}

export class FakeRealtimeSession implements RealtimeSession {
  readonly id = randomUUID();
  readonly toolResults: Array<{ callId: string; result: string }> = [];
  readonly instructionUpdates: string[] = [];
  closedWith: string | undefined;
  interrupts = 0;
  private resolvers = new Map<string, () => void>();

  constructor(
    readonly request: RealtimeSessionRequest,
    private readonly script: FakeScriptStep[],
  ) {}

  async *events(): AsyncGenerator<RealtimeEvent> {
    for (const step of this.script) {
      if (step.awaitToolResult) {
        await this.waitForToolResult(step.awaitToolResult);
        continue;
      }
      if (step.emit) {
        if (this.closedWith && step.emit.kind !== 'closed') continue;
        yield step.emit;
      }
    }
  }

  private waitForToolResult(callId: string): Promise<void> {
    if (this.toolResults.some((r) => r.callId === callId)) return Promise.resolve();
    return new Promise((resolve) => this.resolvers.set(callId, resolve));
  }

  async sendToolResult(callId: string, result: string): Promise<void> {
    this.toolResults.push({ callId, result });
    this.resolvers.get(callId)?.();
    this.resolvers.delete(callId);
  }

  async updateInstructions(instructions: string): Promise<void> {
    this.instructionUpdates.push(instructions);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(reason: string): Promise<void> {
    this.closedWith = reason;
    for (const resolve of this.resolvers.values()) resolve();
    this.resolvers.clear();
  }
}

export class FakeRealtimeProvider implements RealtimeProvider {
  readonly name = 'fake';
  lastSession: FakeRealtimeSession | undefined;
  /** Every session this provider opened, in order. A call outlives its
   *  provider session — a handover and a recovery each open a new one —
   *  so "what happened" is a sequence, not a last value. */
  readonly sessions: FakeRealtimeSession[] = [];

  constructor(
    private readonly script: FakeScriptStep[],
    private readonly caps: Partial<RealtimeCapabilities> = {},
    /** What the sessions AFTER the first one play. Without it they
     *  replay the same script, which is right for a handover test and
     *  wrong for one where the second session should just sit there. */
    private readonly laterScript?: FakeScriptStep[],
  ) {}

  capabilities(): RealtimeCapabilities {
    return {
      transport: 'websocket',
      serverVad: true,
      bargeIn: true,
      truncation: true,
      tools: true,
      liveInstructionUpdate: true,
      voiceFixedAfterFirstAudio: true,
      usage: false,
      ...this.caps,
    };
  }

  async open(req: RealtimeSessionRequest): Promise<RealtimeSession> {
    const script = this.sessions.length === 0 ? this.script : (this.laterScript ?? this.script);
    const session = new FakeRealtimeSession(req, script);
    this.sessions.push(session);
    this.lastSession = session;
    return session;
  }

  async handshake(): Promise<RealtimeClientHandshake> {
    return { kind: 'ephemeral_token', value: 'fake-token', expiresAt: Date.now() + 60_000 };
  }
}
