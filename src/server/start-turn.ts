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
import { readAcceptance, renderAcceptanceTable } from './builder-acceptance.ts';
import { readBuilderState } from './builder-session.ts';
import { MAX_OPEN_TASK_NUDGES, checkBuilderTurnEnd, describeTurnEnd, followUpNotice, rejectionsToldPatch, turnWorked } from './builder-turn-end.ts';
import { loadPersona } from '../persona/loader.ts';
import { isToolAllowed } from '../tools/gating.ts';
import { collectBuilderFacts } from './builder-facts.ts';
import { workdirFromMeta } from './session-workdir.ts';

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

/** Broadcast into a session's SSE subscribers from outside a route —
 *  the server-wide publisher wired at boot; nothing before that. */
export async function broadcastToSession(agent: string, session: string, event: SseEvent): Promise<void> {
  await injected?.publish(agent, session, event);
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
      // 2026-09-13 only a typed turn sent it (the operator: the badge lagged
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
    const abort = registerChatAbort(agent, session, turnId);
    const startedAt = Date.now();
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
      // A builder on a CLI engine that ended while it still owes its
      // order something gets follow-up turns here, before the asker
      // hears of the result (builder-turn-end.ts). They run under this
      // turn's stop signal, so Stop — also one naming this turn id —
      // reaches them, and between them.
      const held = await holdBuilderToOrder({ agent, session, first: result, deps, runTurn, publishSse, signal: abort.signal, startedAt }).catch((err: unknown) => {
        // The order's turn ended well; a failure in the check after it
        // does not make it a failed order.
        logger.warn({ msg: 'builder.turn_end_check_failed', agent, session, turnId, err: (err as Error).message });
        return { result, stopped: false };
      });
      if (held.stopped) {
        const stopped: ChatTurnResult = { ...held.result, outcome: 'failed', error: STOPPED_BY_USER };
        if (args.workId) finishWork(args.workId, stopped);
        return stopped;
      }
      if (args.workId) finishWork(args.workId, held.result);
      return held.result;
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

/**
 * The turn-end check for builders on claude-cli, codex-cli and grok-cli
 * (builder-turn-end.ts). Those engines run their own tool loop, so a
 * builder that ends while it still owes the order something cannot be
 * asked inside the turn the way openai-compatible asks it. It gets a
 * follow-up turn instead — a system message naming what is open — at
 * most MAX_OPEN_TASK_NUDGES times, and not again after a follow-up in
 * which it called no tool (that is its considered answer). Runs under
 * the session lock the first turn held, so nothing queues in between,
 * and the asker gets the last turn's answer: the notice asks for the
 * complete report again.
 */
async function holdBuilderToOrder(a: {
  agent: string;
  session: string;
  first: ChatTurnResult;
  deps: ChatTurnResolveDeps;
  runTurn: typeof runChatTurnReal;
  publishSse: ((event: SseEvent) => Promise<void>) | undefined;
  /** The order's turn's stop signal, registered for the whole order. */
  signal: AbortSignal;
  /** When the order's turn started (the facts block counts from here). */
  startedAt: number;
}): Promise<{ result: ChatTurnResult; stopped: boolean }> {
  const { agent, session, deps, signal } = a;
  let result = a.first;
  if (result.agentKind !== 'builder') return { result, stopped: false };
  const used = new Set(result.tools_used ?? []);
  if (result.outcome === 'failed') return { result: await withBuilderFacts(result, used, a), stopped: false };
  const files = new Set(result.files_written ?? []);
  let toolCalls = result.tool_calls;
  const merged = (): ChatTurnResult => ({
    ...result,
    tool_calls: toolCalls,
    ...(used.size > 0 ? { tools_used: [...used] } : {}),
    ...(files.size > 0 ? { files_written: [...files] } : {}),
  });
  // openai-compatible asked inside its turn already; asking again here
  // would hold the builder twice.
  if (result.engine !== 'openai-compatible') {
    // A builder whose agent.yaml denies acceptance_write cannot be asked
    // to write the list.
    const persona = await loadPersona(agent).catch(() => null);
    const acceptanceTool = !persona || isToolAllowed('acceptance_write', 'builder', persona.toolGating);
    for (let attempt = 1; attempt <= MAX_OPEN_TASK_NUDGES; attempt++) {
      if (signal.aborted) return { result: merged(), stopped: true };
      const meta = (await deps.sessionMetaStore.get(agent, session)) as Record<string, unknown>;
      if (readBuilderState(meta)?.phase !== 'build') break;
      const check = checkBuilderTurnEnd({
        meta,
        worked: turnWorked(used),
        todoWritten: used.has('todo_write'),
        acceptanceWritten: used.has('acceptance_write'),
        acceptanceTool,
      });
      if (!check) break;
      const told = rejectionsToldPatch(check, meta);
      if (told) await deps.sessionMetaStore.update(agent, session, (m) => ({ ...m, ...told }));
      const text = followUpNotice(check);
      const origin: TurnOrigin = { kind: 'wake', about: 'system', ref: `turn-end-${randomUUID()}`, cause: 'open items' };
      const turnId = randomUUID();
      logger.info({ msg: 'builder.turn_end_follow_up', agent, session, turnId, engine: result.engine, open: check.open.length, acceptanceOpen: check.accOpen.length, acceptanceMissing: check.accMissing, attempt, what: describeTurnEnd(check) });
      let next: ChatTurnResult;
      try {
        next = await a.runTurn({
          agent,
          session,
          text,
          turnId,
          origin,
          ...originToLegacy(origin),
          signal,
          ...(a.publishSse ? { publishSse: a.publishSse } : {}),
          deps,
        });
      } finally {
        unmarkSteerable(agent, session, turnId);
        releaseWorkdir(turnId);
      }
      for (const t of next.tools_used ?? []) used.add(t);
      for (const f of next.files_written ?? []) files.add(f);
      toolCalls += next.tool_calls;
      if (signal.aborted) {
        result = { ...next, finalText: next.finalText.trim() ? next.finalText : result.finalText };
        return { result: merged(), stopped: true };
      }
      // A follow-up that failed (a rate limit, an engine error) does not
      // undo the order's turn: its report and outcome stand.
      if (next.outcome === 'failed') {
        logger.warn({ msg: 'builder.turn_end_follow_up_failed', agent, session, turnId, err: next.error ?? null });
        break;
      }
      // An empty answer keeps the report the builder already gave.
      result = { ...next, finalText: next.finalText.trim() ? next.finalText : result.finalText };
      if (next.tool_calls === 0) break;
    }
  }
  // The answer ends with the acceptance list as the session holds it —
  // the orderer reads the answer, not the panel — unless the turn only
  // answered a question. openai-compatible has added it to its own
  // answer already.
  if (result.engine !== 'openai-compatible') {
    const acc = readAcceptance((await deps.sessionMetaStore.get(agent, session)) as Record<string, unknown>);
    if (acc.items.length > 0 && ((acc.required && turnWorked(used)) || used.has('acceptance_write')) && !result.finalText.includes('## Acceptance list (from the session)')) {
      result = { ...result, finalText: `${result.finalText}\n\n## Acceptance list (from the session)\n\n${renderAcceptanceTable(acc.items)}` };
    }
  }
  // Then what somora itself sees in the folder (builder-facts.ts): not
  // committed, not in the main checkout, timed out, still running — for
  // a turn that used tools. A turn that wrote nothing through the file
  // tools (an answer, or edits made with exec) gets the block only when
  // something is open.
  result = await withBuilderFacts(result, used, a);
  return { result: merged(), stopped: false };
}

/** Appends the facts block (builder-facts.ts). Once per order, after
 *  everything else; also under a failed order's error, where work left
 *  uncommitted or a job still running matters most. Never trusts a
 *  heading the builder wrote itself. */
async function withBuilderFacts(
  result: ChatTurnResult,
  used: ReadonlySet<string>,
  a: { agent: string; session: string; deps: ChatTurnResolveDeps; startedAt: number; signal: AbortSignal },
): Promise<ChatTurnResult> {
  const { agent, session, deps } = a;
  if (used.size > 0 && !a.signal.aborted) {
    const meta = (await deps.sessionMetaStore.get(agent, session)) as Record<string, unknown>;
    const persona = await loadPersona(agent).catch(() => null);
    if (persona) {
      const workdir = workdirFromMeta(meta, persona, deps.config).path;
      const facts = await collectBuilderFacts({ agent, session, workdir, since: a.startedAt, quietWhenClean: !turnWorked(used), signal: a.signal }).catch((err: unknown) => {
        logger.warn({ msg: 'builder.facts_failed', agent, session, err: (err as Error).message });
        return null;
      });
      if (facts) {
        logger.info({ msg: 'builder.facts_added', agent, session, outcome: result.outcome, lines: facts.split('\n').length - 2 });
        return { ...result, finalText: `${result.finalText}\n\n${facts}` };
      }
    }
  }
  return result;
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
