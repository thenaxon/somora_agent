// The one way a turn starts.
//
// Fourteen places in somora start an agent turn: a person typing, a
// person dictating, agent_ask, four flavours of spawn_subagent, the
// sentinel timer, the tmux watcher, a browser hand-back, a voice
// consult, and three wake-ups (late A2A answer, finished sub, rendered
// video). Until 2026-09-13 each of them took the session lock, minted
// or skipped a turn id, registered or skipped an abort controller,
// chose its own SSE wiring and set its own subset of the origin
// fields — and only four of the fourteen could be stopped from the
// Stop button (private/turn-triggers-birdseye.md, L1).
//
// startTurn does the same six things for every caller, in the same
// order:
//   1. take the session lock (FIFO, label from the origin, turn id
//      always set so /health and the tmux busy-check see the turn),
//   2. run the caller's pre-flight once the lock is held (a tmux wake
//      re-checks that the session still exists),
//   3. register the abort controller — POST /chat/abort reaches EVERY
//      turn from here on,
//   4. run the turn with the origin's legacy fields derived once,
//   5. mark a stopped turn as stopped, in words the asker understands,
//   6. release everything, in reverse.
//
// What it does NOT do: decide whether a turn should start at all
// (cooldowns, caps, dedup), pick the target session, or write the
// text. That stays with the trigger — it is the part that should
// differ between a sentinel fire and a browser hand-back.

import { randomUUID } from 'node:crypto';

import type { SseEvent } from '../types/events.ts';
import { registerChatAbort } from './chat-aborts.ts';
import { logger } from './logger.ts';
import { runChatTurn as runChatTurnReal, type RunChatTurnArgs } from './run-turn.ts';
import type { ChatTurnResolveDeps, ChatTurnResult } from './run-turn-types.ts';
import { acquireSessionLock, DequeuedError } from './session-queue.ts';
import { originCallId, originKind, originLabel, originToLegacy, type TurnOrigin } from './turn-origin-kind.ts';
import { failWork, finishWork, markRunning, openWork } from './work-ledger.ts';
import { drainSteer, unmarkSteerable } from './steer-inbox.ts';
import { releaseWorkdir } from './builder-busy.ts';
import { dropQuestions } from './builder-questions.ts';
import { composeTurnPrefix } from './turn-framing.ts';

export interface StartTurnDeps {
  chatTurnDeps: ChatTurnResolveDeps;
  /** Broadcast into the session's SSE subscribers. */
  publish: (agent: string, session: string, event: SseEvent) => Promise<void> | void;
  /** Test seam: the turn runner. Defaults to runChatTurn. */
  runTurn?: (args: RunChatTurnArgs) => Promise<ChatTurnResult>;
}

let injected: StartTurnDeps | null = null;

/** Server boot wires this once. Callers that hold their own copy of
 *  the deps (spawn tools, sentinel, tmux, video) may still pass `deps`
 *  explicitly; the publisher always comes from here. */
export function configureStartTurn(deps: StartTurnDeps): void {
  injected = deps;
}

export function isStartTurnConfigured(): boolean {
  return injected !== null;
}

/** What a stopped turn reports to whoever asked for it. The asker
 *  (agent_ask, subagent_result, sentinel history) sees this as the
 *  error and must not read it as a model failure worth a retry. */
export const STOPPED_BY_USER = 'stopped by the user';

export interface StartTurnArgs {
  agent: string;
  /** Canonical session id — resolve slugs BEFORE calling (the policies
   *  for a missing session differ per trigger and stay with it). */
  session: string;
  text: string;
  origin: TurnOrigin;
  /** Pre-minted when the caller logged it already (HTTP acceptance,
   *  spawn task id, sentinel task id); minted here otherwise. */
  turnId?: string;
  /** The work-ledger item this turn runs for (Phase 2). startTurn marks
   *  it running once the lock is held and finishes it with the result
   *  (or the failure), so the caller only opens it. */
  workId?: string;
  /** Abort the WAIT for the lock — never the running turn. A voice
   *  consult uses it as its patience; the caller gets an AbortError. */
  lockSignal?: AbortSignal;
  /** Fires synchronously when the lock is busy and this turn queued. */
  onQueued?: (ahead: number) => void;
  /** Runs once the lock is held, before anything is written. Return
   *  false to skip the turn: the lock is released, nothing persisted,
   *  startTurn resolves null. */
  beforeRun?: () => Promise<boolean> | boolean;
  /** SSE: default — broadcast into the session. `false` — silent.
   *  A function — the caller's sink, which also gets every event. */
  publish?: boolean | ((event: SseEvent) => Promise<void> | void);
  deps?: ChatTurnResolveDeps;
  // Passed through to runChatTurn unchanged.
  turnPrefix?: string;
  attachments?: RunChatTurnArgs['attachments'];
  modelOverride?: string;
  agentLoopOverride?: RunChatTurnArgs['agentLoopOverride'];
  attachMediaIds?: string[];
  inputModality?: 'text' | 'voice';
  sttProvider?: string;
  autoPlayRequested?: boolean;
}

export async function startTurn(args: StartTurnArgs): Promise<ChatTurnResult | null> {
  const deps = args.deps ?? injected?.chatTurnDeps;
  if (!deps) throw new Error('startTurn: not configured (configureStartTurn did not run)');
  const runTurn = injected?.runTurn ?? runChatTurnReal;
  const { agent, session, text, origin } = args;
  const turnId = args.turnId ?? randomUUID();
  const legacy = originToLegacy(origin);
  const kind = originKind(origin);
  const turnPrefix = composeTurnPrefix(origin, args.turnPrefix);

  logger.info({ msg: 'turn.dispatch', turnId, agent, session, origin: kind, textLen: text.length });
  const publishSse = resolvePublish(agent, session, args.publish);

  let release: () => void;
  try {
    release = await acquireSessionLock(agent, session, {
      priority: originLabel(origin),
      turnId,
      ...(originCallId(origin) ? { callId: originCallId(origin) } : {}),
      ...(args.workId ? { workId: args.workId } : {}),
      ...(args.lockSignal ? { signal: args.lockSignal } : {}),
      // Every waiter announces itself, whoever queued it: the queue
      // badge in the clients refreshes on this event, and until
      // 2026-09-13 only a typed turn sent it (Rene: the badge lagged
      // behind an agent's question).
      onQueued: (ahead) => {
        if (publishSse) {
          void publishSse({ event: 'turn_queued', data: { turnId, ahead, ...(args.workId ? { workId: args.workId } : {}), kind: origin.kind } });
        }
        args.onQueued?.(ahead);
      },
    });
  } catch (err) {
    // Taken back before it started: the ledger already marked the item.
    // Anything else (a voice patience that ran out, a lock failure) is
    // the item's failure.
    if (args.workId && !(err instanceof DequeuedError)) failWork(args.workId, (err as Error).message);
    throw err;
  }
  try {
    if (args.workId) markRunning(args.workId, turnId);
    if (args.beforeRun && !(await args.beforeRun())) {
      logger.info({ msg: 'turn.skipped_before_run', turnId, agent, session, origin: kind });
      if (args.workId) failWork(args.workId, 'skipped before it started');
      return null;
    }
    // Registered only once the lock is held: the lock guarantees one
    // turn per session, so the registry's "abort a still-registered
    // prior controller" defence never fires on a live turn.
    const abort = registerChatAbort(agent, session);
    try {
      const result = await runTurn({
        agent,
        session,
        text,
        turnId,
        origin,
        ...legacy,
        signal: abort.signal,
        ...(publishSse ? { publishSse } : {}),
        // Provenance first (the A2A header), then the caller's frame —
        // beside the text, never in it (turn-framing.ts).
        ...(turnPrefix ? { turnPrefix } : {}),
        ...(args.attachments && args.attachments.length > 0 ? { attachments: args.attachments } : {}),
        ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
        ...(args.agentLoopOverride ? { agentLoopOverride: args.agentLoopOverride } : {}),
        ...(args.attachMediaIds && args.attachMediaIds.length > 0 ? { attachMediaIds: args.attachMediaIds } : {}),
        ...(args.inputModality ? { inputModality: args.inputModality } : {}),
        ...(args.sttProvider ? { sttProvider: args.sttProvider } : {}),
        ...(args.autoPlayRequested ? { autoPlayRequested: true } : {}),
        deps,
      });
      if (abort.signal.aborted) {
        // The signal is the authority, not the engine's verdict: the
        // openai-compatible adapter ends a stopped turn "cleanly" with
        // outcome completed and a marker text, claude-cli/codex-cli
        // throw, and the asker must read the same thing in every case.
        // "The operation was aborted" would look like a model failure
        // and invite a blind retry; the text the engine produced stays
        // on the result and in the session.
        logger.info({ msg: 'turn.stopped', turnId, agent, session, origin: kind, engineOutcome: result.outcome, engineError: result.error ?? null });
        const stopped: ChatTurnResult = { ...result, outcome: 'failed', error: STOPPED_BY_USER };
        if (args.workId) finishWork(args.workId, stopped);
        return stopped;
      }
      if (args.workId) finishWork(args.workId, result);
      return result;
    } catch (err) {
      if (args.workId) failWork(args.workId, (err as Error).message);
      throw err;
    } finally {
      abort.release();
    }
  } finally {
    // Steer messages that arrived too late for the engine to read (the
    // turn was already finishing) are not lost: they become ordinary
    // turns, queued in the order they came, once the lock is free.
    unmarkSteerable(agent, session, turnId);
    // A question the builder asked and nobody answered: nobody waits now.
    dropQuestions(agent, session);
    // A builder's folder is free again.
    releaseWorkdir(turnId);
    const leftover = drainSteer(agent, session);
    release();
    for (const m of leftover) {
      const lateTurnId = randomUUID();
      logger.info({ msg: 'steer.late_as_turn', agent, session, steerId: m.id, turnId: lateTurnId });
      openWork({
        id: lateTurnId,
        origin: m.origin,
        target: { agent, session },
        requester: m.origin.kind === 'human' ? { human: true } : undefined,
        text: m.text,
        wake: 'never',
      });
      void startTurn({ agent, session, text: m.text, origin: m.origin, turnId: lateTurnId, workId: lateTurnId }).catch(
        (err: unknown) => {
          if (err instanceof DequeuedError) return;
          logger.error({ msg: 'steer.late_turn_failed', agent, session, err: (err as Error).message });
        },
      );
    }
  }
}

function resolvePublish(
  agent: string,
  session: string,
  publish: StartTurnArgs['publish'],
): ((event: SseEvent) => Promise<void>) | undefined {
  if (publish === false) return undefined;
  const broadcast = injected?.publish;
  if (typeof publish === 'function') {
    return async (event) => {
      await publish(event);
      if (broadcast) await broadcast(agent, session, event);
    };
  }
  if (!broadcast) return undefined;
  return (event) => Promise.resolve(broadcast(agent, session, event));
}
